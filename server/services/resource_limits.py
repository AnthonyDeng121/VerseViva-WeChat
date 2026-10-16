"""Opt-in admission budgets. Counters measure requests, never provider billing."""

import asyncio
import json
import math
import re
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import time
from contextlib import closing
from pathlib import Path

from fastapi import HTTPException
from starlette.responses import JSONResponse

from server.config import Settings


def tree_bytes(root: Path) -> int:
    def linked(path: Path) -> bool:
        # Windows reparse points include junctions, including on Python 3.11.
        attributes = getattr(path.lstat(), "st_file_attributes", 0)
        return path.is_symlink() or bool(attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)

    if root.is_symlink() or (root.exists() and linked(root)):
        raise ValueError("Linked data directories are not supported")
    total = 0
    if root.exists():
        for item in root.iterdir():
            if linked(item):
                raise ValueError("Linked data files are not supported")
            total += tree_bytes(item) if item.is_dir() else item.stat().st_size
    return total


def owner_bytes(data: Path, owner: str) -> int:
    roots = set()
    database = data / "verseviva.sqlite3"
    if database.exists():
        with closing(sqlite3.connect(database)) as db:
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='recording_takes'").fetchone():
                for (take_id,) in db.execute(
                    "SELECT take_id FROM recording_takes WHERE session_id=?", (owner,)
                ):
                    if re.fullmatch(r"take_[0-9a-f]{32}", take_id):
                        roots.add(data / "takes" / take_id)
    for path in (data / "jobs").glob("job_*/job.json"):
        job = json.loads(path.read_text(encoding="utf-8"))
        if job.get("session_id", job.get("sessionId")) == owner:
            roots.add(path.parent)
            song = job.get("song_id", job.get("songId", ""))
            if re.fullmatch(r"song_[0-9a-f]{32}", song):
                roots.add(data / "songs" / song)
    return sum(tree_bytes(root) for root in roots)


