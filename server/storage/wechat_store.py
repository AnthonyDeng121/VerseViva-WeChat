import hashlib
import re
import secrets
import sqlite3
import time
from pathlib import Path
from uuid import uuid4

TOKEN_PATTERN = re.compile(r"vwx1\.[A-Za-z0-9_-]{43}")


def now_seconds() -> int:
    return int(time.time())


class WeChatIdentityStore:
    """Stable owners and revocable opaque tokens, without raw OpenID/session_key."""

    def __init__(self, data_dir: Path):
        data_dir.mkdir(parents=True, exist_ok=True)
        self.database = data_dir / "verseviva.sqlite3"
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS wechat_identities (
                    identity_hash TEXT PRIMARY KEY,
                    app_id TEXT NOT NULL,
                    owner_id TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS wechat_tokens (
                    token_hash TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL REFERENCES wechat_identities(owner_id),
                    app_id TEXT NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_wechat_token_expiry
                ON wechat_tokens(expires_at);
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    @staticmethod
    def token_hash(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def issue(self, app_id: str, openid: str, ttl_seconds: int) -> dict:
        identity_hash = hashlib.sha256(f"{app_id}\0{openid}".encode()).hexdigest()
        now = now_seconds()
        token = "vwx1." + secrets.token_urlsafe(32)
        expires_at = now + ttl_seconds
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "INSERT OR IGNORE INTO wechat_identities VALUES (?, ?, ?, ?)",
                (identity_hash, app_id, "wxuser_" + uuid4().hex, now),
            )
            owner_id = connection.execute(
                "SELECT owner_id FROM wechat_identities WHERE identity_hash = ?",
                (identity_hash,),
            ).fetchone()["owner_id"]
            connection.execute("DELETE FROM wechat_tokens WHERE expires_at <= ?", (now,))
            connection.execute(
                "INSERT INTO wechat_tokens VALUES (?, ?, ?, ?)",
                (self.token_hash(token), owner_id, app_id, expires_at),
            )
        return {
            "ownerId": owner_id,
            "accessToken": token,
            "expiresAtMs": expires_at * 1000,
            "tokenType": "Bearer",
        }

    def resolve(self, token: str, app_id: str) -> str | None:
        if TOKEN_PATTERN.fullmatch(token) is None:
            return None
        with self._connect() as connection:
            row = connection.execute(
                "SELECT owner_id FROM wechat_tokens "
                "WHERE token_hash = ? AND app_id = ? AND expires_at > ?",
                (self.token_hash(token), app_id, now_seconds()),
            ).fetchone()
        return row["owner_id"] if row else None

    def revoke(self, token: str, owner_id: str) -> None:
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM wechat_tokens WHERE token_hash = ? AND owner_id = ?",
                (self.token_hash(token), owner_id),
            )
