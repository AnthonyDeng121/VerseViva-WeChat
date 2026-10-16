"""Provision a seven-day review account in the isolated WeChat deployment."""

import os
import secrets
import shutil
import time
from datetime import UTC, datetime
from pathlib import Path

from server.services.review_login import hash_password


def main():
    root = Path("/home/ubuntu/verseviva-wechat")
    env = root / ".env.wechat.v1"
    credentials = root / ".review-account.txt"
    if credentials.exists():
        raise SystemExit("Review account already provisioned; refusing to overwrite")
    backup = root / ".env.wechat.v1.before-review"
    if backup.exists():
        raise SystemExit("Review backup already exists; inspect before retry")
    shutil.copyfile(env, backup)
    backup.chmod(0o600)
    username = "verseviva_review"
    password = secrets.token_urlsafe(18)
    expires = int(time.time()) + 7 * 86400
    lines = [line for line in env.read_text().splitlines()
             if not line.startswith("VERSEVIVA_REVIEW_")]
    lines += ["VERSEVIVA_REVIEW_LOGIN_ENABLED=true",
              f"VERSEVIVA_REVIEW_USERNAME={username}",
              f"VERSEVIVA_REVIEW_PASSWORD_HASH='{hash_password(password)}'",
              f"VERSEVIVA_REVIEW_LOGIN_EXPIRES_AT={expires}"]
    previous_umask = os.umask(0o077)
    try:
        env.write_text("\n".join(lines) + "\n")
        credentials.write_text(
            f"Account: {username}\nPassword: {password}\n"
            f"Expires (UTC): {datetime.fromtimestamp(expires, UTC).isoformat()}\n"
            "Login: Home > Test account login\n"
        )
    finally:
        os.umask(previous_umask)
    env.chmod(0o600)
    credentials.chmod(0o600)
    print("Review account provisioned; credentials saved privately, not logged.")


if __name__ == "__main__":
    main()
