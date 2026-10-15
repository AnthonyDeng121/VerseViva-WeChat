import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.config import get_settings
from server.main import app
from server.storage.practice_store import PracticeStore
from server.storage.profile_store import ProfileStore
from tests.test_song_profile_schema import make_profile


@pytest.fixture
def take_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("VERSEVIVA_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("VERSEVIVA_MAX_RECORDING_SIZE_BYTES", "64")
    get_settings.cache_clear()
    # Shared practice reference: private-song ownership is tested separately.
    song_id = "song_00000000000000000000000000000003"
    ProfileStore(tmp_path).save(make_profile().model_copy(update={"song_id": song_id}))
    with TestClient(app) as client:
        yield client, tmp_path, song_id
    get_settings.cache_clear()


def _webm_upload(
    client: TestClient,
    song_id: str,
    *,
    media_type: str = "audio/webm",
    **overrides,
):
    data = {
        "session_id": "session_mobile_01",
        "track_slot_id": "practice_sentence_001",
        "selection_type": "sentence",
        "sentence_ids": '["sentence_001"]',
        "selection_start_seconds": "0.852",
        "selection_end_seconds": "5.1",
        "timeline_start_seconds": "0.852",
        "save_mode": "practice_replace",
        "client_duration_seconds": "4.4",
        **overrides,
    }
    return client.post(
        f"/api/v1/songs/{song_id}/takes",
        data=data,
        files={"audio": ("recording.webm", b"\x1aE\xdf\xa3mobile-audio", media_type)},
    )


def test_mobile_webm_sentence_take_uploads_and_restores(take_client) -> None:
    client, data_dir, song_id = take_client

    response = _webm_upload(client, song_id)

    assert response.status_code == 201
    payload = response.json()
    assert payload["selectionType"] == "sentence"
    assert payload["displayName"] == "轨道1"
    assert payload["sentenceIds"] == ["sentence_001"]
    assert payload["isCurrent"] is True
    assert (data_dir / "takes" / payload["takeId"] / "original.webm").is_file()
    assert (data_dir / "verseviva.sqlite3").is_file()
    assert client.get(payload["audioUrl"]).content.startswith(b"\x1aE\xdf\xa3")
    restored = client.get(f"/api/v1/songs/{song_id}/takes?session_id=session_mobile_01")
    assert restored.status_code == 200
    assert [item["takeId"] for item in restored.json()] == [payload["takeId"]]


def test_take_upload_accepts_long_multi_sentence_slot_identifier(take_client) -> None:
    client, _, song_id = take_client
    long_slot_id = "primary:" + "+".join(f"sentence_{index:03d}" for index in range(1, 14))

    response = _webm_upload(client, song_id, track_slot_id=long_slot_id)

    assert len(long_slot_id) > 128
    assert response.status_code == 201
    assert response.json()["trackSlotId"] == long_slot_id


def test_take_keeps_hidden_latency_compensation_separate_from_manual_offset(
    take_client,
) -> None:
    client, _, song_id = take_client

    response = _webm_upload(
        client,
        song_id,
        latency_compensation_ms="500",
        manual_offset_ms="0",
    )

    assert response.status_code == 201
    assert response.json()["latencyCompensationMs"] == 500
    assert response.json()["manualOffsetMs"] == 0


def test_mobile_webm_accepts_browser_codec_parameter(take_client) -> None:
    client, _, song_id = take_client

    response = _webm_upload(client, song_id, media_type="audio/webm;codecs=opus")

    assert response.status_code == 201
    assert response.json()["mimeType"] == "audio/webm"


def test_upload_normalizes_mislabeled_webm_with_mp4_container(take_client) -> None:
    client, data_dir, song_id = take_client
    response = client.post(
        f"/api/v1/songs/{song_id}/takes",
        data={
            "session_id": "session_mobile_01",
            "track_slot_id": "primary:sentence_001",
            "selection_type": "sentence",
            "sentence_ids": '["sentence_001"]',
            "selection_start_seconds": "0.852",
            "selection_end_seconds": "5.1",
            "timeline_start_seconds": "0.852",
            "save_mode": "overdub_append",
        },
        files={
            "audio": (
                "recording.webm",
                b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00",
                "audio/webm",
            )
        },
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload["storedFilename"] == "original.m4a"
    assert payload["mimeType"] == "audio/mp4"
    assert (data_dir / "takes" / payload["takeId"] / "original.m4a").is_file()

def test_practice_replace_only_supersedes_current_session_track(take_client) -> None:
    client, _, song_id = take_client
    first = _webm_upload(client, song_id).json()
    second = _webm_upload(client, song_id).json()
    first_session_cookie = client.cookies.get("verseviva_session")
    client.cookies.clear()
    other_session = _webm_upload(
        client,
        song_id,
        session_id="session_mobile_02",
    ).json()

    assert client.get(first["audioUrl"]).status_code == 404
    cross_session_patch = client.patch(
        first["audioUrl"].removesuffix("/audio"), json={"muted": True}
    )
    assert cross_session_patch.status_code == 404
    assert client.delete(first["audioUrl"].removesuffix("/audio")).status_code == 404
    forged = client.get(
        f"/api/v1/songs/{song_id}/takes?session_id={first['sessionId']}"
    ).json()
    assert [item["takeId"] for item in forged] == [other_session["takeId"]]
    client.cookies.set("verseviva_session", first_session_cookie)
    takes = client.get(f"/api/v1/songs/{song_id}/takes").json()
    by_id = {take["takeId"]: take for take in takes}
    assert by_id[first["takeId"]]["isCurrent"] is False
    assert by_id[first["takeId"]]["supersededByTakeId"] == second["takeId"]
    assert by_id[second["takeId"]]["isCurrent"] is True
    assert other_session["takeId"] not in by_id
    assert client.get(first["audioUrl"]).status_code == 200


def test_segment_and_overdub_takes_append_without_covering_previous_audio(take_client) -> None:
    client, _, song_id = take_client
    data = {
        "track_slot_id": "secondary_layer_01",
        "selection_type": "segment",
        "sentence_ids": '["sentence_001"]',
        "selection_start_seconds": "1.0",
        "selection_end_seconds": "4.8",
        "timeline_start_seconds": "1.0",
        "save_mode": "overdub_append",
    }
    first = _webm_upload(client, song_id, **data).json()
    second = _webm_upload(client, song_id, **data).json()

    takes = client.get(
        f"/api/v1/songs/{song_id}/takes?session_id=session_mobile_01"
    ).json()
    by_id = {take["takeId"]: take for take in takes}
    assert first["selectionType"] == "segment"
    assert by_id[first["takeId"]]["isCurrent"] is True
    assert by_id[second["takeId"]]["isCurrent"] is True
    assert by_id[first["takeId"]]["supersededByTakeId"] is None


def test_take_upload_rejects_unknown_sentence_and_mismatched_media(take_client) -> None:
    client, data_dir, song_id = take_client

    unknown = _webm_upload(client, song_id, sentence_ids='["sentence_missing"]')
    mismatched = client.post(
        f"/api/v1/songs/{song_id}/takes",
        data={
            "session_id": "session_mobile_01",
            "track_slot_id": "practice_sentence_001",
            "selection_type": "sentence",
            "sentence_ids": '["sentence_001"]',
            "selection_start_seconds": "0.852",
            "selection_end_seconds": "5.1",
            "timeline_start_seconds": "0.852",
            "save_mode": "practice_replace",
        },
        files={"audio": ("recording.mp4", b"not-an-mp4", "audio/mp4")},
    )

    assert unknown.status_code == 422
    assert mismatched.status_code == 415
    assert list((data_dir / "takes").glob("take_*/original.*")) == []


def test_take_can_be_renamed_and_its_mix_settings_persist(take_client) -> None:
    client, _, song_id = take_client
    created = _webm_upload(client, song_id).json()

    response = client.patch(
        f"/api/v1/takes/{created['takeId']}",
        json={
            "displayName": "我的和声",
            "gain": 0.72,
            "manualOffsetMs": -120,
            "muted": True,
        },
    )

    assert response.status_code == 200
    assert response.json()["displayName"] == "我的和声"
    assert response.json()["gain"] == 0.72
    assert response.json()["manualOffsetMs"] == -120
    assert response.json()["muted"] is True
    assert client.get(f"/api/v1/takes/{created['takeId']}").json()["gain"] == 0.72


def test_take_can_be_deleted_with_its_audio(take_client) -> None:
    client, data_dir, song_id = take_client
    created = _webm_upload(client, song_id).json()
    take_dir = data_dir / "takes" / created["takeId"]

    response = client.delete(f"/api/v1/takes/{created['takeId']}")

    assert response.status_code == 204
    assert client.get(f"/api/v1/takes/{created['takeId']}").status_code == 404
    assert not take_dir.exists()


def test_temporary_take_deletion_can_preserve_practice_memory(take_client) -> None:
    client, data_dir, song_id = take_client
    created = _webm_upload(client, song_id).json()
    database = data_dir / "verseviva.sqlite3"
    PracticeStore(data_dir)
    with sqlite3.connect(database) as connection:
        connection.execute(
            """INSERT INTO practice_attempts
            (attempt_id, take_id, session_id, song_id, track_slot_id, created_at, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                "attempt_preserved",
                created["takeId"],
                "session_mobile_01",
                song_id,
                "primary:sentence_001",
                "2026-10-08T00:00:00+00:00",
                "{}",
            ),
        )

    response = client.delete(
        f"/api/v1/takes/{created['takeId']}?preserve_attempt=true"
    )

    assert response.status_code == 204
    with sqlite3.connect(database) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM practice_attempts WHERE take_id = ?",
            (created["takeId"],),
        ).fetchone()[0] == 1


def test_current_session_mixdown_downloads_mp3(
    take_client,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, data_dir, song_id = take_client
    created = _webm_upload(
        client,
        song_id,
        latency_compensation_ms="500",
        manual_offset_ms="-120",
    ).json()
    audio_dir = data_dir / "songs" / song_id / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    (audio_dir / "accompaniment.mp3").write_bytes(b"fake-accompaniment")
    captured = {}

    def fake_render_mixdown(**kwargs) -> None:
        captured.update(kwargs)
        kwargs["output"].parent.mkdir(parents=True, exist_ok=True)
        kwargs["output"].write_bytes(b"ID3mixed-audio")

    monkeypatch.setattr(
        "server.api.routes.takes.render_mixdown",
        fake_render_mixdown,
    )

    response = client.get(
        f"/api/v1/songs/{song_id}/mixdown",
        params={
            "session_id": "session_mobile_01",
            "accompaniment_volume": 0.4,
            "voice_volume": 0.5,
        },
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/mpeg")
    assert response.content == b"ID3mixed-audio"
    assert captured["accompaniment_volume"] == 0.4
    assert captured["voice_volume"] == 0.5
    take = captured["takes"][0][0]
    assert take.take_id == created["takeId"]
    assert take.latency_compensation_ms == 500
    assert take.manual_offset_ms == -120


def test_free_overdub_is_saved_but_cannot_enter_practice_analysis(take_client) -> None:
    client, _, song_id = take_client

    created = _webm_upload(
        client,
        song_id,
        purpose="free_overdub",
        save_mode="overdub_append",
    )

    assert created.status_code == 201
    payload = created.json()
    assert payload["purpose"] == "free_overdub"
    analysis = client.post(f"/api/v1/takes/{payload['takeId']}/analyze")
    assert analysis.status_code == 409
    assert "不参与演唱分析或长期记忆" in analysis.json()["detail"]


def test_chinese_song_can_save_take_but_cannot_enter_practice_analysis(
    take_client,
) -> None:
    client, data_dir, song_id = take_client
    profile = ProfileStore(data_dir).get(song_id)
    assert profile is not None
    ProfileStore(data_dir).save(profile.model_copy(update={"language": "zh"}))
    created = _webm_upload(
        client,
        song_id,
        purpose="guided_practice",
        save_mode="overdub_append",
    )

    assert created.status_code == 201
    take_id = created.json()["takeId"]
    direct = client.post(f"/api/v1/takes/{take_id}/analyze")
    background = client.post(f"/api/v1/takes/{take_id}/analysis-jobs")

    assert direct.status_code == 409
    assert background.status_code == 409
    assert "中文歌曲不进行" in direct.json()["detail"]
    assert client.get(created.json()["audioUrl"]).status_code == 200
