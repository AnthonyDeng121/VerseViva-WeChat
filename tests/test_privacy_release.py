import asyncio
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from server.config import Settings
from server.pipelines.language_coach import GeminiLanguageCoach
from server.release_audit import REVIEWS, SCOPES, audit, require_review
from server.services.practice.coach import GlmPracticeCoach
from server.services.privacy_facts import processing_facts
from server.services.provider_files import delete_provider_file
from server.services.song_access import PUBLIC_HERO_SONG_IDS
from server.storage.practice_store import PracticeStore
from server.storage.take_store import TakeStore
from tests import test_recording_takes as recording_tests
from tests.test_practice_memory import _attempt
from tests.test_recording_takes import _webm_upload


@pytest.fixture
def take_client(tmp_path, monkeypatch):
    yield from recording_tests.take_client.__wrapped__(tmp_path, monkeypatch)


def reviewed():
    return {
        "schemaVersion": 1,
        "checks": {key: {"status": "reviewed", "evidence": "test evidence",
                          "reviewedAt": "2026-10-15"} for key in REVIEWS},
        "providers": {name: {"status": "reviewed", "evidence": "test evidence",
                             "processingRegion": "test region"} for name in ("gemini", "glm")},
        "assets": [{"songId": song, "status": "authorized", "scopes": sorted(SCOPES),
                    "evidence": "test evidence", "reviewedAt": "2026-10-15"}
                   for song in sorted(PUBLIC_HERO_SONG_IDS)],
    }


def test_pending_ledger_cannot_pass_release():
    review = json.loads(Path("deploy/wechat-release-review.json").read_text(encoding="utf-8"))
    blockers = audit(review)
    assert {"asset:" + song for song in PUBLIC_HERO_SONG_IDS} <= set(blockers)
    assert "review:privacy_contract" in blockers
    assert "provider:gemini" in blockers


@pytest.mark.parametrize("key", sorted(REVIEWS))
def test_each_privacy_review_required(key):
    review = reviewed()
    review["checks"][key]["evidence"] = ""
    assert "review:" + key in audit(review)


@pytest.mark.parametrize("scope", sorted(SCOPES))
def test_each_material_scope_required(scope):
    review = reviewed()
    review["assets"][0]["scopes"].remove(scope)
    assert any(item.startswith("asset:") for item in audit(review))


def test_conditional_glm_and_duplicate_materials():
    review = reviewed()
    review["providers"].pop("glm")
    assert audit(review) == []
    assert "provider:glm" in audit(review, glm_enabled=True)
    review["assets"].append(copy.deepcopy(review["assets"][0]))
    assert "duplicate_assets" in audit(review)


@pytest.mark.parametrize("contents", ["bad json", "[]", '{"assets":null}'])
def test_invalid_review_fails_without_echoing_content(tmp_path, contents):
    path = tmp_path / "review.json"
    path.write_text(contents)
    with pytest.raises(RuntimeError):
        require_review(path)


def test_complete_record_is_not_automatic_legal_certification(tmp_path):
    path = tmp_path / "review.json"
    path.write_text(json.dumps(reviewed()))
    require_review(path, glm_enabled=True)


def test_privacy_facts_do_not_leak_config_or_claim_immediate_erasure():
    cfg = Settings(_env_file=None, gemini_api_key="private-gemini-key",
                   glm_api_key="private-glm-key", glm_base_url="https://private-host.invalid/token")
    facts = processing_facts(cfg)
    encoded = json.dumps(facts)
    assert "private-" not in encoded
    assert len(facts["providers"]) == 2
    assert facts["deletion"]["thirdPartyImmediateDeletionGuaranteed"] is False
    assert facts["isPublishedPrivacyContract"] is False
    assert facts["aiFeedback"]["generated"] is True
    cfg.glm_api_key = None
    assert len(processing_facts(cfg)["providers"]) == 1


