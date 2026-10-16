"""Explicit, expiring review login; tokens use a separate identity namespace."""

import hashlib
import hmac
import secrets
import time
from collections import deque

from fastapi import HTTPException

from server.config import Settings

_attempts: deque[float] = deque()


def namespace(settings: Settings) -> str:
    return "review:v1:" + settings.wechat_app_id


def enabled(settings: Settings) -> bool:
    return (settings.review_login_enabled and bool(settings.review_username)
            and bool(settings.review_password_hash)
            and settings.review_login_expires_at > time.time())


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000).hex()
    return f"pbkdf2_sha256${salt}${digest}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, salt, expected = encoded.split("$")
        if scheme != "pbkdf2_sha256" or len(salt) != 32 or len(expected) != 64:
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000).hex()
        return hmac.compare_digest(digest, expected)
    except (TypeError, ValueError):
        return False


def admit_attempt() -> None:
    # Global cap across IPs, enforced before expensive password hashing.
    now = time.monotonic()
    while _attempts and _attempts[0] <= now - 60:
        _attempts.popleft()
    if len(_attempts) >= 10:
        raise HTTPException(429, "登录尝试过于频繁，请一分钟后重试。",
                            headers={"Retry-After": "60"})
    _attempts.append(now)
