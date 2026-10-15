import asyncio
import json
import shutil
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from server.config import get_settings
from server.models.practice import PracticeAttempt, PracticeMemory
from server.models.recording import (
    RecordingSelectionType,
    RecordingTake,
    RecordingTakeUpdate,
    TakePurpose,
    TakeSaveMode,
)
from server.services.anonymous_session import session_id as request_session_id
from server.services.language import supports_language_coaching
from server.services.mixdown import render_mixdown
from server.services.practice.service import analyze_practice_take
from server.storage.practice_store import PracticeStore
from server.storage.profile_store import ProfileStore
from server.storage.take_store import TakeStore

router = APIRouter()
CHUNK_SIZE = 1024 * 1024
ANALYSIS_TASKS: dict[str, asyncio.Task] = {}
ALLOWED_RECORDING_TYPES = {
    ".webm": {"audio/webm", "video/webm", "application/octet-stream"},
    ".mp4": {"audio/mp4", "video/mp4", "application/octet-stream"},
    ".m4a": {"audio/mp4", "audio/x-m4a", "application/octet-stream"},
    ".ogg": {"audio/ogg", "application/ogg", "application/octet-stream"},
    ".wav": {"audio/wav", "audio/x-wav", "application/octet-stream"},
    ".mp3": {"audio/mpeg", "audio/mp3", "application/octet-stream"},
    ".aac": {"audio/aac", "audio/aacp", "audio/x-aac", "application/octet-stream"},
}


def _recording_format(header: bytes) -> tuple[str, str] | None:
    """Identify the stored format from bytes, including WeChat temporary files."""
    if header.startswith(b"\x1aE\xdf\xa3"):
        return ".webm", "audio/webm"
    if len(header) >= 12 and header[4:8] == b"ftyp":
        return ".m4a", "audio/mp4"
    if header.startswith(b"OggS"):
        return ".ogg", "audio/ogg"
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WAVE":
        return ".wav", "audio/wav"
    if (
        len(header) >= 10
        and header[:3] == b"ID3"
        and header[3] in {2, 3, 4}
        and all(value < 128 for value in header[6:10])
    ):
        return ".mp3", "audio/mpeg"
    if len(header) >= 4 and header[0] == 0xFF and header[1] & 0xE0 == 0xE0:
        # MPEG audio: non-reserved version, Layer III, valid bitrate/sample rate.
        if (
            header[1] & 0x18 != 0x08
            and header[1] & 0x06 == 0x02
            and header[2] >> 4 not in {0, 15}
            and header[2] & 0x0C != 0x0C
        ):
            return ".mp3", "audio/mpeg"
        # AAC ADTS uses layer=00; do not mistake its syncword for MPEG audio.
        if len(header) >= 7 and header[1] & 0xF6 == 0xF0:
            sample_rate_index = (header[2] >> 2) & 0x0F
            frame_length = ((header[3] & 0x03) << 11) | (header[4] << 3) | (header[5] >> 5)
            minimum_header = 7 if header[1] & 1 else 9
            if sample_rate_index <= 12 and frame_length >= minimum_header:
                return ".aac", "audio/aac"
    return None


def _parse_sentence_ids(value: str) -> list[str]:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail="sentenceIds must be a JSON array") from exc
    if (
        not isinstance(parsed, list)
        or not parsed
        or not all(isinstance(item, str) for item in parsed)
    ):
        raise HTTPException(status_code=422, detail="sentenceIds must be a non-empty string array")
    if len(parsed) != len(set(parsed)):
        raise HTTPException(status_code=422, detail="sentenceIds must not contain duplicates")
    return parsed


