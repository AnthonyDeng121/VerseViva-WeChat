from fastapi import APIRouter

from server.api.routes import auth, health, mixes, songs, takes

api_router = APIRouter()
api_router.include_router(auth.router, prefix="/auth", tags=["authentication"])
api_router.include_router(health.router, tags=["system"])
api_router.include_router(songs.router, prefix="/songs", tags=["songs"])
api_router.include_router(takes.router, tags=["recording-takes"])
api_router.include_router(mixes.router, tags=["mix-jobs"])

