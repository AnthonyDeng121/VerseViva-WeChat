import sqlite3
from pathlib import Path

from server.models.practice import (
    LanguageIssueType,
    PhenomenonMemory,
    PracticeAttempt,
    PracticeMemory,
    PracticeStatus,
)


class PracticeStore:
    def __init__(self, data_dir: Path):
        data_dir.mkdir(parents=True, exist_ok=True)
        self.database = data_dir / "verseviva.sqlite3"
        with self._connect() as connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS practice_deletions (take_id TEXT PRIMARY KEY)"
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS practice_attempts (
                    attempt_id TEXT PRIMARY KEY,
                    take_id TEXT NOT NULL UNIQUE,
                    session_id TEXT NOT NULL,
                    song_id TEXT NOT NULL,
                    track_slot_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    payload TEXT NOT NULL
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_attempt_session "
                "ON practice_attempts(session_id, created_at)"
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database)
        connection.row_factory = sqlite3.Row
        return connection

    def save(self, attempt: PracticeAttempt) -> None:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if connection.execute(
                "SELECT 1 FROM practice_deletions WHERE take_id=?", (attempt.take_id,)
            ).fetchone():
                return
            connection.execute(
                """INSERT OR REPLACE INTO practice_attempts
                (attempt_id, take_id, session_id, song_id, track_slot_id, created_at, payload)
                VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    attempt.attempt_id,
                    attempt.take_id,
                    attempt.session_id,
                    attempt.song_id,
                    attempt.track_slot_id,
                    attempt.created_at.isoformat(),
                    attempt.model_dump_json(by_alias=True),
                ),
            )

    def get_for_take(self, take_id: str) -> PracticeAttempt | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM practice_attempts WHERE take_id = ?", (take_id,)
            ).fetchone()
        return PracticeAttempt.model_validate_json(row["payload"]) if row else None

    def delete_for_take(self, take_id: str) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM practice_attempts WHERE take_id = ?", (take_id,))

    def forget_take(self, take_id: str) -> None:
        """Deletion wins over delayed model responses, including synchronous legacy calls."""
        with self._connect() as connection:
            connection.execute("INSERT OR IGNORE INTO practice_deletions VALUES (?)", (take_id,))
            connection.execute("DELETE FROM practice_attempts WHERE take_id=?", (take_id,))

    def get(self, attempt_id: str) -> PracticeAttempt | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM practice_attempts WHERE attempt_id=?", (attempt_id,)
            ).fetchone()
        return PracticeAttempt.model_validate_json(row["payload"]) if row else None

    def delete_for_song(self, song_id: str, session_id: str) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO practice_deletions SELECT take_id FROM practice_attempts "
                "WHERE song_id=? AND session_id=?", (song_id, session_id),
            )
            if connection.execute(
                "SELECT 1 FROM sqlite_master WHERE name='recording_takes'"
            ).fetchone():
                connection.execute(
                    "INSERT OR IGNORE INTO practice_deletions SELECT take_id FROM recording_takes "
                    "WHERE song_id=? AND session_id=?", (song_id, session_id),
                )
            connection.execute(
                "DELETE FROM practice_attempts WHERE song_id = ? AND session_id = ?",
                (song_id, session_id),
            )

    def list_for_session(
        self,
        session_id: str,
        song_id: str | None = None,
    ) -> list[PracticeAttempt]:
        query = "SELECT payload FROM practice_attempts WHERE session_id = ?"
        values: list[str] = [session_id]
        if song_id:
            query += " AND song_id = ?"
            values.append(song_id)
        query += " ORDER BY created_at"
        with self._connect() as connection:
            rows = connection.execute(query, values).fetchall()
        return [PracticeAttempt.model_validate_json(row["payload"]) for row in rows]

    def previous_comparable(self, attempt: PracticeAttempt) -> PracticeAttempt | None:
        candidates = self.list_for_session(attempt.session_id, attempt.song_id)
        comparable = [
            item for item in candidates
            if item.track_slot_id == attempt.track_slot_id and item.attempt_id != attempt.attempt_id
        ]
        return comparable[-1] if comparable else None

    def memory(self, session_id: str) -> PracticeMemory:
        attempts = self.list_for_session(session_id)
        reliable = [item for item in attempts if item.status == PracticeStatus.analyzed]
        recent = reliable[-5:]
        phenomena = []
        for issue_type in LanguageIssueType:
            issue_count = sum(
                any(issue.type == issue_type for issue in item.issues) for item in reliable
            )
            recent_count = sum(
                any(issue.type == issue_type for issue in item.issues) for item in recent
            )
            if issue_count == 0:
                continue
            older = reliable[:-5]
            older_rate = (
                sum(any(issue.type == issue_type for issue in item.issues) for item in older)
                / len(older)
                if older else None
            )
            recent_rate = recent_count / len(recent) if recent else 0
            recent_improvement = any(
                item.comparison.result.value == "improved" for item in recent
            )
            trend = (
                "improving"
                if recent_improvement or (older_rate is not None and recent_rate < older_rate)
                else "stable"
            )
            phenomena.append(
                PhenomenonMemory(
                    issue_type=issue_type,
                    reliable_attempt_count=len(reliable),
                    issue_count=issue_count,
                    recent_issue_count=recent_count,
                    trend=trend,
                    last_practiced_at=reliable[-1].created_at,
                )
            )
        return PracticeMemory(
            session_id=session_id,
            total_attempts=len(attempts),
            reliable_attempts=len(reliable),
            phenomena=phenomena,
            updated_at=attempts[-1].created_at if attempts else None,
        )