@router.post(
    "/songs/{song_id}/takes",
    response_model=RecordingTake,
    status_code=status.HTTP_201_CREATED,
)
async def upload_take(
    request: Request,
    song_id: str,
    audio: UploadFile = File(...),  # noqa: B008
    session_id: str = Form(...),
    track_slot_id: str = Form(...),
    selection_type: RecordingSelectionType = Form(...),  # noqa: B008
    sentence_ids: str = Form(...),
    selection_start_seconds: float = Form(...),
    selection_end_seconds: float = Form(...),
    timeline_start_seconds: float = Form(...),
    save_mode: TakeSaveMode = Form(...),  # noqa: B008
    purpose: TakePurpose = Form(default=TakePurpose.guided_practice),  # noqa: B008
    vocal_part_id: str | None = Form(default=None),
    client_duration_seconds: float | None = Form(default=None),
    latency_compensation_ms: float = Form(default=0),
    manual_offset_ms: float = Form(default=0),
) -> RecordingTake:
    settings = get_settings()
    session_id = request_session_id(request)
    profile = ProfileStore(settings.data_dir).get(song_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Song profile not found")

    selected_sentence_ids = _parse_sentence_ids(sentence_ids)
    known_sentence_ids = {sentence.id for sentence in profile.sentences}
    if not set(selected_sentence_ids).issubset(known_sentence_ids):
        raise HTTPException(
            status_code=422,
            detail="Recording selection contains unknown sentences",
        )
    if selection_type == RecordingSelectionType.sentence and len(selected_sentence_ids) != 1:
        raise HTTPException(
            status_code=422,
            detail="Single-sentence recording requires one sentence",
        )
    if selection_end_seconds <= selection_start_seconds:
        raise HTTPException(
            status_code=422,
            detail="Recording selection must have a positive interval",
        )
    if selection_end_seconds > profile.duration_seconds + 0.05:
        raise HTTPException(status_code=422, detail="Recording selection exceeds song duration")
    if timeline_start_seconds > profile.duration_seconds:
        raise HTTPException(status_code=422, detail="Timeline start exceeds song duration")
    if vocal_part_id is not None and vocal_part_id not in {part.id for part in profile.vocal_parts}:
        raise HTTPException(status_code=422, detail="Vocal Part does not belong to this song")

    suffix = Path(audio.filename or "").suffix.lower()
    content_type = (
        (audio.content_type or "application/octet-stream").split(";", 1)[0].strip().lower()
    )
    allowed_content_types = set().union(*ALLOWED_RECORDING_TYPES.values())
    if content_type not in allowed_content_types:
        raise HTTPException(
            status_code=415,
            detail="Recordings must be WebM, MP4/M4A, OGG, WAV, MP3, or AAC audio",
        )

    take_id = f"take_{uuid4().hex}"
    take_dir = settings.data_dir / "takes" / take_id
    take_dir.mkdir(parents=True, exist_ok=False)
    # wx.uploadFile may use a .tmp/extensionless name; only bytes determine storage.
    suffix = suffix if suffix in ALLOWED_RECORDING_TYPES else ".upload"
    destination = take_dir / f"original{suffix}"
    size = 0
    header = b""
    try:
        with destination.open("wb") as output:
            while chunk := await audio.read(CHUNK_SIZE):
                if len(header) < 12:
                    header = (header + chunk)[:12]
                size += len(chunk)
                if size > settings.max_recording_size_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail="录音文件过大，请缩短演唱范围后重试（当前上限 100 MB）",
                    )
                output.write(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="Recording is empty")
        detected_format = _recording_format(header)
        if detected_format is None:
            raise HTTPException(
                status_code=415,
                detail="Recording content is not a supported audio container",
            )
        detected_suffix, detected_content_type = detected_format
        if detected_suffix != suffix:
            corrected_destination = take_dir / f"original{detected_suffix}"
            destination.replace(corrected_destination)
            destination = corrected_destination
        content_type = detected_content_type

        existing_takes = TakeStore(settings.data_dir).list_for_song(
            song_id,
            session_id=session_id,
        )
        take = RecordingTake(
            take_id=take_id,
            display_name=f"轨道{len(existing_takes) + 1}",
            session_id=session_id,
            song_id=song_id,
            track_slot_id=track_slot_id,
            selection_type=selection_type,
            sentence_ids=selected_sentence_ids,
            vocal_part_id=vocal_part_id,
            selection_start_seconds=selection_start_seconds,
            selection_end_seconds=selection_end_seconds,
            timeline_start_seconds=timeline_start_seconds,
            save_mode=save_mode,
            purpose=purpose,
            audio_url=f"/api/v1/takes/{take_id}/audio",
            stored_filename=destination.name,
            mime_type=content_type,
            size_bytes=size,
            client_duration_seconds=client_duration_seconds,
            latency_compensation_ms=latency_compensation_ms,
            manual_offset_ms=manual_offset_ms,
        )
        TakeStore(settings.data_dir).add(take)
        return take
    except Exception:
        destination.unlink(missing_ok=True)
        try:
            take_dir.rmdir()
        except OSError:
            pass
        raise


