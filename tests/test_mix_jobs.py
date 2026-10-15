import json
import threading
import time

import pytest

from server.models.mix import MixJob
from server.services.mix_jobs import MixJobs
from server.storage.take_store import TakeStore
from tests.test_wechat_auth import (  # noqa: F401
    auth_client,
    bearer,
    create_song,
    login,
    upload_take,
)


def setup_mix(fixture, monkeypatch):
    client, data_dir = fixture
    alice = bearer(login(client))
    song = create_song(client, alice, data_dir)["song_id"]
    take = upload_take(client, song, alice).json()
    calls = []

    def render(**options):
        calls.append(options)
        options["output"].parent.mkdir(parents=True, exist_ok=True)
        options["output"].write_bytes(b"ID3-mix-result-audio")

    monkeypatch.setattr("server.services.mix_jobs.render_mixdown", render)
    return client, data_dir, alice, song, take, calls


def start(client, owner, song, take, **options):
    return client.post(f"/api/v1/songs/{song}/mix-jobs", headers=owner,
                       json={"takeIds": [take["takeId"]], **options})


def wait(client, owner, job_id):
    for _ in range(100):
        response = client.get(f"/api/v1/mix-jobs/{job_id}", headers=owner)
        assert response.status_code == 200
        job = response.json()
        if job["status"] not in {"queued", "processing"}:
            return job
        time.sleep(0.01)
    pytest.fail("mix job did not finish")


def test_mix_short_job_cache_parameters_and_private_range(auth_client, monkeypatch):  # noqa: F811
    client, _, alice, song, take, calls = setup_mix(auth_client, monkeypatch)
    response = start(client, alice, song, take, masterGain=0.7)
    assert response.status_code == 202
    job_id = response.json()["jobId"]
    assert wait(client, alice, job_id)["status"] == "ready"
    assert calls[0]["master_gain"] == 0.7
    assert calls[0]["takes"][0][0].take_id == take["takeId"]
    same = start(client, alice, song, take, masterGain=0.7).json()
    assert same["jobId"] == job_id
    assert len(calls) == 1
    audio = client.get(f"/api/v1/mix-jobs/{job_id}/audio", headers={**alice, "Range": "bytes=0-2"})
    assert audio.status_code == 206
    assert audio.content == b"ID3"
    assert audio.headers["cache-control"] == "no-store"
    bob = bearer(login(client, "bob"))
    assert client.get(f"/api/v1/mix-jobs/{job_id}", headers=bob).status_code == 404
    assert client.get(f"/api/v1/mix-jobs/{job_id}/audio", headers=bob).status_code == 404
    assert start(client, bob, song, take).status_code == 404
    changed = start(client, alice, song, take, masterGain=0.6).json()
    assert changed["jobId"] != job_id
    assert wait(client, alice, changed["jobId"])["status"] == "ready"


@pytest.mark.parametrize("changes", [{"gain": 0.4}, {"muted": True}, {"manualOffsetMs": 220}])
def test_edit_invalidates_download_and_creates_new_snapshot(auth_client, monkeypatch, changes):  # noqa: F811
    client, _, alice, song, take, calls = setup_mix(auth_client, monkeypatch)
    job_id = start(client, alice, song, take).json()["jobId"]
    assert wait(client, alice, job_id)["status"] == "ready"
    assert client.patch(f"/api/v1/takes/{take['takeId']}", headers=alice,
                        json=changes).status_code == 200
    assert client.get(f"/api/v1/mix-jobs/{job_id}", headers=alice).json()["status"] == "stale"
    assert client.get(f"/api/v1/mix-jobs/{job_id}/audio", headers=alice).status_code == 409
    new_id = start(client, alice, song, take).json()["jobId"]
    assert new_id != job_id
    assert wait(client, alice, new_id)["status"] == "ready"
    assert len(calls) == 2


def test_delete_input_invalidates_even_cached_audio(auth_client, monkeypatch):  # noqa: F811
    client, _, alice, song, take, _ = setup_mix(auth_client, monkeypatch)
    job_id = start(client, alice, song, take).json()["jobId"]
    assert wait(client, alice, job_id)["status"] == "ready"
    client.delete(f"/api/v1/takes/{take['takeId']}", headers=alice)
    assert not client.app.state.mix_jobs.output(job_id).exists()
    assert client.get(f"/api/v1/mix-jobs/{job_id}/audio", headers=alice).status_code == 409


def test_running_edit_never_publishes_old_audio_and_owner_queue_is_bounded(
    auth_client, monkeypatch,  # noqa: F811
):
    client, _, alice, song, take, _ = setup_mix(auth_client, monkeypatch)
    entered = threading.Event()
    release = threading.Event()

    def render(**options):
        entered.set()
        assert release.wait(3)
        options["output"].parent.mkdir(parents=True, exist_ok=True)
        options["output"].write_bytes(b"ID3-result")

    monkeypatch.setattr("server.services.mix_jobs.render_mixdown", render)
    try:
        job_id = start(client, alice, song, take).json()["jobId"]
        assert entered.wait(1)
        # Identical submission deduplicates; a new parameter cannot enqueue endlessly.
        assert start(client, alice, song, take).json()["jobId"] == job_id
        assert start(client, alice, song, take, masterGain=0.5).status_code == 429
        client.patch(f"/api/v1/takes/{take['takeId']}", headers=alice, json={"muted": True})
    finally:
        release.set()
    assert wait(client, alice, job_id)["status"] == "stale"
    assert client.get(f"/api/v1/mix-jobs/{job_id}/audio", headers=alice).status_code == 409


