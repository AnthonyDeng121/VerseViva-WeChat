from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from server.config import get_settings
from server.services.anonymous_session import session_id
from server.services.wechat_login import exchange_code, require_wechat_config
from server.storage.wechat_store import WeChatIdentityStore

router = APIRouter()
PRIVATE_HEADERS = {"Cache-Control": "no-store", "Pragma": "no-cache"}


class WeChatLoginInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(min_length=1, max_length=256, pattern=r"^\S+$")


@router.post("/wechat/login")
async def wechat_login(payload: WeChatLoginInput) -> JSONResponse:
    settings = get_settings()
    require_wechat_config(settings)
    openid = await exchange_code(settings, payload.code)
    result = WeChatIdentityStore(settings.data_dir).issue(
        settings.wechat_app_id, openid, settings.wechat_token_ttl_seconds
    )
    return JSONResponse(result, headers=PRIVATE_HEADERS)


@router.get("/me")
async def me(request: Request) -> JSONResponse:
    if getattr(request.state, "auth_type", None) != "wechat":
        raise HTTPException(status_code=401, detail="请先微信登录。")
    return JSONResponse({"ownerId": session_id(request)}, headers=PRIVATE_HEADERS)


@router.post("/logout", status_code=204)
async def logout(request: Request) -> Response:
    if getattr(request.state, "auth_type", None) != "wechat":
        raise HTTPException(status_code=401, detail="请先微信登录。")
    token = request.headers["authorization"].split()[1]
    WeChatIdentityStore(get_settings().data_dir).revoke(token, session_id(request))
    return Response(status_code=204, headers=PRIVATE_HEADERS)
