import asyncio
import threading
from pathlib import Path
from subprocess import CompletedProcess, TimeoutExpired
from types import SimpleNamespace

import httpx
import pytest
from pydantic import SecretStr

from server.api.routes import takes as routes
from server.config import Settings
from server.models.practice import LanguageIssueType, PracticeStatus
from server.models.recording import RecordingTake
from server.models.song import LanguageHint
from server.services.practice.analyzer import (
    GeminiPracticeAnalyzer,
    _validated_findings,
    _wait_for_active,
)
from server.services.practice.models import AcousticFinding, AcousticFindingBatch
from server.services.practice.service import (
    PRACTICE_ANALYSIS_VERSION,
    _build_target_evaluations,
    _has_audible_signal,
    analyze_practice_take,
    failed_practice_attempt,
)
from server.storage.practice_store import PracticeStore
from server.storage.profile_store import ProfileStore
from server.storage.take_store import TakeStore
from tests.test_song_profile_schema import make_profile


def inputs(tmp_path):
    settings = Settings(_env_file=None, data_dir=tmp_path, gemini_api_key="test-key")
    profile = make_profile().model_copy(update={"song_id": "song_" + "b" * 32})
    profile.sentences[0].language_hints = [
        LanguageHint.model_validate(
            {
                "id": "hint_1",
                "language": "en",
                "phenomenon": "consonant_elision",
                "transformations": [{"operation": "delete", "input_segments": ["t"]}],
                "start_word_index": 0,
                "end_word_index": 0,
                "start_seconds": 1,
                "end_seconds": 2,
                "source": "human_curated",
                "confidence": 1,
                "marks": [
                    {
                        "symbol": "×",
                        "start_char_index": 0,
                        "end_char_index": 0,
                        "placement": "below",
                    }
                ],
            }
        )
    ]
    take = RecordingTake(
        take_id="take_" + "a" * 32,
        session_id="alice",
        song_id=profile.song_id,
        track_slot_id="primary:range:sentence_001:sentence_001:1",
        selection_type="sentence",
        sentence_ids=["sentence_001"],
        selection_start_seconds=0,
        selection_end_seconds=8.5,
        timeline_start_seconds=0,
        save_mode="overdub_append",
        audio_url="/private",
        stored_filename="original.mp3",
        mime_type="audio/mpeg",
        size_bytes=10,
    )
    source = tmp_path / "takes" / take.take_id / take.stored_filename
    source.parent.mkdir(parents=True)
    source.write_bytes(b"ID3test-audio")
    TakeStore(tmp_path).add(take)
    ProfileStore(tmp_path).save(profile)
    return settings, take, profile, source


@pytest.mark.parametrize(
    "stderr,code,expected",
    [
        ("max_volume: -inf dB", 0, False),
        ("max_volume: -50.0 dB", 0, False),
        ("max_volume: -8.2 dB", 0, True),
        ("no audio", 0, None),
        ("max_volume: -8.2 dB", 1, None),
    ],
)
def test_signal_gate_never_bypasses_missing_or_failed_evidence(monkeypatch, stderr, code, expected):
    monkeypatch.setattr(
        "server.services.practice.service.subprocess.run",
        lambda *args, **kwargs: CompletedProcess(args[0], code, "", stderr),
    )
    if expected is None:
        with pytest.raises(RuntimeError):
            _has_audible_signal("ffmpeg", Path("test.mp3"))
    else:
        assert _has_audible_signal("ffmpeg", Path("test.mp3")) is expected


@pytest.mark.parametrize("error", [TimeoutExpired("ffmpeg", 30), FileNotFoundError("private path")])
def test_probe_errors_are_failed_attempts_not_missing_jobs(monkeypatch, tmp_path, error):
    settings, take, profile, source = inputs(tmp_path)

    def probe(*args):
        raise error

    monkeypatch.setattr("server.services.practice.service._has_audible_signal", probe)
    attempt = asyncio.run(analyze_practice_take(settings, take, profile, source))
    assert attempt.status == PracticeStatus.failed
    assert attempt.insufficient_reason == "分析服务暂时不可用，请稍后重试。"
    assert PracticeStore(tmp_path).memory(take.session_id).reliable_attempts == 0


@pytest.mark.parametrize("key", [None, ""])
def test_unconfigured_model_is_service_failure(monkeypatch, tmp_path, key):
    settings, take, profile, source = inputs(tmp_path)
    settings.gemini_api_key = SecretStr(key) if key is not None else None
    attempt = asyncio.run(analyze_practice_take(settings, take, profile, source))
    assert attempt.status == PracticeStatus.failed
    assert attempt.analysis_version == PRACTICE_ANALYSIS_VERSION


def test_signal_probe_does_not_run_on_the_event_loop(monkeypatch, tmp_path):
    settings, take, profile, source = inputs(tmp_path)
    loop_thread = threading.get_ident()
    probe_threads = []

    def probe(*args):
        probe_threads.append(threading.get_ident())
        return False

    monkeypatch.setattr("server.services.practice.service._has_audible_signal", probe)
    attempt = asyncio.run(analyze_practice_take(settings, take, profile, source))
    assert probe_threads and probe_threads[0] != loop_thread
    assert attempt.status == PracticeStatus.insufficient_data


def test_secondary_usable_but_uncertain_response_exhausts_finite_retries(monkeypatch):
    analyzer = GeminiPracticeAnalyzer("test-key", "test-model")
    calls = []

    def response(*args, use_reference):
        calls.append(use_reference)
        return AcousticFindingBatch(
            recording_usable=True,
            findings=[
                AcousticFinding(hint_id="h", result="uncertain", confidence=0.1),
            ],
        )

    monkeypatch.setattr(analyzer, "_analyze_secondary_once", response)
    monkeypatch.setattr("server.services.practice.analyzer.time.sleep", lambda _: None)
    with pytest.raises(RuntimeError, match="no conclusive"):
        analyzer._analyze_secondary_batch(Path("a.mp3"), Path("b.mp3"), [], [], 0)
    assert calls == [True, False, False]


@pytest.mark.parametrize("kind,expected_calls", [("json", 3), ("timeout", 3), ("permission", 1)])
def test_invalid_json_and_timeouts_retry_but_permission_failure_does_not(
    monkeypatch,
    kind,
    expected_calls,
):
    analyzer = GeminiPracticeAnalyzer("test-key", "test-model")
    calls = []

    def response(*args):
        calls.append(1)
        if kind == "json":
            return AcousticFindingBatch.model_validate_json("not json")
        if kind == "timeout":
            raise httpx.ReadTimeout("timed out")
        raise RuntimeError("403 permission denied")

    monkeypatch.setattr(analyzer, "_analyze_once", response)
    monkeypatch.setattr("server.services.practice.analyzer.time.sleep", lambda _: None)
    with pytest.raises((RuntimeError, ValueError, httpx.TimeoutException)):
        analyzer._analyze_primary_batch(Path("a.mp3"), [], None)
    assert len(calls) == expected_calls


@pytest.mark.parametrize("failure", ["none", "first_upload", "reference_upload", "model", "json"])
@pytest.mark.parametrize("secondary", [False, True])
def test_remote_files_and_client_close_on_every_exit(monkeypatch, failure, secondary):
    analyzer = GeminiPracticeAnalyzer("test-key", "test-model")
    uploads = []
    deleted = []
    closed = []

    def upload(**kwargs):
        if failure == "first_upload" or (failure == "reference_upload" and uploads):
            raise RuntimeError("upload failed")
        name = f"files/{len(uploads)}"
        uploads.append(name)
        return SimpleNamespace(name=name, state="ACTIVE", uri="private-uri", mime_type="audio/mpeg")

    def create(**kwargs):
        assert kwargs["store"] is False
        if failure == "model":
            raise RuntimeError("model failed")
        return SimpleNamespace(
            output_text="bad json"
            if failure == "json"
            else '{"recordingUsable":false,"findings":[]}'
        )

    client = SimpleNamespace(
        files=SimpleNamespace(upload=upload, delete=lambda **kw: deleted.append(kw["name"])),
        interactions=SimpleNamespace(create=create),
        close=lambda: closed.append(True),
    )
    monkeypatch.setattr(analyzer, "_client", lambda: client)

    def analyze():
        if secondary:
            return analyzer._analyze_secondary_once(
                Path("a.mp3"),
                Path("b.mp3"),
                [],
                [],
                use_reference=True,
            )
        return analyzer._analyze_once(Path("a.mp3"), [], Path("b.mp3"))

    if failure == "none":
        analyze()
    else:
        with pytest.raises((RuntimeError, ValueError)):
            analyze()
    assert deleted == uploads
    assert closed == [True]


def test_sdk_timeout_uses_milliseconds_and_disables_nested_retry(monkeypatch):
    from google import genai

    captured = {}

    def client(**kwargs):
        captured.update(kwargs)
        return object()

    monkeypatch.setattr(genai, "Client", client)
    GeminiPracticeAnalyzer("not-a-real-key", "test", request_timeout_seconds=12)._client()
    assert captured["http_options"] == {"timeout": 12000, "retry_options": {"attempts": 1}}


