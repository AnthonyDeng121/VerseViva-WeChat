import json
import shutil
import subprocess

import pytest

from server.api.routes.takes import _recording_format
from server.config import get_settings
from tests.test_recording_takes import take_client  # noqa: F401


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        (b"ID3\x04\x00\x00\x00\x00\x00\x00audio", (".mp3", "audio/mpeg")),
        (b"\xff\xfb\x90\x64" + b"audio-data", (".mp3", "audio/mpeg")),
        (b"\xff\xf1\x50\x80\x01\x7f\xfcdata", (".aac", "audio/aac")),
        (b"\xff\xff\xff\xfffake-syncword", None),
        (b"\xff\xf1\x7c\x80\x01\x7f\xfcdata", None),
        (b"not-a-recording", None),
    ],
)
def test_recording_format_distinguishes_mp3_and_adts(header, expected):
    assert _recording_format(header) == expected


@pytest.mark.parametrize(
    ("filename", "mime", "content", "stored", "canonical_mime"),
    [
        (
            "recording.mp3",
            "audio/mpeg",
            b"\xff\xfb\x90\x64audio-data",
            "original.mp3",
            "audio/mpeg",
        ),
        (
            "recording.aac",
            "audio/aac",
            b"\xff\xf1\x50\x80\x01\x7f\xfcdata",
            "original.aac",
            "audio/aac",
        ),
        (
            "wxfile.tmp",
            "application/octet-stream",
            b"\xff\xfb\x90\x64audio-data",
            "original.mp3",
            "audio/mpeg",
        ),
        (
            "wxfile",
            "application/octet-stream",
            b"\xff\xf1\x50\x80\x01\x7f\xfcdata",
            "original.aac",
            "audio/aac",
        ),
        (
            "wrong.webm",
            "audio/webm",
            b"\xff\xf1\x50\x80\x01\x7f\xfcdata",
            "original.aac",
            "audio/aac",
        ),
    ],
)
def test_wechat_upload_uses_content_not_temporary_filename(
    take_client,  # noqa: F811
    filename,
    mime,
    content,
    stored,
    canonical_mime,  # noqa: F811
):
    client, data_dir, song_id = take_client
    response = client.post(
        f"/api/v1/songs/{song_id}/takes",
        data={
            "session_id": "not-an-identity",
            "track_slot_id": "primary:range:sentence_001:sentence_001:1",
            "selection_type": "sentence",
            "sentence_ids": '["sentence_001"]',
            "selection_start_seconds": "0.852",
            "selection_end_seconds": "5.1",
            "timeline_start_seconds": "0.852",
            "save_mode": "overdub_append",
        },
        files={"audio": (filename, content, mime)},
    )
    assert response.status_code == 201
    take = response.json()
    assert take["storedFilename"] == stored
    assert take["mimeType"] == canonical_mime
    assert (data_dir / "takes" / take["takeId"] / stored).read_bytes() == content
    assert take["sessionId"] != "not-an-identity"
    assert client.get(take["audioUrl"]).content == content


def test_unknown_temporary_content_is_rejected_and_cleaned(take_client):  # noqa: F811
    client, data_dir, song_id = take_client
    response = client.post(
        f"/api/v1/songs/{song_id}/takes",
        data={
            "session_id": "not-an-identity",
            "track_slot_id": "primary:range:a:a:1",
            "selection_type": "sentence",
            "sentence_ids": '["sentence_001"]',
            "selection_start_seconds": "0.852",
            "selection_end_seconds": "5.1",
            "timeline_start_seconds": "0.852",
            "save_mode": "overdub_append",
        },
        files={"audio": ("wxfile.tmp", b"not-audio", "application/octet-stream")},
    )
    assert response.status_code == 415
    assert list((data_dir / "takes").glob("take_*")) == []


@pytest.mark.parametrize(("extension", "codec"), [("mp3", "mp3"), ("aac", "aac")])
def test_real_encoded_wechat_formats_roundtrip(
    take_client, tmp_path, monkeypatch, extension, codec  # noqa: F811
):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("ffmpeg/ffprobe required for actual codec roundtrip")
    client, data_dir, song_id = take_client
    monkeypatch.setenv("VERSEVIVA_MAX_RECORDING_SIZE_BYTES", "1048576")
    get_settings.cache_clear()
    source = tmp_path / f"codec-sample.{extension}"
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.15",
            "-ar",
            "16000",
            "-ac",
            "1",
            str(source),
        ],
        check=True,
        capture_output=True,
        timeout=10,
    )
    response = client.post(
        f"/api/v1/songs/{song_id}/takes",
        data={
            "session_id": "not-an-identity",
            "track_slot_id": "primary:range:a:a:1",
            "selection_type": "sentence",
            "sentence_ids": '["sentence_001"]',
            "selection_start_seconds": "0.852",
            "selection_end_seconds": "5.1",
            "timeline_start_seconds": "0.852",
            "save_mode": "overdub_append",
        },
        files={"audio": ("wxfile.tmp", source.read_bytes(), "application/octet-stream")},
    )
    assert response.status_code == 201
    take = response.json()
    stored = data_dir / "takes" / take["takeId"] / take["storedFilename"]
    assert stored.suffix == f".{extension}"
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name",
            "-of",
            "json",
            str(stored),
        ],
        check=True,
        capture_output=True,
        timeout=10,
    )
    assert json.loads(result.stdout)["streams"][0]["codec_name"] == codec
