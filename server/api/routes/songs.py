import shutil
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse

from server.config import get_settings
from server.models.song import AnalysisJob, AnalysisStage, AnalysisStatus, SongProfile
from server.pipelines.song_analysis import build_default_pipeline
from server.services.anonymous_session import session_id
from server.services.language import add_pronunciation_guides
from server.services.song_access import PUBLIC_HERO_SONG_IDS
from server.services.song_access import require_song_access as _require_song_access
from server.storage.job_store import JobStore
from server.storage.practice_store import PracticeStore
from server.storage.profile_store import ProfileStore
from server.storage.take_store import TakeStore

router = APIRouter()
CHUNK_SIZE = 1024 * 1024
ALLOWED_CONTENT_TYPES = {
    ".mp3": {"audio/mpeg", "audio/mp3", "application/octet-stream"},
    ".wav": {"audio/wav", "audio/x-wav", "application/octet-stream"},
    ".flac": {"audio/flac", "audio/x-flac", "application/octet-stream"},
}


def has_expected_audio_signature(suffix: str, header: bytes) -> bool:
    if suffix == ".mp3":
        return header.startswith(b"ID3") or (
            len(header) >= 2 and header[0] == 0xFF and header[1] & 0xE0 == 0xE0
        )
    if suffix == ".wav":
        return len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WAVE"
    if suffix == ".flac":
        return header.startswith(b"fLaC")
    return False


@router.post("/analyze", response_model=AnalysisJob, status_code=status.HTTP_202_ACCEPTED)
async def analyze_song(
    request: Request,
    audio: UploadFile = File(...),  # noqa: B008
    title: str = Form(...),
    artist: str = Form(...),
    lyrics: str | None = Form(default=None),
) -> AnalysisJob:
    if not title.strip() or not artist.strip():
        raise HTTPException(status_code=422, detail="Song title and artist are required")
    suffix = Path(audio.filename or "").suffix.lower()
    expected_content_types = ALLOWED_CONTENT_TYPES.get(suffix)
    if expected_content_types is None or audio.content_type not in expected_content_types:
        raise HTTPException(status_code=415, detail="Only MP3, WAV, and FLAC audio is supported")

    settings = get_settings()
    song_id = f"song_{uuid4().hex}"
    job_id = f"job_{uuid4().hex}"
    job_dir = settings.data_dir / "jobs" / job_id
    input_dir = job_dir / "input"
    destination = input_dir / f"source{suffix}"
    input_dir.mkdir(parents=True, exist_ok=False)

    size = 0
    header = b""
    try:
        with destination.open("wb") as output:
            while chunk := await audio.read(CHUNK_SIZE):
                if not header:
                    header = chunk[:12]
                size += len(chunk)
                if size > settings.max_upload_size_bytes:
                    raise HTTPException(status_code=413, detail="Audio file is too large")
                output.write(chunk)

        if size == 0:
            raise HTTPException(status_code=400, detail="Audio file is empty")
        if not has_expected_audio_signature(suffix, header):
            raise HTTPException(
                status_code=415,
                detail="File content does not match its audio extension",
            )
    except Exception:
        destination.unlink(missing_ok=True)
        input_dir.rmdir()
        job_dir.rmdir()
        raise

    # The worker pipeline will update this persisted state in the next milestone.
    inferred_title, inferred_artist = _infer_song_identity(
        filename=audio.filename or "Untitled",
        title=title,
        artist=artist,
    )
    job = AnalysisJob(
        job_id=job_id,
        song_id=song_id,
        status=AnalysisStatus.queued,
        title=inferred_title,
        artist=inferred_artist,
        has_lyrics=bool(lyrics and lyrics.strip()),
        session_id=session_id(request),
    )
    JobStore(settings.data_dir).save(job)
    if lyrics and lyrics.strip():
        (input_dir / "lyrics.txt").write_text(lyrics.strip(), encoding="utf-8")
    if settings.auto_run_analysis_pipeline:
        await request.app.state.analysis_queue.enqueue(
            job.job_id,
            destination,
            build_default_pipeline(settings).run,
        )
    return _with_queue_position(job, request)