class AdmissionBudget:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.database = settings.data_dir / "resource-budgets.sqlite3"
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("CREATE TABLE IF NOT EXISTS admissions "
                       "(owner TEXT, kind TEXT, at REAL)")
            db.execute("CREATE INDEX IF NOT EXISTS admission_owner "
                       "ON admissions(owner, kind, at)")

    def admit(self, owner: str, kinds: list[str], reserve: int = 0) -> None:
        cfg = self.settings
        if shutil.disk_usage(cfg.data_dir).free < cfg.resource_min_free_bytes + 2 * reserve:
            raise HTTPException(507, "Insufficient storage capacity")
        if reserve and owner_bytes(cfg.data_dir, owner) + reserve > cfg.resource_owner_bytes:
            raise HTTPException(413, "User storage quota exceeded")
        now = time.time()
        day = math.floor(now / 86400) * 86400  # UTC, persisted across restarts.
        with closing(sqlite3.connect(self.database, timeout=10)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM admissions WHERE at < ?", (day - 86400,))
            for kind in kinds:
                minute_limit = getattr(cfg, f"resource_{kind}_per_minute")
                day_limit = getattr(cfg, f"resource_{kind}_per_day")
                minute, daily = db.execute(
                    "SELECT COALESCE(SUM(at>=?),0), COALESCE(SUM(at>=?),0) "
                    "FROM admissions WHERE owner=? AND kind=?", (now - 60, day, owner, kind)
                ).fetchone()
                if minute >= minute_limit or daily >= day_limit:
                    raise HTTPException(429, "Request budget exhausted",
                                        headers={"Retry-After": "60"})
            db.executemany("INSERT INTO admissions VALUES(?,?,?)",
                           [(owner, kind, now) for kind in kinds])


class ResourceLimitsMiddleware:
    """Runs inside trusted identity middleware, before multipart parsing.

    Expensive admissions are serialized until their HTTP response completes;
    background analysis has a separate pending-task admission check.
    """

    def __init__(self, app, settings: Settings):
        self.app, self.settings = app, settings
        self.gate = asyncio.Lock()
        self.budget = None

    async def __call__(self, scope, receive, send):
        cfg = self.settings
        path = scope.get("path", "").removeprefix(cfg.api_prefix)
        method = scope.get("method")
        upload = method == "POST" and (
            path == "/songs/analyze" or re.fullmatch(r"/songs/[^/]+/takes", path)
        )
        ai = method == "POST" and (
            path == "/songs/analyze"
            or re.fullmatch(r"/songs/jobs/[^/]+/retry|/songs/[^/]+/reanalyze", path)
            or re.fullmatch(r"/takes/[^/]+/(analyze|analysis-jobs)", path)
        )
        mix = ((method == "POST" and path.endswith("/mix-jobs"))
               or (method == "GET" and path.endswith("/mixdown")))
        if scope["type"] != "http" or not cfg.resource_limits_enabled or not (upload or ai or mix):
            await self.app(scope, receive, send)
            return
        state = scope.get("state", {})
        if cfg.resource_wechat_only and state.get("auth_type") not in {"wechat", "review"}:
            await JSONResponse({"detail": "WeChat login required"}, 401)(scope, receive, send)
            return
        if self.gate.locked():
            await JSONResponse({"detail": "Admission busy; retry later"}, 429,
                               headers={"Retry-After": "5"})(scope, receive, send)
            return
        async with self.gate:
            try:
                application = scope.get("app")
                if ai and application:
                    from server.api.routes.takes import ANALYSIS_TASKS

                    queue = getattr(application.state, "analysis_queue", None)
                    active = sum(not task.done() for task in ANALYSIS_TASKS.values())
                    active += queue.pending_count + bool(queue.active_job_id) if queue else 0
                    if active >= cfg.resource_max_pending_analysis:
                        raise HTTPException(429, "Analysis capacity reached")
                reserve = (cfg.max_upload_size_bytes if path == "/songs/analyze"
                           else cfg.max_recording_size_bytes) if upload else 0
                if self.budget is None:
                    self.budget = AdmissionBudget(cfg)
                await asyncio.to_thread(self.budget.admit, state["session_id"],
                                        (["uploads"] if upload else [])
                                        + (["ai"] if ai or mix else []), reserve)
                if not upload:
                    await self.app(scope, receive, send)
                    return
                # Cap the entire multipart body, including chunked requests, before parsing.
                with tempfile.SpooledTemporaryFile(max_size=1024 * 1024, dir=cfg.data_dir) as body:
                    total = 0
                    started = time.monotonic()
                    while True:
                        if time.monotonic() - started > 120:
                            raise HTTPException(408, "Upload timed out")
                        try:
                            message = await asyncio.wait_for(receive(), timeout=15)
                        except TimeoutError as exc:
                            raise HTTPException(408, "Upload timed out") from exc
                        if message["type"] == "http.disconnect":
                            return
                        chunk = message.get("body", b"")
                        total += len(chunk)
                        if total > reserve + 1024 * 1024:
                            raise HTTPException(413, "Upload request is too large")
                        body.write(chunk)
                        if not message.get("more_body"):
                            break
                    body.seek(0)
                    exhausted = False

                    async def replay():
                        nonlocal exhausted
                        if exhausted:
                            return await receive()
                        chunk = body.read(1024 * 1024)
                        exhausted = body.tell() == total
                        return {"type": "http.request", "body": chunk, "more_body": not exhausted}

                    await self.app(scope, replay, send)
            except HTTPException as exc:
                await JSONResponse({"detail": exc.detail}, exc.status_code,
                                   headers=exc.headers)(scope, receive, send)


async def enforce_audio_duration(path: Path, settings: Settings, *, recording: bool) -> None:
    if not settings.resource_limits_enabled:
        return

    def probe():
        result = subprocess.run(
            [settings.ffprobe_executable, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=15, check=True,
        )
        value = float(result.stdout.strip())
        if not math.isfinite(value) or value <= 0:
            raise ValueError("Invalid duration")
        return value

    try:
        seconds = await asyncio.to_thread(probe)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise HTTPException(415, "Audio duration could not be verified") from exc
    maximum = (settings.resource_max_take_seconds if recording
               else settings.resource_max_song_seconds)
    if seconds > maximum:
        raise HTTPException(413, "Audio duration exceeds configured limit")
