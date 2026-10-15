from fastapi import APIRouter
from fastapi.responses import JSONResponse

from server.config import get_settings
from server.services.privacy_facts import processing_facts

router = APIRouter()


@router.get("/privacy/facts")
async def privacy_facts() -> JSONResponse:
    return JSONResponse(processing_facts(get_settings()), headers={"Cache-Control": "no-store"})