def test_glm_receives_only_needed_coaching_facts(tmp_path, monkeypatch):
    store = PracticeStore(tmp_path)
    attempt = _attempt(1, issue_type="expected_elision_realized")
    store.save(attempt)
    captured = []

    def handler(request):
        captured.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {
            "content": '{"recommendations":[]}'}}]})

    client_type = httpx.AsyncClient
    monkeypatch.setattr("server.services.practice.coach.httpx.AsyncClient",
                        lambda **kwargs: client_type(transport=httpx.MockTransport(handler)))
    coach = GlmPracticeCoach("test-only", "model", "https://test.invalid", 1)
    result = asyncio.run(coach.recommend(attempt.issues, store.memory(attempt.session_id)))
    assert result
    content = json.loads(captured[0]["messages"][1]["content"])
    assert "sessionId" not in content["memory"]
    assert "updatedAt" not in content["memory"]
    assert "lastPracticedAt" not in content["memory"]["phenomena"][0]
    assert "hintId" not in content["issues"][0]
    assert "sentenceId" not in content["issues"][0]
    assert content["issues"][0]["issueId"] == attempt.issues[0].issue_id


def test_file_cleanup_failure_log_is_safe(caplog):
    def fail(**kwargs):
        raise RuntimeError("token=secret-file-url")

    delete_provider_file(SimpleNamespace(files=SimpleNamespace(delete=fail)),
                         SimpleNamespace(name="private-file-id"))
    assert "provider_file_delete_failed" in caplog.text
    assert "secret-file-url" not in caplog.text
    assert "private-file-id" not in caplog.text


def test_reference_analysis_stateless_and_files_cleaned(monkeypatch):
    calls, deleted = [], []
    client = SimpleNamespace(
        files=SimpleNamespace(upload=lambda **kwargs: SimpleNamespace(
            name="test-file", uri="test-uri", mime_type="audio/mpeg"),
            delete=lambda **kwargs: deleted.append(kwargs["name"])),
        interactions=SimpleNamespace(create=lambda **kwargs: (
            calls.append(kwargs) or SimpleNamespace(
                output_text='{"lyricsMatch":"match","observations":[]}'))),
    )
    from google import genai

    monkeypatch.setattr(genai, "Client", lambda **kwargs: client)
    GeminiLanguageCoach("test-only")._analyze_once(Path("test.mp3"), "lyrics", [], [])
    assert calls[0]["store"] is False
    assert deleted == ["test-file"]


def test_feedback_deletion_blocks_late_persistence(tmp_path):
    store = PracticeStore(tmp_path)
    attempt = _attempt(1, issue_type="expected_elision_realized")
    store.save(attempt)
    store.forget_take(attempt.take_id)
    PracticeStore(tmp_path).save(attempt)
    assert store.get_for_take(attempt.take_id) is None
    assert store.memory(attempt.session_id).reliable_attempts == 0


def test_song_deletion_blocks_late_persistence(tmp_path):
    store = PracticeStore(tmp_path)
    attempt = _attempt(1, issue_type="expected_elision_realized")
    store.save(attempt)
    store.delete_for_song(attempt.song_id, attempt.session_id)
    store.save(attempt)
    assert store.get_for_take(attempt.take_id) is None


def test_retained_memory_deletion_ownership(take_client):
    client, data, song = take_client
    created = _webm_upload(client, song).json()
    take = TakeStore(data).get(created["takeId"])
    attempt = _attempt(1, issue_type="expected_elision_realized").model_copy(update={
        "session_id": take.session_id, "take_id": take.take_id, "song_id": song})
    store = PracticeStore(data)
    store.save(attempt)
    url = f"/api/v1/practice/attempts/{attempt.attempt_id}"
    assert client.delete(url).status_code == 409  # Saved audio uses the existing Take delete route.
    assert client.delete(f"/api/v1/takes/{take.take_id}?preserve_attempt=true").status_code == 204
    assert store.get(attempt.attempt_id)
    cookie = client.cookies.get("verseviva_session")
    client.cookies.clear()
    assert client.delete(url).status_code == 404
    assert store.get(attempt.attempt_id)
    client.cookies.set("verseviva_session", cookie)
    assert client.delete(url).status_code == 204
    store.save(attempt)
    assert store.get(attempt.attempt_id) is None
    assert store.memory(take.session_id).total_attempts == 0
    assert client.delete(url).status_code == 404


def test_privacy_endpoint_no_store(take_client):
    client, _, _ = take_client
    response = client.get("/api/v1/privacy/facts")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["schemaVersion"] == "privacy-facts-v1"