@pytest.mark.parametrize("state", ["", "INACTIVE"])
def test_nonactive_remote_file_never_reaches_inference(state):
    with pytest.raises(RuntimeError, match="invalid Gemini file state"):
        _wait_for_active(SimpleNamespace(), SimpleNamespace(state=state))


def test_duplicate_and_invented_target_judgments_cannot_create_reliable_evaluations():
    finding = AcousticFinding(hint_id="h", result="reference_matched", confidence=0.9)
    with pytest.raises(RuntimeError, match="duplicate"):
        _validated_findings([finding, finding], {"h"})
    expected = LanguageIssueType.expected_elision_realized
    assert (
        _build_target_evaluations(
            [
                finding.model_copy(update={"hint_id": "invented", "issue_type": expected}),
                finding.model_copy(update={"confidence": 0.1}),
                finding.model_copy(update={"issue_type": LanguageIssueType.target_phoneme_omitted}),
            ],
            {"h": expected},
        )
        == []
    )
    assert len(_build_target_evaluations([finding], {"h": expected})) == 1


def test_unexpected_background_error_is_persisted_without_raw_provider_details(
    monkeypatch, tmp_path
):
    settings, take, _, _ = inputs(tmp_path)
    monkeypatch.setattr(routes, "get_settings", lambda: settings)

    async def fail(*args):
        raise RuntimeError("provider secret key=example raw-json")

    monkeypatch.setattr(routes, "analyze_practice_take", fail)
    asyncio.run(routes._run_take_analysis(take.take_id))
    attempt = PracticeStore(tmp_path).get_for_take(take.take_id)
    assert attempt.status == PracticeStatus.failed
    assert "secret" not in attempt.model_dump_json()


@pytest.mark.parametrize("preserve", [False, True])
def test_late_worker_respects_full_delete_and_analyze_only_cleanup(monkeypatch, tmp_path, preserve):
    settings, take, _, _ = inputs(tmp_path)
    monkeypatch.setattr(routes, "get_settings", lambda: settings)

    async def scenario():
        entered = asyncio.Event()
        release = asyncio.Event()

        async def delayed(*args):
            entered.set()
            await release.wait()
            PracticeStore(tmp_path).save(failed_practice_attempt(settings, take, RuntimeError()))

        monkeypatch.setattr(routes, "analyze_practice_take", delayed)
        task = asyncio.create_task(routes._run_take_analysis(take.take_id))
        routes.ANALYSIS_TASKS[take.take_id] = task
        try:
            await asyncio.wait_for(entered.wait(), 1)
            request = SimpleNamespace(
                state=SimpleNamespace(session_id=take.session_id),
                app=SimpleNamespace(
                    state=SimpleNamespace(
                        mix_jobs=SimpleNamespace(invalidate_take=lambda *args: None)
                    )
                ),
            )
            await routes.delete_take(request, take.take_id, preserve_attempt=preserve)
        finally:
            release.set()
            await task
        assert take.take_id not in routes.ANALYSIS_TASKS
        assert (PracticeStore(tmp_path).get_for_take(take.take_id) is not None) == preserve

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "confidence,target,result,usable,expected",
    [
        (0.1, "hint_1", "reference_matched", True, PracticeStatus.insufficient_data),
        (0.9, "unknown", "reference_matched", True, PracticeStatus.insufficient_data),
        (0.9, "hint_1", "uncertain", True, PracticeStatus.failed),
        (0.9, "hint_1", "reference_matched", False, PracticeStatus.insufficient_data),
        (0.9, "hint_1", "reference_matched", True, PracticeStatus.analyzed),
    ],
)
def test_only_reliable_known_targets_enter_memory(
    monkeypatch,
    tmp_path,
    confidence,
    target,
    result,
    usable,
    expected,
):
    settings, take, profile, source = inputs(tmp_path)
    monkeypatch.setattr("server.services.practice.service._has_audible_signal", lambda *args: True)

    async def analyze(*args, **kwargs):
        return AcousticFindingBatch(
            recording_usable=usable,
            findings=[
                AcousticFinding(hint_id=target, result=result, confidence=confidence),
            ],
        )

    monkeypatch.setattr(GeminiPracticeAnalyzer, "analyze", analyze)
    attempt = asyncio.run(analyze_practice_take(settings, take, profile, source))
    assert attempt.status == expected
    assert PracticeStore(tmp_path).memory(take.session_id).reliable_attempts == (
        1 if expected == PracticeStatus.analyzed else 0
    )