def _infer_song_identity(
    *, filename: str, title: str | None, artist: str | None
) -> tuple[str, str | None]:
    clean_title = title.strip() if title and title.strip() else None
    clean_artist = artist.strip() if artist and artist.strip() else None
    stem = Path(filename).stem.strip() or "Untitled"
    if clean_title:
        return clean_title, clean_artist
    if " - " in stem:
        inferred_artist, inferred_title = stem.split(" - ", maxsplit=1)
        return inferred_title.strip() or stem, clean_artist or inferred_artist.strip() or None
    return stem, clean_artist


@router.get("/jobs/latest", response_model=AnalysisJob)
async def get_latest_analysis_job(request: Request) -> AnalysisJob:
    job = JobStore(get_settings().data_dir).latest(session_id(request))
    if job is None:
        raise HTTPException(status_code=404, detail="No analysis jobs found")
    return _with_queue_position(job, request)


@router.get("/jobs/{job_id}", response_model=AnalysisJob)
async def get_analysis_job(job_id: str, request: Request) -> AnalysisJob:
    job = JobStore(get_settings().data_dir).get(job_id)
    if job is None or job.session_id != session_id(request):
        raise HTTPException(status_code=404, detail="Analysis job not found")
    return _with_queue_position(job, request)


@router.post(
    "/jobs/{job_id}/retry",
    response_model=AnalysisJob,
    status_code=status.HTTP_202_ACCEPTED,
)
async def retry_analysis_job(job_id: str, request: Request) -> AnalysisJob:
    settings = get_settings()
    store = JobStore(settings.data_dir)
    job = store.get(job_id)
    if job is None or job.session_id != session_id(request):
        raise HTTPException(status_code=404, detail="Analysis job not found")
    if job.status != AnalysisStatus.failed:
        raise HTTPException(status_code=409, detail="Only failed analysis jobs can be retried")

    input_dir = settings.data_dir / "jobs" / job_id / "input"
    sources = [
        path
        for suffix in ALLOWED_CONTENT_TYPES
        if (path := input_dir / f"source{suffix}").is_file()
    ]
    if len(sources) != 1:
        raise HTTPException(status_code=409, detail="Original audio is missing or ambiguous")

    previous_stage = job.error.stage if job.error else AnalysisStage.queued
    job.status = AnalysisStatus.queued
    job.stage = previous_stage
    job.error = None
    store.save(job)
    await request.app.state.analysis_queue.enqueue(
        job.job_id,
        sources[0],
        build_default_pipeline(settings).run,
    )
    return _with_queue_position(job, request)


