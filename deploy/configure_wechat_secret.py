"""Prompt locally on the server; never pass a secret in command arguments."""

import getpass
import os
import sys
import tempfile
from pathlib import Path


def main() -> None:
    if not sys.stdin.isatty():
        raise SystemExit("Run this script in an interactive server terminal; input must be hidden.")
    target = Path(__file__).resolve().parent.parent / ".env.wechat"
    if not target.is_file():
        raise SystemExit("Missing .env.wechat; prepare the server configuration first.")
    secret = getpass.getpass("WeChat AppSecret (hidden): ").strip()
    if not secret or not secret.isascii() or not secret.isalnum():
        raise SystemExit("Invalid secret format; configuration was not changed.")
    confirm = getpass.getpass("Repeat AppSecret (hidden): ").strip()
    if secret != confirm:
        raise SystemExit("Values differ; configuration was not changed.")
    key = "VERSEVIVA_WECHAT_APP_SECRET="
    lines = target.read_text(encoding="utf-8").splitlines()
    lines = [line for line in lines if not line.startswith(key)]
    lines.append(key + secret)
    descriptor, name = tempfile.mkstemp(prefix=".wechat-env-", dir=target.parent)
    try:
        os.chmod(name, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
            output.write("\n".join(lines) + "\n")
        os.replace(name, target)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    print("AppSecret saved with restricted file permissions; value not displayed.")


if __name__ == "__main__":
    main()
