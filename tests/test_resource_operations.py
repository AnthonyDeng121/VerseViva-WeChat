import asyncio
import hashlib
import json
import os
import sqlite3
import subprocess
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.testclient import TestClient

from server.config import Settings
from server.maintenance import backup, cleanup, report, restore
from server.services.anonymous_session import AnonymousSessionMiddleware
from server.services.resource_limits import (
    AdmissionBudget,
    ResourceLimitsMiddleware,
    enforce_audio_duration,
    owner_bytes,
)
from server.services.runtime_lock import RuntimeLock


@pytest.fixture
def cfg(tmp_path):
    return Settings(_env_file=None, data_dir=tmp_path, resource_limits_enabled=True,
                    resource_min_free_bytes=0, resource_wechat_only=False)


def test_atomic_persistent_daily_budget(cfg):
    cfg.resource_ai_per_minute = 100
    cfg.resource_ai_per_day = 4
    budget = AdmissionBudget(cfg)

    def admit(_):
        try:
            budget.admit("owner", ["ai"])
            return True
        except HTTPException as exc:
            assert exc.status_code == 429
            return False

    with ThreadPoolExecutor(max_workers=8) as pool:
        assert sum(pool.map(admit, range(20))) == 4
    with pytest.raises(HTTPException):
        AdmissionBudget(cfg).admit("owner", ["ai"])
    AdmissionBudget(cfg).admit("other", ["ai"])
    assert report(cfg.data_dir)["admitted_requests_today_utc"] == {"ai": 5}


def test_multi_budget_rollback_and_minute_expiry(cfg, monkeypatch):
    cfg.resource_ai_per_minute = 1
    clock = [1_800_000_000.0]
    monkeypatch.setattr("server.services.resource_limits.time.time", lambda: clock[0])
    budget = AdmissionBudget(cfg)
    budget.admit("owner", ["ai"])
    with pytest.raises(HTTPException):
        budget.admit("owner", ["uploads", "ai"])
    with sqlite3.connect(budget.database) as db:
        assert db.execute("SELECT COUNT(*) FROM admissions WHERE kind='uploads'").fetchone()[0] == 0
    clock[0] += 61
    budget.admit("owner", ["ai"])


def test_storage_and_disk_gates(cfg, monkeypatch):
    job = cfg.data_dir / "jobs" / ("job_" + "a" * 32)
    job.mkdir(parents=True)
    (job / "job.json").write_text(json.dumps({"session_id": "owner"}))
    (job / "audio").write_bytes(b"x" * 100)
    assert owner_bytes(cfg.data_dir, "owner") >= 100
    assert owner_bytes(cfg.data_dir, "other") == 0
    cfg.resource_owner_bytes = 100
    budget = AdmissionBudget(cfg)
    with pytest.raises(HTTPException) as exc:
        budget.admit("owner", ["uploads"], 1)
    assert exc.value.status_code == 413
    monkeypatch.setattr("server.services.resource_limits.shutil.disk_usage",
                        lambda _: SimpleNamespace(free=0))
    with pytest.raises(HTTPException) as exc:
        budget.admit("other", ["uploads"], 1)
    assert exc.value.status_code == 507


@pytest.mark.parametrize("output,expected", [("12", None), ("601", 413),
                                            ("nan", 415), ("inf", 415), ("0", 415),
                                            ("bad", 415)])
def test_measured_duration(cfg, monkeypatch, output, expected):
    monkeypatch.setattr("server.services.resource_limits.subprocess.run",
                        lambda *args, **kwargs: SimpleNamespace(stdout=output))
    if expected:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(enforce_audio_duration(cfg.data_dir / "audio", cfg, recording=True))
        assert exc.value.status_code == expected
    else:
        asyncio.run(enforce_audio_duration(cfg.data_dir / "audio", cfg, recording=False))


def test_probe_timeout_does_not_admit(cfg, monkeypatch):
    def fail(*args, **kwargs):
        raise subprocess.TimeoutExpired("ffprobe", 15)

    monkeypatch.setattr("server.services.resource_limits.subprocess.run", fail)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(enforce_audio_duration(cfg.data_dir / "audio", cfg, recording=True))
    assert exc.value.status_code == 415


def test_runtime_exclusive_and_released(tmp_path):
    with RuntimeLock(tmp_path):
        with pytest.raises(RuntimeError):
            RuntimeLock(tmp_path)
    with RuntimeLock(tmp_path):
        pass


