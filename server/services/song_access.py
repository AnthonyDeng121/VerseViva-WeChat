from fastapi import HTTPException, Request

from server.config import get_settings
from server.services.anonymous_session import session_id
from server.storage.job_store import JobStore

PUBLIC_HERO_SONG_IDS = {
    "song_00000000000000000000000000000003",
    "song_00000000000000000000000000000004",
    "song_00000000000000000000000000000005",
}


def require_song_access(song_id: str, request: Request) -> None:
    if song_id in PUBLIC_HERO_SONG_IDS:
        return
    if not JobStore(get_settings().data_dir).owns_song(song_id, session_id(request)):
        raise HTTPException(status_code=404, detail="Song profile not found")
