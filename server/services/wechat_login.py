import logging

import httpx
from fastapi import HTTPException

from server.config import Settings

CODE2SESSION_URL = "https://api.weixin.qq.com/sns/jscode2session"


class _HideCodeExchangeUrl(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        # httpx INFO normally includes the query URL, which contains AppSecret/code.
        if "jscode2session" in record.getMessage():
            record.msg = "WeChat login exchange (credentials omitted)"
            record.args = ()
        return True


logging.getLogger("httpx").addFilter(_HideCodeExchangeUrl())


def require_wechat_config(settings: Settings) -> None:
    if (
        not settings.wechat_login_enabled
        or not settings.wechat_app_id.strip()
        or not settings.wechat_app_secret
        or not settings.wechat_app_secret.get_secret_value().strip()
    ):
        raise HTTPException(status_code=503, detail="微信登录服务尚未配置，请稍后再试。")


async def exchange_code(settings: Settings, code: str) -> str:
    require_wechat_config(settings)
    try:
        async with httpx.AsyncClient(
            timeout=settings.wechat_login_timeout_seconds, follow_redirects=False
        ) as client:
            response = await client.get(
                CODE2SESSION_URL,
                params={
                    "appid": settings.wechat_app_id,
                    "secret": settings.wechat_app_secret.get_secret_value(),
                    "js_code": code,
                    "grant_type": "authorization_code",
                },
            )
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError):
        # No raw provider payload, request URL, code or chained exception in errors.
        raise HTTPException(status_code=502, detail="微信登录暂时不可用，请重新尝试。") from None
    if not isinstance(payload, dict):
        raise HTTPException(status_code=502, detail="微信登录暂时不可用，请重新尝试。")
    error = payload.get("errcode", 0)
    if not isinstance(error, int):
        raise HTTPException(status_code=502, detail="微信登录返回异常，请重新尝试。")
    if error in {40029, 40163, 40226}:
        raise HTTPException(status_code=401, detail="微信登录凭证已失效，请重新登录。")
    if error == 45011:
        raise HTTPException(status_code=429, detail="微信登录过于频繁，请稍后再试。")
    if error:
        raise HTTPException(status_code=502, detail="微信登录暂时不可用，请重新尝试。")
    openid, session_key = payload.get("openid"), payload.get("session_key")
    if (
        not isinstance(openid, str)
        or not 1 <= len(openid) <= 256
        or not isinstance(session_key, str)
        or not session_key
    ):
        raise HTTPException(status_code=502, detail="微信登录返回异常，请重新尝试。")
    # session_key is unused: do not persist or send it to the client.
    return openid