def test_backup_restore_sqlite_and_private_audio(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    with sqlite3.connect(data / "verseviva.sqlite3") as db:
        db.execute("CREATE TABLE example(value TEXT)")
        db.execute("INSERT INTO example VALUES ('saved')")
    (data / "recording").write_bytes(b"original recording")
    (data / ".session-secret").write_bytes(b"test-only secret")
    archive = tmp_path / "backup.zip"
    backup(data, archive)
    target = tmp_path / "restored"
    assert restore(archive, target) == 3
    assert not target.exists()
    restore(archive, target, apply=True)
    assert (target / "recording").read_bytes() == b"original recording"
    assert (target / ".session-secret").read_bytes() == b"test-only secret"
    with sqlite3.connect(target / "verseviva.sqlite3") as db:
        assert db.execute("SELECT value FROM example").fetchone()[0] == "saved"
    with pytest.raises(ValueError):
        restore(archive, target, apply=True)
    with pytest.raises(ValueError):
        backup(data, archive)


@pytest.mark.parametrize("name", ["../escape", "/escape", "a/../../escape", "C:/escape",
                                 "a\\escape", "a//escape"])
def test_restore_rejects_unsafe_paths(tmp_path, name):
    archive = tmp_path / "bad.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("manifest.json", json.dumps({name: hashlib.sha256(b"x").hexdigest()}))
        bundle.writestr("data/" + name, b"x")
    with pytest.raises(ValueError):
        restore(archive, tmp_path / "new", apply=True)
    assert not (tmp_path / "new").exists()


def test_restore_rejects_corruption(tmp_path):
    archive = tmp_path / "bad.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("manifest.json", json.dumps({"audio": "wrong hash"}))
        bundle.writestr("data/audio", b"x")
    with pytest.raises(ValueError, match="checksum"):
        restore(archive, tmp_path / "new", apply=True)
    assert not (tmp_path / "new").exists()


def test_cleanup_dry_run_preserves_saved_and_hero(tmp_path):
    with sqlite3.connect(tmp_path / "verseviva.sqlite3") as db:
        db.execute("CREATE TABLE recording_takes(take_id TEXT)")
        db.execute("INSERT INTO recording_takes VALUES (?)", ("take_" + "a" * 32,))
    folders = ["takes/take_" + "a" * 32, "takes/take_" + "b" * 32,
               "jobs/job_" + "c" * 32, "songs/hero_01", "mix-previews/mix_" + "d" * 32]
    for name in folders:
        path = tmp_path / name
        path.mkdir(parents=True)
        (path / "audio").write_bytes(b"x")
        old = time.time() - 90000
        os.utime(path / "audio", (old, old))
        os.utime(path, (old, old))
    candidates = cleanup(tmp_path)
    assert len(candidates) == 3
    assert all((tmp_path / name).exists() for name in folders)
    assert cleanup(tmp_path, apply=True) == candidates
    assert (tmp_path / folders[0]).exists()
    assert (tmp_path / "songs/hero_01/audio").exists()


def run_middleware(cfg, *, body=b"test", auth="wechat", path="/songs/analyze", method="POST"):
    sent = []
    consumed = []

    async def downstream(scope, receive, send):
        while True:
            message = await receive()
            consumed.append(message.get("body", b""))
            if not message.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    messages = iter([{"type": "http.request", "body": body[:2], "more_body": True},
                     {"type": "http.request", "body": body[2:], "more_body": False}])

    async def receive():
        return next(messages)

    async def send(message):
        sent.append(message)

    scope = {"type": "http", "path": cfg.api_prefix + path, "method": method,
             "state": {"session_id": "owner", "auth_type": auth}}
    asyncio.run(ResourceLimitsMiddleware(downstream, cfg)(scope, receive, send))
    return sent[0]["status"], b"".join(consumed)


def test_chunked_limit_before_parser(cfg):
    cfg.max_upload_size_bytes = 10
    assert run_middleware(cfg, body=b"x" * (1024 * 1024 + 11))[0] == 413


def test_valid_upload_replayed(cfg):
    assert run_middleware(cfg, body=b"audio") == (204, b"audio")


def test_wechat_required_for_expensive_requests(cfg):
    cfg.resource_wechat_only = True
    assert run_middleware(cfg, auth="web_anonymous")[0] == 401
    assert not (cfg.data_dir / "resource-budgets.sqlite3").exists()


def test_both_analysis_entrypoints_budgeted(cfg):
    cfg.resource_ai_per_minute = 1
    assert run_middleware(cfg, path="/takes/take_a/analyze")[0] == 204
    assert run_middleware(cfg, path="/takes/take_a/analysis-jobs")[0] == 429


def test_legacy_mix_budgeted(cfg):
    cfg.resource_ai_per_minute = 1
    assert run_middleware(cfg, path="/songs/song_a/mixdown", method="GET")[0] == 204
    assert run_middleware(cfg, path="/songs/song_a/mix-jobs")[0] == 429


def test_real_multipart_and_identity_middleware_order(cfg):
    app = FastAPI()
    app.add_middleware(ResourceLimitsMiddleware, settings=cfg)
    app.add_middleware(AnonymousSessionMiddleware, data_dir=cfg.data_dir, secure=False)

    @app.post("/api/v1/songs/analyze")
    async def upload(request: Request, audio: UploadFile = File(...)):  # noqa: B008
        return {"size": len(await audio.read()), "trusted": bool(request.state.session_id)}

    with TestClient(app) as client:
        result = client.post("/api/v1/songs/analyze", files={"audio": ("a.mp3", b"audio")})
        assert result.status_code == 200
        assert result.json() == {"size": 5, "trusted": True}
        assert client.cookies.get("verseviva_session")
        cfg.resource_wechat_only = True
        assert client.post("/api/v1/songs/analyze",
                           files={"audio": ("a.mp3", b"audio")}).status_code == 401


def test_disabled_limits_leave_legacy_behavior(cfg):
    cfg.resource_limits_enabled = False
    cfg.resource_wechat_only = True
    assert run_middleware(cfg, auth="web_anonymous") == (204, b"test")
    assert not (cfg.data_dir / "resource-budgets.sqlite3").exists()


def test_pending_background_admission_bound(cfg):
    async def downstream(scope, receive, send):
        pytest.fail("An overloaded analysis request must not reach route mutation")

    async def receive():
        return {"type": "http.request", "body": b""}

    sent = []

    async def send(message):
        sent.append(message)

    cfg.resource_max_pending_analysis = 1
    application = SimpleNamespace(state=SimpleNamespace(
        analysis_queue=SimpleNamespace(pending_count=1, active_job_id=None)))
    scope = {"type": "http", "path": "/api/v1/takes/take_a/analysis-jobs", "method": "POST",
             "state": {"session_id": "owner", "auth_type": "wechat"}, "app": application}
    asyncio.run(ResourceLimitsMiddleware(downstream, cfg)(scope, receive, send))
    assert sent[0]["status"] == 429