@router.delete("/jobs/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_analysis_job(job_id: str, request: Request) -> None:
    settings = get_settings()
    owner_session = session_id(request)
    store = JobStore(settings.data_dir)
    job = store.get(job_id)
    if job is None or job.session_id != owner_session:
        raise HTTPException(status_code=404, detail="Analysis job not found")
    if job.status not in {AnalysisStatus.queued, AnalysisStatus.processing}:
        raise HTTPException(status_code=409, detail="Analysis job is no longer running")
    if not await request.app.state.analysis_queue.cancel(job_id):
        raise HTTPException(status_code=409, detail="Analysis job is no longer running")
    _delete_song_data(settings.data_dir, job, owner_session)


@router.post(
    "/{song_id}/reanalyze",
    response_model=AnalysisJob,
    status_code=status.HTTP_202_ACCEPTED,
)
async def reanalyze_song(song_id: str, request: Request) -> AnalysisJob:
    if song_id in PUBLIC_HERO_SONG_IDS:
        raise HTTPException(status_code=409, detail="Hero songs cannot be reanalyzed here")
    settings = get_settings()
    store = JobStore(settings.data_dir)
    job = store.for_song(song_id, session_id(request))
    if job is None:
        raise HTTPException(status_code=404, detail="Song profile not found")
    if job.status in {AnalysisStatus.queued, AnalysisStatus.processing}:
        raise HTTPException(status_code=409, detail="Song analysis is already running")
    input_dir = settings.data_dir / "jobs" / job.job_id / "input"
    sources = [
        path
        for suffix in ALLOWED_CONTENT_TYPES
        if (path := input_dir / f"source{suffix}").is_file()
    ]
    if len(sources) != 1:
        raise HTTPException(status_code=409, detail="Original audio is missing or ambiguous")

    job_dir = settings.data_dir / "jobs" / job.job_id
    for child in job_dir.iterdir():
        if child.name in {"input", "job.json"}:
            continue
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
        else:
            child.unlink(missing_ok=True)
    shutil.rmtree(settings.data_dir / "songs" / song_id, ignore_errors=True)
    job.status = AnalysisStatus.queued
    job.stage = AnalysisStage.queued
    job.progress = 0
    job.error = None
    job.warnings = []
    job.audio_duration_seconds = None
    job.estimated_total_seconds = None
    job.estimated_remaining_seconds = None
    job.api_call_count = 0
    job.stage_runtimes = []
    job.attempt_count += 1
    store.save(job)
    await request.app.state.analysis_queue.enqueue(
        job.job_id,
        sources[0],
        build_default_pipeline(settings).run,
    )
    return _with_queue_position(job, request)


@router.delete("/{song_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_song(song_id: str, request: Request) -> None:
    if song_id in PUBLIC_HERO_SONG_IDS:
        raise HTTPException(status_code=409, detail="Hero songs cannot be deleted")
    settings = get_settings()
    owner_session = session_id(request)
    job_store = JobStore(settings.data_dir)
    job = job_store.for_song(song_id, owner_session)
    if job is None:
        raise HTTPException(status_code=404, detail="Song profile not found")
    if job.status in {AnalysisStatus.queued, AnalysisStatus.processing}:
        raise HTTPException(status_code=409, detail="Song analysis is still running")

    _delete_song_data(settings.data_dir, job, owner_session)


@router.get("/{song_id}", response_model=SongProfile)
async def get_song_profile(song_id: str, request: Request) -> SongProfile:
    _require_song_access(song_id, request)
    store = ProfileStore(get_settings().data_dir)
    profile = store.get(song_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Song profile not found")
    if profile.language in {"ja", "ko"} and any(
        sentence.pronunciation is None
        or sentence.pronunciation.text.strip() == sentence.lyrics.strip()
        for sentence in profile.sentences
    ):
        upgraded = add_pronunciation_guides(profile.sentences, profile.language)
        profile = profile.model_copy(update={"sentences": upgraded})
        store.save(profile)
    return profile


@router.get("/{song_id}/audio/{asset}", response_class=FileResponse)
async def get_song_audio(song_id: str, asset: str, request: Request) -> FileResponse:
    _require_song_access(song_id, request)
    settings = get_settings()
    profile = ProfileStore(settings.data_dir).get(song_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Song profile not found")

    audio_dir = settings.data_dir / "songs" / song_id / "audio"
    if asset == "vocals":
        compact = audio_dir / "vocals.mp3"
        source = compact if compact.is_file() else audio_dir / "vocals.wav"
    elif asset == "accompaniment":
        compact = audio_dir / "accompaniment.mp3"
        source = compact if compact.is_file() else audio_dir / "accompaniment.wav"
    elif asset == "source":
        matches = sorted(audio_dir.glob("source.*"))
        source = matches[0] if matches else audio_dir / "source"
    else:
        raise HTTPException(status_code=404, detail="Audio asset not found")
    if not source.is_file():
        raise HTTPException(status_code=404, detail="Audio asset not found")
    return FileResponse(source)


def _with_queue_position(job: AnalysisJob, request: Request) -> AnalysisJob:
    queue = request.app.state.analysis_queue
    return job.model_copy(update={"queue_position": queue.position(job.job_id)})


def _delete_song_data(data_dir: Path, job: AnalysisJob, owner_session: str) -> None:
    take_store = TakeStore(data_dir)
    takes = take_store.list_for_song(job.song_id, session_id=owner_session)
    PracticeStore(data_dir).delete_for_song(job.song_id, owner_session)
    for take in takes:
        take_store.delete(take.take_id)
        shutil.rmtree(data_dir / "takes" / take.take_id, ignore_errors=True)
    shutil.rmtree(data_dir / "songs" / job.song_id, ignore_errors=True)
    JobStore(data_dir).delete(job.job_id)
