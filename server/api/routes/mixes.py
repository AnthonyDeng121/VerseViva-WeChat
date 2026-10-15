from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from server.models.mix import MixJob, MixRequest
from server.services.anonymous_session import session_id
from server.services.audio_access import PRIVATE_AUDIO_HEADERS
from server.services.song_access import require_song_access

router = APIRouter()


@router.post("/songs/{song_id}/mix-jobs", response_model=MixJob, status_code=202)
async def start_mix(song_id: str, options: MixRequest, request: Request):
    require_song_access(song_id, request)
    return request.app.state.mix_jobs.start(session_id(request), song_id, options)


@router.get("/mix-jobs/{job_id}", response_model=MixJob)
async def mix_status(job_id: str, request: Request):
    job = request.app.state.mix_jobs.get(job_id, session_id(request))
    require_song_access(job.song_id, request)
    return job


@router.get("/mix-jobs/{job_id}/audio", response_class=FileResponse)
async def mix_audio(job_id: str, request: Request):
    service = request.app.state.mix_jobs
    job = service.get(job_id, session_id(request))
    require_song_access(job.song_id, request)
    if job.status != "ready":
        raise HTTPException(409, "合成音频未就绪或已失效，请重新生成")
    return FileResponse(service.output(job_id), media_type="audio/mpeg",
                        filename="VerseViva-mix.mp3", headers=PRIVATE_AUDIO_HEADERS)
