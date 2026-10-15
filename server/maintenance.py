"""Offline maintenance. No command contacts a server or prints user identities."""

import argparse
import hashlib
import json
import re
import shutil
import sqlite3
import tempfile
import time
import zipfile
from contextlib import closing
from pathlib import Path, PurePosixPath

from server.services.resource_limits import tree_bytes
from server.services.runtime_lock import RuntimeLock


def report(data: Path) -> dict:
    result = {"bytes": tree_bytes(data), "free_bytes": shutil.disk_usage(data).free}
    for name in ("takes", "jobs", "songs", "mix-previews", "mixdowns"):
        root = data / name
        count = sum(p.is_dir() for p in root.iterdir()) if root.exists() else 0
        result[name] = {"bytes": tree_bytes(root), "directories": count}
    database = data / "resource-budgets.sqlite3"
    if database.exists():
        with closing(sqlite3.connect(database)) as db:
            result["admitted_requests_today_utc"] = dict(db.execute(
                "SELECT kind,COUNT(*) FROM admissions WHERE at>=? GROUP BY kind",
                (int(time.time() // 86400) * 86400,)))
    return result


def cleanup(data: Path, *, apply: bool = False, age_hours: float = 24) -> list[str]:
    """Only disposable render files and orphan upload directories, never saved audio."""
    tree_bytes(data)  # Reject links/junctions before any recursive deletion.
    cutoff = time.time() - age_hours * 3600
    known_takes = set()
    db_path = data / "verseviva.sqlite3"
    if db_path.exists():
        with closing(sqlite3.connect(db_path)) as db:
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='recording_takes'").fetchone():
                known_takes = {row[0] for row in db.execute("SELECT take_id FROM recording_takes")}
    candidates = []
    for folder, pattern in (("mix-previews", r"mix_[a-f0-9]{32}"),
                            ("mixdowns", r"mix_[a-f0-9]{32}"),
                            ("takes", r"take_[a-f0-9]{32}"),
                            ("jobs", r"job_[a-f0-9]{32}")):
        for item in (data / folder).glob("*"):
            if not item.is_dir() or not re.fullmatch(pattern, item.name):
                continue
            if folder == "takes" and item.name in known_takes:
                continue
            if folder == "jobs" and (item / "job.json").exists():
                continue
            modified = max([item.stat().st_mtime]
                           + [p.stat().st_mtime for p in item.rglob("*")])
            if modified >= cutoff:
                continue
            target = item.resolve()
            if not target.is_relative_to(data.resolve()) or target == data.resolve():
                raise ValueError("Cleanup target escapes data directory")
            candidates.append(item.relative_to(data).as_posix())
            if apply:
                shutil.rmtree(target)
    return candidates


def backup(data: Path, archive: Path) -> None:
    if archive.resolve().is_relative_to(data.resolve()) or archive.exists():
        raise ValueError("Backup requires a new archive outside the data directory")
    tree_bytes(data)
    archive.parent.mkdir(parents=True, exist_ok=True)
    created = False
    try:
        with tempfile.TemporaryDirectory() as temporary:
            snapshot = Path(temporary)
            manifest = {}
            with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED) as bundle:
                created = True
                archive.chmod(0o600)
                for path in sorted(data.rglob("*")):
                    if not path.is_file() or path.name == ".runtime.lock":
                        continue
                    if path.name.endswith(("-wal", "-shm", "-journal")):
                        continue
                    name = path.relative_to(data).as_posix()
                    source = path
                    if path.suffix == ".sqlite3":
                        source = snapshot / name
                        source.parent.mkdir(parents=True, exist_ok=True)
                        with (closing(sqlite3.connect(path)) as original,
                              closing(sqlite3.connect(source)) as copied):
                            original.backup(copied)
                    with source.open("rb") as content:
                        manifest[name] = hashlib.file_digest(content, "sha256").hexdigest()
                    bundle.write(source, "data/" + name)
                bundle.writestr("manifest.json", json.dumps(manifest, sort_keys=True))
    except BaseException:
        if created:
            archive.unlink(missing_ok=True)
        raise


def restore(archive: Path, target: Path, *, apply: bool = False) -> int:
    if target.exists():
        raise ValueError("Restore target must not exist")
    with zipfile.ZipFile(archive) as bundle:
        members = bundle.infolist()
        names = [item.filename for item in members]
        if len(names) != len(set(names)) or len(names) > 100000:
            raise ValueError("Invalid or duplicate archive entries")
        if sum(item.file_size for item in members) > 100 * 1024**3:
            raise ValueError("Archive exceeds restore size limit")
        if bundle.getinfo("manifest.json").file_size > 8 * 1024 * 1024:
            raise ValueError("Backup manifest exceeds size limit")
        manifest = json.loads(bundle.read("manifest.json"))
        if set(names) != {"manifest.json"} | {"data/" + name for name in manifest}:
            raise ValueError("Archive does not match manifest")
        for name in manifest:
            path = PurePosixPath(name)
            if (not name or "\\" in name or ":" in name or path.is_absolute()
                    or any(part in {"..", "."} for part in name.split("/"))
                    or not all(name.split("/"))):
                raise ValueError("Unsafe archive path")
            item = bundle.getinfo("data/" + name)
            if (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("Linked archive entry")
        # Stage and hash even in dry-run; never extract into an existing user directory.
        parent = target.parent if apply else None
        if apply:
            target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as temporary:
            stage = Path(temporary) / "data"
            stage.mkdir()
            for name, digest in manifest.items():
                destination = stage / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open("data/" + name) as source, destination.open("wb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                with destination.open("rb") as source:
                    if hashlib.file_digest(source, "sha256").hexdigest() != digest:
                        raise ValueError("Backup checksum mismatch")
                if destination.suffix == ".sqlite3":
                    with closing(sqlite3.connect(destination)) as db:
                        if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                            raise ValueError("Invalid SQLite backup")
            if apply:
                stage.rename(target)
                target.chmod(0o700)
    return len(manifest)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["report", "cleanup", "backup", "restore"])
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.command in {"backup", "restore"} and not args.archive:
        parser.error("--archive is required")
    if args.command == "restore":
        result = {"files_verified": restore(args.archive, args.data, apply=args.apply),
                  "applied": args.apply}
    else:
        if not args.data.is_dir():
            parser.error("--data must name an existing data directory")
        with RuntimeLock(args.data):
            if args.command == "report":
                result = report(args.data)
            elif args.command == "cleanup":
                result = {"candidates": cleanup(args.data, apply=args.apply), "applied": args.apply}
            else:
                backup(args.data, args.archive)
                result = {"backup_created": True}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
