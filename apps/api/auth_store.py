"""Persistence for users, refresh sessions, and long-lived secrets.

Lives in the same SQLite file as the task store (see `APP_DATABASE_PATH`) but
owns its own tables. Timestamps that drive expiry are stored as epoch seconds so
comparisons stay integer-exact; ISO strings are only produced at the API edge.
"""

from __future__ import annotations

import sqlite3
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

ROLE_ADMIN = "admin"
ROLE_MEMBER = "member"
ROLE_GUEST = "guest"

JWT_SECRET_NAME = "jwt_secret"


def epoch_to_iso(value: int | None) -> str:
    if not value:
        return ""
    return datetime.fromtimestamp(int(value), tz=UTC).isoformat().replace("+00:00", "Z")


class AuthStore:
    def __init__(self, path: Path) -> None:
        self.path = path.resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    # --- users -----------------------------------------------------------
    def count_users(self) -> int:
        with closing(self._connect()) as connection:
            row = connection.execute("SELECT COUNT(*) AS total FROM users").fetchone()
        return int(row["total"]) if row else 0

    def create_user(
        self,
        *,
        user_id: str,
        username: str,
        display_name: str,
        password_hash: str,
        role: str = ROLE_MEMBER,
        must_change_password: bool = False,
        email: str | None = None,
        now: int | None = None,
    ) -> None:
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """
                INSERT INTO users (
                    user_id, username, display_name, role, password_hash,
                    must_change_password, failed_attempts, locked_until, email
                ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)
                """,
                (
                    user_id,
                    username,
                    display_name,
                    role,
                    password_hash,
                    1 if must_change_password else 0,
                    email,
                ),
            )

    def get_user_by_username(self, username: str) -> dict[str, object] | None:
        return self._one("SELECT * FROM users WHERE username = ? COLLATE NOCASE", (username,))

    def get_user(self, user_id: str) -> dict[str, object] | None:
        return self._one("SELECT * FROM users WHERE user_id = ?", (user_id,))

    def list_users(self) -> list[dict[str, object]]:
        with closing(self._connect()) as connection:
            rows = connection.execute("SELECT * FROM users ORDER BY created_at").fetchall()
        return [dict(row) for row in rows]

    def set_password(self, user_id: str, password_hash: str) -> None:
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """
                UPDATE users
                   SET password_hash = ?, must_change_password = 0, failed_attempts = 0,
                       locked_until = 0
                 WHERE user_id = ?
                """,
                (password_hash, user_id),
            )

    def set_disabled(self, user_id: str, disabled: bool) -> None:
        """停用账号：已有的访问令牌会立刻失效（authenticate 每次都查库）。"""
        with closing(self._connect()) as connection, connection:
            connection.execute(
                "UPDATE users SET disabled = ? WHERE user_id = ?",
                (1 if disabled else 0, user_id),
            )

    def set_role(self, user_id: str, role: str) -> None:
        with closing(self._connect()) as connection, connection:
            connection.execute("UPDATE users SET role = ? WHERE user_id = ?", (role, user_id))

    def mark_login_success(self, user_id: str) -> None:
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """
                UPDATE users
                   SET last_login_at = CURRENT_TIMESTAMP, failed_attempts = 0, locked_until = 0
                 WHERE user_id = ?
                """,
                (user_id,),
            )

    def register_failure(
        self, user_id: str, *, max_failures: int, lockout_seconds: int, now: int
    ) -> None:
        """Count a bad password and lock the account once the threshold is hit."""
        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                "SELECT failed_attempts FROM users WHERE user_id = ?", (user_id,)
            ).fetchone()
            attempts = int(row["failed_attempts"]) + 1 if row else 1
            locked_until = now + lockout_seconds if attempts >= max_failures else 0
            connection.execute(
                "UPDATE users SET failed_attempts = ?, locked_until = ? WHERE user_id = ?",
                (0 if locked_until else attempts, locked_until, user_id),
            )

    # --- refresh sessions -------------------------------------------------
    def insert_refresh(
        self,
        *,
        token_id: str,
        user_id: str,
        token_hash: str,
        issued_at: int,
        expires_at: int,
        ttl_seconds: int = 0,
        user_agent: str = "",
        client_ip: str = "",
    ) -> None:
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """
                INSERT INTO refresh_tokens (
                    token_id, user_id, token_hash, issued_at, expires_at, ttl_seconds,
                    user_agent, client_ip
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    token_id,
                    user_id,
                    token_hash,
                    issued_at,
                    expires_at,
                    int(ttl_seconds),
                    user_agent[:300],
                    client_ip[:64],
                ),
            )

    def get_refresh(self, token_id: str) -> dict[str, object] | None:
        return self._one("SELECT * FROM refresh_tokens WHERE token_id = ?", (token_id,))

    def revoke_refresh(self, token_id: str, *, replaced_by: str | None = None, now: int) -> None:
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """
                UPDATE refresh_tokens
                   SET revoked_at = COALESCE(revoked_at, ?), replaced_by = COALESCE(?, replaced_by)
                 WHERE token_id = ?
                """,
                (now, replaced_by, token_id),
            )

    def revoke_all_refreshes(
        self, user_id: str, *, except_token_id: str | None = None, now: int
    ) -> int:
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                """
                UPDATE refresh_tokens
                   SET revoked_at = ?
                 WHERE user_id = ? AND revoked_at IS NULL AND token_id IS NOT ?
                """,
                (now, user_id, except_token_id),
            )
        return int(cursor.rowcount or 0)

    def list_active_sessions(self, user_id: str, *, now: int) -> list[dict[str, object]]:
        with closing(self._connect()) as connection:
            rows = connection.execute(
                """
                SELECT * FROM refresh_tokens
                 WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
                 ORDER BY issued_at DESC
                """,
                (user_id, now),
            ).fetchall()
        return [dict(row) for row in rows]

    def prune_refreshes(self, *, now: int) -> int:
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                "DELETE FROM refresh_tokens WHERE expires_at < ?", (now,)
            )
        return int(cursor.rowcount or 0)

    # --- secrets ----------------------------------------------------------
    def get_secret(self, name: str) -> str | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT value FROM app_secrets WHERE name = ?", (name,)
            ).fetchone()
        return str(row["value"]) if row else None

    def put_secret(self, name: str, value: str) -> None:
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """
                INSERT INTO app_secrets (name, value) VALUES (?, ?)
                ON CONFLICT(name) DO UPDATE SET value = excluded.value
                """,
                (name, value),
            )

    # --- internals --------------------------------------------------------
    def _one(self, query: str, params: tuple[object, ...]) -> dict[str, object] | None:
        with closing(self._connect()) as connection:
            row = connection.execute(query, params).fetchone()
        return dict(row) if row else None

    # ------------------------------------------------------------ 一次性校验凭据
    # 图形验证码与邮箱验证码共用一张表：只存哈希、有 TTL、计尝试次数、用后标记 consumed。

    def create_challenge(
        self,
        *,
        challenge_id: str,
        kind: str,
        target: str,
        secret_hash: str,
        expires_at: int,
        now: int,
    ) -> None:
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """
                INSERT INTO auth_challenges
                    (challenge_id, kind, target, secret_hash, expires_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (challenge_id, kind, target, secret_hash, expires_at, now),
            )

    def get_challenge(self, challenge_id: str) -> dict[str, object] | None:
        return self._one(
            "SELECT * FROM auth_challenges WHERE challenge_id = ?", (challenge_id,)
        )

    def consume_challenge(self, challenge_id: str, *, now: int) -> None:
        """标记已用 —— 一次性凭据验证通过后必须立刻消费，否则可以被反复重放。"""
        with closing(self._connect()) as connection, connection:
            connection.execute(
                "UPDATE auth_challenges SET consumed_at = ? WHERE challenge_id = ?",
                (now, challenge_id),
            )

    def bump_challenge_attempts(self, challenge_id: str) -> int:
        with closing(self._connect()) as connection, connection:
            connection.execute(
                "UPDATE auth_challenges SET attempts = attempts + 1 WHERE challenge_id = ?",
                (challenge_id,),
            )
            row = connection.execute(
                "SELECT attempts FROM auth_challenges WHERE challenge_id = ?", (challenge_id,)
            ).fetchone()
        return int(row["attempts"]) if row else 0

    def count_recent_challenges(self, *, kind: str, target: str, since: int) -> int:
        with closing(self._connect()) as connection:
            row = connection.execute(
                """
                SELECT COUNT(*) AS total FROM auth_challenges
                WHERE kind = ? AND target = ? AND created_at >= ?
                """,
                (kind, target, since),
            ).fetchone()
        return int(row["total"]) if row else 0

    def last_challenge_at(self, *, kind: str, target: str) -> int:
        with closing(self._connect()) as connection:
            row = connection.execute(
                """
                SELECT MAX(created_at) AS latest FROM auth_challenges
                WHERE kind = ? AND target = ?
                """,
                (kind, target),
            ).fetchone()
        return int(row["latest"] or 0) if row else 0

    def latest_challenge(self, *, kind: str, target: str) -> dict[str, object] | None:
        """最近一条凭据。邮箱验证码没有 challenge_id 交给前端（不该让客户端挑凭据），
        所以注册时按"邮箱 + 最近一条"来校验。"""
        return self._one(
            """
            SELECT * FROM auth_challenges
            WHERE kind = ? AND target = ?
            ORDER BY created_at DESC LIMIT 1
            """,
            (kind, target),
        )

    def prune_challenges(self, *, before: int) -> int:
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                "DELETE FROM auth_challenges WHERE created_at < ?", (before,)
            )
        return cursor.rowcount or 0

    def get_user_by_email(self, email: str) -> dict[str, object] | None:
        return self._one("SELECT * FROM users WHERE email = ? COLLATE NOCASE", (email,))

    def _initialize(self) -> None:
        with closing(self._connect()) as connection, connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    user_id TEXT PRIMARY KEY,
                    username TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'member',
                    password_hash TEXT NOT NULL,
                    must_change_password INTEGER NOT NULL DEFAULT 0,
                    failed_attempts INTEGER NOT NULL DEFAULT 0,
                    locked_until INTEGER NOT NULL DEFAULT 0,
                    disabled INTEGER NOT NULL DEFAULT 0,
                    last_login_at TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    -- 注册时验证过的邮箱；老账号没有，所以允许 NULL。
                    email TEXT
                );
                -- 用户名大小写不敏感地唯一：admin 与 Admin 不能同时存在。
                CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
                    ON users (username COLLATE NOCASE);
                CREATE TABLE IF NOT EXISTS refresh_tokens (
                    token_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    token_hash TEXT NOT NULL,
                    issued_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    -- 轮换时沿用原租约长度，避免"每次刷新都重新计满"把有效期无限放大。
                    ttl_seconds INTEGER NOT NULL DEFAULT 0,
                    revoked_at INTEGER,
                    replaced_by TEXT,
                    user_agent TEXT NOT NULL DEFAULT '',
                    client_ip TEXT NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens (user_id);
                CREATE TABLE IF NOT EXISTS app_secrets (
                    name TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                -- 一次性的校验凭据：图形验证码（captcha）与邮箱验证码（email_code）共用一张表。
                -- 与刷新令牌同样的口径：只存哈希，不存明文；过期、尝试次数、是否已用都在这里管。
                CREATE TABLE IF NOT EXISTS auth_challenges (
                    challenge_id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    target TEXT NOT NULL DEFAULT '',
                    secret_hash TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    expires_at INTEGER NOT NULL,
                    consumed_at INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_challenges_kind_target
                    ON auth_challenges (kind, target, created_at);
                """
            )
            # 这个库没有迁移框架，所以用最朴素的方式补列：老库（缺列）能直接升上来，
            # 新库执行到这里是空操作。加列时请同步更新上面的 CREATE TABLE。
            self._ensure_column(
                connection, "users", "disabled", "disabled INTEGER NOT NULL DEFAULT 0"
            )
            self._ensure_column(connection, "users", "email", "email TEXT")
            # 邮箱唯一索引必须建在补列之后 —— 老库执行上面的 CREATE INDEX 时还没有 email 列，
            # 会直接报 "no such column"。NULL 不参与唯一性，所以老账号共存无碍。
            connection.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email "
                "ON users (email COLLATE NOCASE) WHERE email IS NOT NULL"
            )

    def _ensure_column(
        self, connection: sqlite3.Connection, table: str, column: str, ddl: str
    ) -> None:
        existing = {
            str(row["name"]) for row in connection.execute(f"PRAGMA table_info({table})")
        }
        if column not in existing:
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection
