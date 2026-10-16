import asyncio
import hmac
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from server.config import get_settings
from server.services import review_login
from server.services.anonymous_session import session_id
from server.services.wechat_login import exchange_code, require_wechat_config
from server.storage.wechat_store import WeChatIdentityStore

router = APIRouter()
PRIVATE_HEADERS = {"Cache-Control": "no-store", "Pragma": "no-cache"}


class WeChatLoginInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(min_length=1, max_length=256, pattern=r"^\S+$")


class ReviewLoginInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128, repr=False)


@router.post("/review/login")
async def reviewer_login(payload: ReviewLoginInput) -> JSONResponse:
    settings = get_settings()
    if not review_login.enabled(settings):
        raise HTTPException(404, "测试账号登录未开放或已到期。")
    review_login.admit_attempt()
    valid_password = await asyncio.to_thread(
        review_login.verify_password, payload.password,
        settings.review_password_hash.get_secret_value(),
    )
    if not (hmac.compare_digest(payload.username.encode(), settings.review_username.encode())
            and valid_password):
        raise HTTPException(401, "测试账号或密码错误。")
    ttl = min(settings.wechat_token_ttl_seconds,
              settings.review_login_expires_at - int(time.time()))
    if ttl < 1:
        raise HTTPException(401, "测试账号已到期。")
    result = WeChatIdentityStore(settings.data_dir).issue(
        review_login.namespace(settings), settings.review_username, ttl,
    )
    return JSONResponse(result, headers=PRIVATE_HEADERS)


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
    if getattr(request.state, "auth_type", None) not in {"wechat", "review"}:
        raise HTTPException(status_code=401, detail="请先微信登录。")
    return JSONResponse({"ownerId": session_id(request)}, headers=PRIVATE_HEADERS)


@router.post("/logout", status_code=204)
async def logout(request: Request) -> Response:
    if getattr(request.state, "auth_type", None) not in {"wechat", "review"}:
        raise HTTPException(status_code=401, detail="请先微信登录。")
    token = request.headers["authorization"].split()[1]
    WeChatIdentityStore(get_settings().data_dir).revoke(token, session_id(request))
    return Response(status_code=204, headers=PRIVATE_HEADERS)
