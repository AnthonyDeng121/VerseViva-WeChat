from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from pathlib import Path

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from server.config import get_settings
from server.services import review_login
from server.storage.wechat_store import WeChatIdentityStore

COOKIE_NAME = "verseviva_session"
COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{43}")
SIGNATURE_PATTERN = re.compile(r"[0-9a-f]{64}")


def _load_or_create_secret(data_dir: Path) -> bytes:
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / ".session-secret"
    try:
        value = path.read_bytes()
    except FileNotFoundError:
        value = secrets.token_bytes(32)
        temporary = path.with_name(".session-secret.tmp")
        temporary.write_bytes(value)
        temporary.chmod(0o600)
        try:
            temporary.replace(path)
        except FileExistsError:
            temporary.unlink(missing_ok=True)
            value = path.read_bytes()
    if len(value) < 32:
        raise RuntimeError("Anonymous session secret is invalid")
    return value


class AnonymousSessionMiddleware(BaseHTTPMiddleware):
    """Issue a signed anonymous session and expose only its hash to application code."""

    def __init__(self, app, *, data_dir: Path, secure: bool) -> None:
        super().__init__(app)
        self.secret = _load_or_create_secret(data_dir)
        self.secure = secure

    async def dispatch(self, request: Request, call_next) -> Response:
        authorization = request.headers.get("authorization")
        if authorization is not None:
            settings = get_settings()
            parts = authorization.split()
            owner_id = None
            auth_type = "wechat"
            if settings.wechat_login_enabled and len(parts) == 2 and parts[0].lower() == "bearer":
                owner_id = WeChatIdentityStore(settings.data_dir).resolve(
                    parts[1], settings.wechat_app_id
                )
            if (owner_id is None and review_login.enabled(settings) and len(parts) == 2
                    and parts[0].lower() == "bearer"):
                owner_id = WeChatIdentityStore(settings.data_dir).resolve(
                    parts[1], review_login.namespace(settings)
                )
                auth_type = "review"
            if owner_id is None:
                return JSONResponse(
                    {"detail": "登录已过期或无效，请重新登录。"},
                    status_code=401,
                    headers={"Cache-Control": "no-store", "WWW-Authenticate": "Bearer"},
                )
            # Bearer takes precedence: never replace it with an anonymous Cookie.
            request.state.session_id = owner_id
            request.state.auth_type = auth_type
            response = await call_next(request)
            response.headers["Cache-Control"] = "no-store"
            return response
        raw = request.cookies.get(COOKIE_NAME)
        token = self._valid_token(raw)
        if token is None:
            token = secrets.token_urlsafe(32)
        request.state.session_id = "session_" + hashlib.sha256(token.encode()).hexdigest()
        request.state.auth_type = "web_anonymous"
        response = await call_next(request)
        if request.url.path.startswith(get_settings().api_prefix + "/auth/"):
            return response
        # Re-issue on every response so cookies created before an HTTPS/configuration
        # upgrade acquire the current security attributes without changing identity.
        signature = hmac.new(self.secret, token.encode(), hashlib.sha256).hexdigest()
        response.set_cookie(
            COOKIE_NAME,
            f"{token}.{signature}",
            max_age=COOKIE_MAX_AGE_SECONDS,
            httponly=True,
            secure=self.secure,
            samesite="lax",
            path="/",
        )
        return response

    def _valid_token(self, raw: str | None) -> str | None:
        if not raw or raw.count(".") != 1:
            return None
        token, signature = raw.split(".", 1)
        if TOKEN_PATTERN.fullmatch(token) is None or SIGNATURE_PATTERN.fullmatch(signature) is None:
            return None
        expected = hmac.new(self.secret, token.encode(), hashlib.sha256).hexdigest()
        return token if hmac.compare_digest(signature, expected) else None


def session_id(request: Request) -> str:
    return request.state.session_id
