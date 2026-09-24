"""可插拔执行适配器：把「已审批的动作」真正写出去。

三种适配器，按 `kind` 选择：

* `http`  —— 真实调用外部 HTTP 写接口（域名白名单 + 方法白名单 + SSRF 校验 + 幂等键）
* `file`  —— 真实写本地文件（限定根目录 jail + 敏感文件拒绝 + 写前快照可回滚）
* `database` —— 真实写本应用的 SQLite 表

三件事不变：写入必经审批门禁（由 planner 追加 approval_gate）、每次写入都留回执、
失败只回报失败不假装成功。`simulate` 只在显式 dry_run 时使用，此时回执里
`mode` 会明写 `simulate`，不会冒充真实写入。
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from contextlib import closing
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse

import httpx

from packages.general_agent.net import host_allowed, is_private_host

WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
MAX_RESPONSE_BYTES = 256 * 1024
# 这些文件写坏了会直接让系统不可用或泄露凭据，写入一律拒绝。
DENIED_SUFFIXES = frozenset({".env", ".key", ".pem", ".p12", ".db", ".sqlite", ".sqlite3"})
DENIED_NAMES = frozenset({".env", ".env.local", "nexus.db", "neptune.db"})
SNAPSHOT_TABLE = "external_write_snapshots"


class WriteError(RuntimeError):
    """写入被安全规则拒绝或执行失败。"""


@dataclass(frozen=True)
class WriteRequest:
    kind: str = ""
    # http
    url: str = ""
    method: str = "POST"
    headers: dict[str, str] = field(default_factory=dict)
    body: str = ""
    # file
    path: str = ""
    content: str = ""
    # database
    table: str = "external_writes"
    row: dict[str, object] = field(default_factory=dict)
    # 通用
    idempotency_key: str = ""

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> WriteRequest:
        def text(key: str, default: str = "") -> str:
            value = payload.get(key)
            return str(value) if value is not None else default

        def mapping(key: str) -> dict[str, object]:
            value = payload.get(key)
            return dict(value) if isinstance(value, dict) else {}

        headers = mapping("headers")
        return cls(
            kind=text("kind").strip().lower(),
            url=text("url"),
            method=text("method", "POST").upper(),
            headers={str(k): str(v) for k, v in headers.items()},
            body=text("body"),
            path=text("path"),
            content=text("content"),
            table=text("table", "external_writes") or "external_writes",
            row=mapping("row"),
            idempotency_key=text("idempotency_key"),
        )

    def describe(self) -> str:
        if self.kind == "http":
            return f"{self.method} {self.url}"
        if self.kind == "file":
            return f"写入文件 {self.path}"
        if self.kind == "database":
            return f"写入数据表 {self.table}"
        return "未指定写入目标"


@dataclass(frozen=True)
class WriteReceipt:
    ok: bool
    kind: str
    target: str
    mode: str
    detail: dict[str, object] = field(default_factory=dict)
    error: str = ""
    idempotency_key: str = ""
    duration_ms: int = 0

    def to_dict(self) -> dict[str, object]:
        return {
            "ok": self.ok,
            "kind": self.kind,
            "target": self.target,
            "mode": self.mode,
            "detail": self.detail,
            "error": self.error,
            "idempotency_key": self.idempotency_key,
            "duration_ms": self.duration_ms,
        }


class WriteExecutor:
    """把请求分派到对应适配器。构造参数决定安全边界。"""

    def __init__(
        self,
        project_root: Path,
        database_path: Path | None = None,
        allowed_hosts: tuple[str, ...] = (),
        allow_private_hosts: bool = False,
        timeout_seconds: float = 15.0,
    ) -> None:
        self.project_root = project_root.resolve()
        self.database_path = database_path
        self.allowed_hosts = allowed_hosts
        self.allow_private_hosts = allow_private_hosts
        self.timeout_seconds = timeout_seconds

    def execute(self, request: WriteRequest, *, dry_run: bool = False) -> WriteReceipt:
        started = time.perf_counter()
        if dry_run:
            return WriteReceipt(
                ok=True,
                kind=request.kind,
                target=request.describe(),
                mode="simulate",
                detail={"note": "dry_run 模式，未产生任何写入"},
                idempotency_key=request.idempotency_key,
            )
        try:
            if request.kind == "http":
                detail = self._write_http(request)
            elif request.kind == "file":
                detail = self._write_file(request)
            elif request.kind == "database":
                detail = self._write_database(request)
            else:
                raise WriteError(
                    f"不支持的写入类型：{request.kind or '空'}（可选 http / file / database）"
                )
        except WriteError as exc:
            return WriteReceipt(
                ok=False,
                kind=request.kind,
                target=request.describe(),
                mode="execute",
                error=str(exc),
                idempotency_key=request.idempotency_key,
                duration_ms=int((time.perf_counter() - started) * 1000),
            )
        return WriteReceipt(
            ok=True,
            kind=request.kind,
            target=request.describe(),
            mode="execute",
            detail=detail,
            idempotency_key=request.idempotency_key,
            duration_ms=int((time.perf_counter() - started) * 1000),
        )

    # --- http -----------------------------------------------------------
    def _write_http(self, request: WriteRequest) -> dict[str, object]:
        if not request.url:
            raise WriteError("http 写入缺少 url")
        parsed = urlparse(request.url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise WriteError("写入地址必须是 http(s) 且带主机名")
        if request.method not in WRITE_METHODS:
            raise WriteError(f"不允许的写入方法：{request.method}")
        if not host_allowed(parsed.hostname, self.allowed_hosts):
            raise WriteError(f"主机不在写入白名单内：{parsed.hostname}")
        if not self.allow_private_hosts and is_private_host(parsed.hostname):
            raise WriteError(
                "默认不允许写入内网或本机地址（APP_WRITE_ALLOW_PRIVATE_HOSTS=true 可放开）"
            )

        headers = {"User-Agent": "NeptuneAgent/0.1", **request.headers}
        if request.idempotency_key:
            headers["Idempotency-Key"] = request.idempotency_key
        body: str | None = request.body or None
        content_type = headers.get("Content-Type", "")
        if body and not content_type:
            headers["Content-Type"] = "application/json; charset=utf-8"

        try:
            response = httpx.request(
                request.method,
                request.url,
                headers=headers,
                content=body,
                timeout=self.timeout_seconds,
                follow_redirects=False,
            )
        except httpx.HTTPError as exc:
            raise WriteError(f"写入请求失败：{type(exc).__name__}") from exc

        excerpt = response.text[:MAX_RESPONSE_BYTES]
        detail: dict[str, object] = {
            "status_code": response.status_code,
            "url": str(response.url),
            "response_excerpt": excerpt[:2_000],
            "response_bytes": len(response.content),
        }
        if response.status_code >= 400:
            raise WriteError(f"写入被目标拒绝（HTTP {response.status_code}）：{excerpt[:200]}")
        return detail

    # --- file -----------------------------------------------------------
    def _write_file(self, request: WriteRequest) -> dict[str, object]:
        if not request.path:
            raise WriteError("file 写入缺少 path")
        target = (self.project_root / request.path).resolve()
        if not str(target).startswith(str(self.project_root)):
            raise WriteError("写入路径超出允许的根目录")
        if target.name.lower() in DENIED_NAMES or target.suffix.lower() in DENIED_SUFFIXES:
            raise WriteError(f"拒绝写入敏感文件：{target.name}")
        if target.exists() and not target.is_file():
            raise WriteError("写入目标不是普通文件")

        snapshot_id = ""
        if target.exists():
            snapshot_id = self._snapshot(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        payload = request.content
        target.write_text(payload, encoding="utf-8")
        return {
            "path": str(target.relative_to(self.project_root)).replace("\\", "/"),
            "bytes": len(payload.encode("utf-8")),
            "sha256": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
            "snapshot_id": snapshot_id,
            "overwrote": bool(snapshot_id),
        }

    def _snapshot(self, target: Path) -> str:
        directory = self.project_root / "data" / "snapshots"
        directory.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256(str(target).encode("utf-8")).hexdigest()[:12]
        stamp = datetime.now(UTC).strftime("%Y%m%d%H%M%S")
        snapshot_id = f"{stamp}-{digest}"
        (directory / f"{snapshot_id}.bak").write_bytes(target.read_bytes())
        (directory / f"{snapshot_id}.json").write_text(
            json.dumps(
                {
                    "snapshot_id": snapshot_id,
                    "path": str(target),
                    "created_at": datetime.now(UTC).isoformat(),
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        return snapshot_id

    def restore(self, snapshot_id: str) -> dict[str, object]:
        """按快照回滚一次文件写入。回滚本身也要能被审计。"""
        directory = self.project_root / "data" / "snapshots"
        meta_path = directory / f"{snapshot_id}.json"
        backup = directory / f"{snapshot_id}.bak"
        if not meta_path.exists() or not backup.exists():
            raise WriteError("快照不存在")
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        target = Path(str(meta.get("path", "")))
        if not str(target).startswith(str(self.project_root)):
            raise WriteError("快照指向的路径超出允许的根目录")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(backup.read_bytes())
        return {"snapshot_id": snapshot_id, "restored_path": str(target)}

    # --- database -------------------------------------------------------
    def _write_database(self, request: WriteRequest) -> dict[str, object]:
        if self.database_path is None:
            raise WriteError("未配置数据库路径，无法执行数据库写入")
        table = request.table
        if not table.replace("_", "").isalnum():
            raise WriteError(f"表名只允许字母数字下划线：{table}")
        payload = json.dumps(request.row, ensure_ascii=False, sort_keys=True)
        digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        key = request.idempotency_key or digest[:16]
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.database_path)) as connection, connection:
            connection.execute(
                f"""
                CREATE TABLE IF NOT EXISTS {table} (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            cursor = connection.execute(
                f"INSERT OR IGNORE INTO {table} (idempotency_key, payload) VALUES (?, ?)",
                (key, payload),
            )
            # rowcount 为 0 说明命中了幂等键：这次是被重放的，没有新增行。
            replayed = cursor.rowcount == 0
            row_id = int(cursor.lastrowid or 0)
            if replayed:
                existing = connection.execute(
                    f"SELECT id FROM {table} WHERE idempotency_key = ?", (key,)
                ).fetchone()
                row_id = int(existing[0]) if existing else 0
        return {
            "table": table,
            "row_id": row_id,
            "idempotency_key": key,
            "replayed": replayed,
        }
