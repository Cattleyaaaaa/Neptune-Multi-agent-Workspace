import json
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import cast

from packages.general_agent.state import GeneralTaskState


def to_iso_timestamp(value: object) -> str:
    """SQLite's CURRENT_TIMESTAMP is UTC and space separated, which JavaScript
    would otherwise read as local time. Normalise it to a real ISO-8601 stamp."""
    text = str(value) if value else ""
    return f"{text.replace(' ', 'T')}Z" if text else ""


class TaskStore:
    def __init__(self, path: Path) -> None:
        self.path = path.resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def save_task(self, state: GeneralTaskState, owner_id: str | None = None) -> str:
        """Persist a task and return the timestamp the database recorded.

        `owner_id` 只在创建时给；后续更新不传时用 COALESCE 保留原值，
        否则每次 _persist 都会把归属抹成 NULL。
        """
        # The timestamp is owned by the database, so it must not be baked into
        # the payload that gets replayed on the next write.
        payload = json.dumps(
            {key: value for key, value in state.items() if key != "updated_at"},
            ensure_ascii=False,
        )
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """
                INSERT INTO tasks (task_id, payload, owner_id, updated_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(task_id) DO UPDATE SET
                    payload = excluded.payload,
                    owner_id = COALESCE(excluded.owner_id, tasks.owner_id),
                    updated_at = CURRENT_TIMESTAMP
                """,
                (state["task_id"], payload, owner_id),
            )
            row = connection.execute(
                "SELECT updated_at FROM tasks WHERE task_id = ?", (state["task_id"],)
            ).fetchone()
        return to_iso_timestamp(row["updated_at"]) if row else ""

    def load_tasks(self) -> dict[str, GeneralTaskState]:
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT task_id, payload, updated_at FROM tasks ORDER BY updated_at"
            ).fetchall()
        return {
            row["task_id"]: cast(
                GeneralTaskState,
                {**json.loads(row["payload"]), "updated_at": to_iso_timestamp(row["updated_at"])},
            )
            for row in rows
        }

    def load_task_owners(self) -> dict[str, str | None]:
        """任务 → 归属人。NULL 表示历史数据（改造前创建的），按"无归属"处理。"""
        with closing(self._connect()) as connection:
            rows = connection.execute("SELECT task_id, owner_id FROM tasks").fetchall()
        return {row["task_id"]: row["owner_id"] for row in rows}

    def append_event(self, task_id: str, name: str, data: dict[str, object]) -> None:
        with closing(self._connect()) as connection, connection:
            sequence = connection.execute(
                "SELECT COALESCE(MAX(sequence), 0) + 1 FROM events WHERE task_id = ?",
                (task_id,),
            ).fetchone()[0]
            connection.execute(
                "INSERT INTO events (task_id, sequence, name, data) VALUES (?, ?, ?, ?)",
                (task_id, sequence, name, json.dumps(data, ensure_ascii=False)),
            )

    def load_events(self) -> dict[str, list[dict[str, object]]]:
        result: dict[str, list[dict[str, object]]] = {}
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT task_id, name, data FROM events ORDER BY task_id, sequence"
            ).fetchall()
        for row in rows:
            result.setdefault(row["task_id"], []).append(
                {"event": row["name"], "data": json.loads(row["data"])}
            )
        return result

    def load_workspace(self) -> dict[str, object] | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT payload FROM workspace_config WHERE id = 1"
            ).fetchone()
        return json.loads(row["payload"]) if row else None

    def save_workspace(self, payload: dict[str, object]) -> None:
        serialized = json.dumps(payload, ensure_ascii=False)
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """
                INSERT INTO workspace_config (id, payload, updated_at)
                VALUES (1, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(id) DO UPDATE SET
                    payload = excluded.payload,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (serialized,),
            )

    def _initialize(self) -> None:
        with closing(self._connect()) as connection, connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS tasks (
                    task_id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS events (
                    task_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    data TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (task_id, sequence)
                );
                CREATE TABLE IF NOT EXISTS workspace_config (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    payload TEXT NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                """
            )
            # 迁移：老库的 tasks 表没有 owner_id，补上后历史任务为 NULL。
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(tasks)")}
            if "owner_id" not in columns:
                connection.execute("ALTER TABLE tasks ADD COLUMN owner_id TEXT")

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection
