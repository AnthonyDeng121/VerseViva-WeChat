import json

import pytest

from tests.test_recording_takes import _webm_upload, take_client  # noqa: F401


def evidence():
    kinds = ["recorder_start_requested", "recorder_started", "reference_play_requested",
             "reference_playing", "recorder_stop_requested", "recorder_stopped"]
    events = [{"kind": kind, "atMs": index * 10, "positionSeconds": None}
              for index, kind in enumerate(kinds)]
    events[3]["positionSeconds"] = 0.852
    return {"schemaVersion": "wechat-sync-v1", "clock": "client_wall_ms", "playbackRate": 1,
            "calibrationStatus": "unverified", "calibratedDeviceLatencyMs": 0,
            "observedStartGapMs": 20, "events": events}


def test_sync_evidence_roundtrip_and_web_compatibility(take_client):  # noqa: F811
    client, _, song_id = take_client
    response = _webm_upload(client, song_id, sync_evidence=json.dumps(evidence()))
    assert response.status_code == 201
    assert response.json()["syncEvidence"] == evidence()
    restored = client.get(f"/api/v1/songs/{song_id}/takes").json()
    assert restored[0]["syncEvidence"] == evidence()
    assert _webm_upload(client, song_id).json()["syncEvidence"] is None


@pytest.mark.parametrize("case", ["truncated", "reordered", "gap", "nan", "extra", "calibration"])
def test_invalid_sync_evidence_rejected_before_audio_write(take_client, case):  # noqa: F811
    client, data_dir, song_id = take_client
    value = evidence()
    if case == "truncated":
        value["events"].pop()
    elif case == "reordered":
        value["events"][0]["atMs"] = 100
    elif case == "gap":
        value["observedStartGapMs"] = 999
    elif case == "nan":
        value["events"][0]["atMs"] = float("nan")
    elif case == "extra":
        value["token"] = "must-not-echo"
    else:
        value["calibratedDeviceLatencyMs"] = 500
    response = _webm_upload(client, song_id, sync_evidence=json.dumps(value))
    assert response.status_code == 422
    assert "must-not-echo" not in response.text
    assert not (data_dir / "takes").exists()