def test_render_error_is_safe_and_can_retry(auth_client, monkeypatch):  # noqa: F811
    client, _, alice, song, take, _ = setup_mix(auth_client, monkeypatch)

    def fail(**options):
        raise RuntimeError("private-path-and-secret")

    monkeypatch.setattr("server.services.mix_jobs.render_mixdown", fail)
    job_id = start(client, alice, song, take).json()["jobId"]
    job = wait(client, alice, job_id)
    assert job["status"] == "failed"
    assert "private-path" not in json.dumps(job)
    assert start(client, alice, song, take).json()["jobId"] != job_id


def test_restart_recovers_interrupted_and_retains_ready_metadata(auth_client, monkeypatch):  # noqa: F811
    client, data_dir, alice, song, take, _ = setup_mix(auth_client, monkeypatch)
    job_id = start(client, alice, song, take).json()["jobId"]
    assert wait(client, alice, job_id)["status"] == "ready"
    service = client.app.state.mix_jobs
    owner = service._task_owner(job_id)
    with service.connect() as connection:
        row = connection.execute("SELECT payload FROM mix_jobs WHERE job_id = ?",
                                 (job_id,)).fetchone()
        job = MixJob.model_validate_json(row["payload"])
        job.status = "processing"
        service.save(connection, job)
    recovered = MixJobs(data_dir, "ffmpeg").get(job_id, owner)
    assert recovered.status == "failed"
    assert not service.output(job_id).exists()


def test_invalid_parameters_do_not_start_work(auth_client, monkeypatch):  # noqa: F811
    client, _, alice, song, take, calls = setup_mix(auth_client, monkeypatch)
    for options in [{"masterGain": 3}, {"takeIds": []},
                    {"takeIds": [take["takeId"], take["takeId"]]}, {"publicUrl": "evil"}]:
        assert start(client, alice, song, take, **options).status_code == 422
    assert calls == []


@pytest.mark.parametrize("field", ["timeline_start_seconds", "latency_compensation_ms", "file"])
def test_cache_key_covers_original_placement_latency_and_file_changes(
    auth_client, monkeypatch, field,  # noqa: F811
):
    client, data_dir, alice, song, take, _ = setup_mix(auth_client, monkeypatch)
    job_id = start(client, alice, song, take).json()["jobId"]
    assert wait(client, alice, job_id)["status"] == "ready"
    store = TakeStore(data_dir)
    stored = store.get(take["takeId"])
    if field == "file":
        (data_dir / "takes" / stored.take_id / stored.stored_filename).write_bytes(b"changed-file")
    else:
        store.save(stored.model_copy(update={field: 2}))
    assert client.get(f"/api/v1/mix-jobs/{job_id}", headers=alice).json()["status"] == "stale"


def test_cache_has_per_owner_bound_and_expiration(auth_client, monkeypatch):  # noqa: F811
    client, _, alice, song, take, _ = setup_mix(auth_client, monkeypatch)
    jobs = []
    for gain in [0.1, 0.2, 0.3, 0.4]:
        job_id = start(client, alice, song, take, masterGain=gain).json()["jobId"]
        assert wait(client, alice, job_id)["status"] == "ready"
        jobs.append(job_id)
    assert client.get(f"/api/v1/mix-jobs/{jobs[0]}", headers=alice).status_code == 404
    service = client.app.state.mix_jobs
    with service.connect() as connection:
        rows = connection.execute("SELECT payload FROM mix_jobs").fetchall()
        assert len(rows) == 3
        latest = MixJob.model_validate_json(rows[-1]["payload"])
        latest.created_at = time.time() - 86401
        service.save(connection, latest)
    assert client.get(f"/api/v1/mix-jobs/{latest.job_id}/audio", headers=alice).status_code == 409


def test_two_owners_render_serially_and_foreign_take_is_rejected(auth_client, monkeypatch):  # noqa: F811
    client, data_dir, alice, song, take, _ = setup_mix(auth_client, monkeypatch)
    bob = bearer(login(client, "bob"))
    other_song = create_song(client, bob, data_dir)["song_id"]
    other_take = upload_take(client, other_song, bob).json()
    assert start(client, bob, other_song, take).status_code == 404
    entered = threading.Event()
    release = threading.Event()
    calls = []

    def render(**options):
        calls.append(options)
        entered.set()
        assert release.wait(3)
        options["output"].parent.mkdir(parents=True, exist_ok=True)
        options["output"].write_bytes(b"ID3-result")

    monkeypatch.setattr("server.services.mix_jobs.render_mixdown", render)
    try:
        first = start(client, alice, song, take).json()["jobId"]
        assert entered.wait(1)
        second = start(client, bob, other_song, other_take).json()["jobId"]
        assert client.get(f"/api/v1/mix-jobs/{second}", headers=bob).json()["status"] == "queued"
        assert len(calls) == 1
    finally:
        release.set()
    assert wait(client, alice, first)["status"] == "ready"
    assert wait(client, bob, second)["status"] == "ready"
    assert len(calls) == 2
