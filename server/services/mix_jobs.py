"""Single-process bounded mix queue; SQLite metadata and private, versioned results."""

import asyncio
import hashlib
import json
import re
import shutil
import sqlite3
import time
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException

from server.models.mix import MixJob, MixRequest
from server.services.mixdown import render_mixdown
from server.storage.take_store import TakeStore


class MixJobs:
    def __init__(self, data_dir: Path, ffmpeg: str):
        self.data_dir = data_dir
        self.ffmpeg = ffmpeg
        self.database = data_dir / "verseviva.sqlite3"
        self.root = data_dir / "mix-previews"
        self.root.mkdir(exist_ok=True)
        self.gate = asyncio.Semaphore(1)
        self.tasks: dict[str, asyncio.Task] = {}
        self.closing = False
        with self.connect() as connection:
            connection.execute("""CREATE TABLE IF NOT EXISTS mix_jobs (
                job_id TEXT PRIMARY KEY, owner TEXT NOT NULL, fingerprint TEXT NOT NULL,
                request TEXT NOT NULL, payload TEXT NOT NULL)""")
            connection.execute("CREATE INDEX IF NOT EXISTS idx_mix_owner ON mix_jobs(owner)")
            for row in connection.execute("SELECT * FROM mix_jobs").fetchall():
                job = MixJob.model_validate_json(row["payload"])
                if job.status in {"queued", "processing"}:
                    job.status = "failed"
                    job.error = "合成任务因服务重启中断，请重新生成。"
                    self.save(connection, job)
                    shutil.rmtree(self.output(job.job_id).parent, ignore_errors=True)

    def connect(self):
        connection = sqlite3.connect(self.database, timeout=10)
        connection.row_factory = sqlite3.Row
        return connection

    @staticmethod
    def save(connection, job):
        connection.execute("UPDATE mix_jobs SET payload = ? WHERE job_id = ?",
                           (job.model_dump_json(by_alias=True), job.job_id))

    def output(self, job_id: str) -> Path:
        return self.root / job_id / "mix.mp3"

    def inputs(self, owner: str, song_id: str, request: MixRequest):
        store = TakeStore(self.data_dir)
        takes = []
        for take_id in request.take_ids:
            take = store.get(take_id)
            if take is None or take.session_id != owner or take.song_id != song_id:
                raise HTTPException(404, "录音不存在或无权访问")
            if not take.is_current:
                raise HTTPException(409, "所选录音已被替换，请刷新后重新选择")
            source = self.data_dir / "takes" / take.take_id / take.stored_filename
            if not source.is_file():
                raise HTTPException(409, "录音文件不可用，请刷新后重试")
            takes.append((take, source))
        bed = self.data_dir / "songs" / song_id / "audio" / "accompaniment.mp3"
        if not bed.is_file():
            bed = bed.with_suffix(".wav")
        if not bed.is_file():
            raise HTTPException(409, "当前歌曲没有可用伴奏")
        start = min(take.selection_start_seconds for take, _ in takes)
        end = max(take.selection_end_seconds for take, _ in takes)
        if end - start > 600:
            raise HTTPException(422, "单次合成范围不能超过 10 分钟")
        # Original files are immutable. Stat changes invalidate even replaced files;
        # metadata snapshots cover every rendering parameter, including mute/offset.
        snapshot = {"version": "mix-v2", "owner": owner, "song": song_id,
                    "options": request.model_dump(),
                    "bed": [bed.name, bed.stat().st_size, bed.stat().st_mtime_ns],
                    "takes": [[take.model_dump(mode="json"), source.stat().st_size,
                               source.stat().st_mtime_ns] for take, source in takes]}
        fingerprint = hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()
        return fingerprint, bed, takes, start, end

    def row(self, job_id: str, owner: str):
        if not re.fullmatch(r"mix_[a-f0-9]{32}", job_id):
            raise HTTPException(404, "合成任务不存在")
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM mix_jobs WHERE job_id = ? AND owner = ?",
                                     (job_id, owner)).fetchone()
        if row is None:
            raise HTTPException(404, "合成任务不存在")
        return row

    def get(self, job_id: str, owner: str) -> MixJob:
        row = self.row(job_id, owner)
        job = MixJob.model_validate_json(row["payload"])
        if job.status not in {"failed", "stale"}:
            try:
                fingerprint, *_ = self.inputs(owner, job.song_id,
                                              MixRequest.model_validate_json(row["request"]))
                valid = fingerprint == row["fingerprint"]
            except (HTTPException, OSError):
                valid = False
            if time.time() - job.created_at > 86400:
                valid = False
            if job.status == "ready" and not self.output(job_id).is_file():
                valid = False
            if not valid:
                job.status = "stale"
                job.error = "录音或参数已改变，或缓存已过期，请重新生成。"
                with self.connect() as connection:
                    self.save(connection, job)
        return job

    def prune(self, owner: str):
        with self.connect() as connection:
            rows = connection.execute("SELECT * FROM mix_jobs WHERE owner = ?", (owner,)).fetchall()
            done = sorted([MixJob.model_validate_json(row["payload"]) for row in rows
                           if row["job_id"] not in self.tasks],
                          key=lambda job: job.created_at, reverse=True)
            for index, job in enumerate(done):
                if index >= 2 or time.time() - job.created_at > 86400:
                    shutil.rmtree(self.output(job.job_id).parent, ignore_errors=True)
                    connection.execute("DELETE FROM mix_jobs WHERE job_id = ?", (job.job_id,))

    def invalidate_take(self, owner: str, take_id: str):
        with self.connect() as connection:
            rows = connection.execute("SELECT * FROM mix_jobs WHERE owner = ?", (owner,)).fetchall()
            for row in rows:
                if take_id not in MixRequest.model_validate_json(row["request"]).take_ids:
                    continue
                job = MixJob.model_validate_json(row["payload"])
                if job.status in {"failed", "stale"}:
                    continue
                queued = job.status == "queued"
                job.status = "stale"
                job.error = "录音已修改或删除，请重新生成。"
                self.save(connection, job)
                if job.job_id not in self.tasks:
                    shutil.rmtree(self.output(job.job_id).parent, ignore_errors=True)
                elif queued:
                    self.tasks[job.job_id].cancel()
                # A running ffmpeg gets no new download authorization. Its output
                # is discarded after the bounded render returns, never published.

    def start(self, owner: str, song_id: str, request: MixRequest) -> MixJob:
        if self.closing:
            raise HTTPException(503, "服务正在重启，请稍后重试")
        fingerprint, bed, takes, start, end = self.inputs(owner, song_id, request)
        with self.connect() as connection:
            rows = connection.execute("SELECT * FROM mix_jobs WHERE owner = ? AND fingerprint = ?",
                                      (owner, fingerprint)).fetchall()
        for row in rows:
            job = self.get(row["job_id"], owner)
            if job.status in {"queued", "processing", "ready"}:
                return job
        if any(self._task_owner(job_id) == owner for job_id in self.tasks) or len(self.tasks) >= 8:
            raise HTTPException(429, "合成队列繁忙，请等待当前任务结束后重试")
        self.prune(owner)
        job = MixJob(job_id=f"mix_{uuid4().hex}", song_id=song_id, status="queued",
                     range_start_seconds=start, range_end_seconds=end, created_at=time.time())
        with self.connect() as connection:
            connection.execute("INSERT INTO mix_jobs VALUES (?, ?, ?, ?, ?)",
                               (job.job_id, owner, fingerprint, request.model_dump_json(),
                                job.model_dump_json(by_alias=True)))
        task = asyncio.create_task(self.run(job, owner, bed, takes, request))
        self.tasks[job.job_id] = task
        task.add_done_callback(lambda _: self.tasks.pop(job.job_id, None))
        return job

    def _task_owner(self, job_id: str):
        with self.connect() as connection:
            return connection.execute("SELECT owner FROM mix_jobs WHERE job_id = ?",
                                      (job_id,)).fetchone()["owner"]

    async def run(self, job: MixJob, owner, bed, takes, request):
        async with self.gate:
            try:
                job = self.get(job.job_id, owner)
                if job.status == "stale":
                    return
                job.status = "processing"
                with self.connect() as connection:
                    self.save(connection, job)
                await asyncio.to_thread(render_mixdown, ffmpeg_executable=self.ffmpeg,
                                        accompaniment=bed, takes=takes,
                                        output=self.output(job.job_id),
                                        accompaniment_volume=request.accompaniment_volume,
                                        voice_volume=request.voice_volume,
                                        master_gain=request.master_gain)
                job = self.get(job.job_id, owner)
                if job.status != "stale":
                    job.status = "ready"
            except Exception:
                job.status = "failed"
                job.error = "合成未完成，请检查音频后重新生成。"
            finally:
                if job.status != "ready":
                    shutil.rmtree(self.output(job.job_id).parent, ignore_errors=True)
                with self.connect() as connection:
                    self.save(connection, job)

    async def stop(self):
        self.closing = True
        # Do not drain up to eight queued 180-second renders during shutdown.
        # Let the one running subprocess finish; mark/cancel only waiting tasks.
        with self.connect() as connection:
            for job_id, task in list(self.tasks.items()):
                row = connection.execute("SELECT payload FROM mix_jobs WHERE job_id = ?",
                                         (job_id,)).fetchone()
                job = MixJob.model_validate_json(row["payload"])
                if job.status == "queued":
                    job.status = "failed"
                    job.error = "合成任务因服务重启中断，请重新生成。"
                    self.save(connection, job)
                    task.cancel()
        if self.tasks:
            await asyncio.gather(*list(self.tasks.values()), return_exceptions=True)