@router.get("/songs/{song_id}/takes", response_model=list[RecordingTake])
async def list_song_takes(
    request: Request,
    song_id: str,
    session_id: str | None = Query(default=None),
) -> list[RecordingTake]:
    settings = get_settings()
    if ProfileStore(settings.data_dir).get(song_id) is None:
        raise HTTPException(status_code=404, detail="Song profile not found")
    return TakeStore(settings.data_dir).list_for_song(
        song_id, session_id=request_session_id(request)
    )


@router.get("/songs/{song_id}/mixdown", response_class=FileResponse)
async def download_song_mixdown(
    request: Request,
    song_id: str,
    session_id: str = Query(...),
    accompaniment_volume: float = Query(default=0.55, ge=0, le=1),
    voice_volume: float = Query(default=1, ge=0, le=1),
) -> FileResponse:
    settings = get_settings()
    profile = ProfileStore(settings.data_dir).get(song_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Song profile not found")
    accompaniment = settings.data_dir / "songs" / song_id / "audio" / "accompaniment.mp3"
    if not accompaniment.is_file():
        accompaniment = accompaniment.with_suffix(".wav")
    if not accompaniment.is_file():
        raise HTTPException(status_code=409, detail="当前歌曲没有可用伴奏")
    takes = TakeStore(settings.data_dir).list_for_song(
        song_id, session_id=request_session_id(request)
    )
    current = [take for take in takes if take.is_current]
    if not current:
        raise HTTPException(status_code=409, detail="当前会话还没有可混音的录音")
    sources = []
    for take in current:
        source = settings.data_dir / "takes" / take.take_id / take.stored_filename
        if not source.is_file():
            raise HTTPException(
                status_code=409,
                detail=f"音轨 {take.display_name} 的录音文件不存在",
            )
        sources.append((take, source))
    output_dir = settings.data_dir / "mixdowns" / f"mix_{uuid4().hex}"
    output = output_dir / "verseviva-mix.mp3"
    try:
        await asyncio.to_thread(
            render_mixdown,
            ffmpeg_executable=settings.ffmpeg_executable,
            accompaniment=accompaniment,
            takes=sources,
            output=output,
            accompaniment_volume=accompaniment_volume,
            voice_volume=voice_volume,
        )
    except (RuntimeError, ValueError) as exc:
        shutil.rmtree(output_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return FileResponse(
        output,
        media_type="audio/mpeg",
        filename=f"{profile.title}-VerseViva整体混音.mp3",
        background=BackgroundTask(shutil.rmtree, output_dir, ignore_errors=True),
    )


@router.get("/takes/{take_id}", response_model=RecordingTake)
async def get_take(take_id: str, request: Request) -> RecordingTake:
    return _owned_take(take_id, request)


@router.patch("/takes/{take_id}", response_model=RecordingTake)
async def update_take(
    take_id: str, update: RecordingTakeUpdate, request: Request
) -> RecordingTake:
    store = TakeStore(get_settings().data_dir)
    take = _owned_take(take_id, request)
    changes = update.model_dump(exclude_none=True)
    updated = take.model_copy(update=changes)
    store.save(updated)
    return updated


@router.delete("/takes/{take_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_take(
    request: Request,
    take_id: str,
    preserve_attempt: bool = Query(default=False),
) -> None:
    settings = get_settings()
    _owned_take(take_id, request)
    take = TakeStore(settings.data_dir).delete(take_id)
    if take is None:
        raise HTTPException(status_code=404, detail="Recording Take not found")
    if not preserve_attempt:
        PracticeStore(settings.data_dir).delete_for_take(take_id)
    take_dir = (settings.data_dir / "takes" / take_id).resolve()
    expected_parent = (settings.data_dir / "takes").resolve()
    if take_dir.parent == expected_parent:
        shutil.rmtree(take_dir, ignore_errors=True)


@router.get("/takes/{take_id}/audio", response_class=FileResponse)
async def get_take_audio(take_id: str, request: Request) -> FileResponse:
    settings = get_settings()
    take = _owned_take(take_id, request)
    source = settings.data_dir / "takes" / take.take_id / take.stored_filename
    if not source.is_file():
        raise HTTPException(status_code=404, detail="Recording audio not found")
    return FileResponse(source, media_type=take.mime_type)


@router.post("/takes/{take_id}/analyze", response_model=PracticeAttempt)
async def analyze_take(take_id: str, request: Request) -> PracticeAttempt:
    settings = get_settings()
    take = _owned_take(take_id, request)
    if take.purpose == TakePurpose.free_overdub:
        raise HTTPException(
            status_code=409,
            detail="清唱叠录仅用于保存与混音，不参与演唱分析或长期记忆",
        )
    profile = ProfileStore(settings.data_dir).get(take.song_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Song profile not found")
    if not supports_language_coaching(profile.language):
        raise HTTPException(
            status_code=409,
            detail="中文歌曲不进行语言现象或练唱分析，可使用纯唱录音与多轨混音",
        )
    source = settings.data_dir / "takes" / take.take_id / take.stored_filename
    if not source.is_file():
        raise HTTPException(status_code=404, detail="Recording audio not found")
    return await analyze_practice_take(settings, take, profile, source)


async def _run_take_analysis(take_id: str) -> None:
    try:
        settings = get_settings()
        take = TakeStore(settings.data_dir).get(take_id)
        if take is None:
            return
        profile = ProfileStore(settings.data_dir).get(take.song_id)
        source = settings.data_dir / "takes" / take.take_id / take.stored_filename
        if profile is not None and source.is_file():
            await analyze_practice_take(settings, take, profile, source)
    finally:
        ANALYSIS_TASKS.pop(take_id, None)


@router.post("/takes/{take_id}/analysis-jobs", status_code=status.HTTP_202_ACCEPTED)
async def start_take_analysis(
    take_id: str, request: Request, force: bool = Query(default=False)
) -> dict:
    settings = get_settings()
    take = _owned_take(take_id, request)
    if take.purpose == TakePurpose.free_overdub:
        raise HTTPException(status_code=409, detail="清唱叠录不参与演唱分析或长期记忆")
    profile = ProfileStore(settings.data_dir).get(take.song_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Song profile not found")
    if not supports_language_coaching(profile.language):
        raise HTTPException(
            status_code=409,
            detail="中文歌曲不进行语言现象或练唱分析，可使用纯唱录音与多轨混音",
        )
    existing = PracticeStore(settings.data_dir).get_for_take(take_id)
    if existing is not None and existing.analysis_version == "practice-language-v6" and not force:
        return {"takeId": take_id, "status": "complete"}
    running = ANALYSIS_TASKS.get(take_id)
    if running is None or running.done():
        if force or existing is not None:
            PracticeStore(settings.data_dir).delete_for_take(take_id)
        ANALYSIS_TASKS[take_id] = asyncio.create_task(_run_take_analysis(take_id))
    return {"takeId": take_id, "status": "processing"}


@router.get("/takes/{take_id}/attempt")
async def get_take_attempt(take_id: str, request: Request):
    _owned_take(take_id, request)
    attempt = PracticeStore(get_settings().data_dir).get_for_take(take_id)
    if attempt is not None:
        return attempt
    if take_id in ANALYSIS_TASKS:
        return {"takeId": take_id, "status": "processing"}
    raise HTTPException(status_code=404, detail="Practice analysis not found")


@router.get("/songs/{song_id}/attempts", response_model=list[PracticeAttempt])
async def list_practice_attempts(
    request: Request,
    song_id: str,
    session_id: str = Query(...),
) -> list[PracticeAttempt]:
    settings = get_settings()
    if ProfileStore(settings.data_dir).get(song_id) is None:
        raise HTTPException(status_code=404, detail="Song profile not found")
    return PracticeStore(settings.data_dir).list_for_session(
        request_session_id(request), song_id
    )


@router.get("/practice/memory", response_model=PracticeMemory)
async def get_practice_memory(
    request: Request, session_id: str = Query(...)
) -> PracticeMemory:
    return PracticeStore(get_settings().data_dir).memory(request_session_id(request))


def _owned_take(take_id: str, request: Request) -> RecordingTake:
    take = TakeStore(get_settings().data_dir).get(take_id)
    if take is None or take.session_id != request_session_id(request):
        raise HTTPException(status_code=404, detail="Recording Take not found")
    return take
