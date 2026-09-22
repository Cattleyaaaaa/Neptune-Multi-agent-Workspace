"""MCP 中心：保存 MCP 服务器配置，并对 HTTP 端点做**真实的 MCP 握手**。

三件事必须说清楚，否则这个页面就是一个"配置抽屉"：

* 「测试连接」不是 ping。它按 MCP Streamable HTTP 传输发起 `initialize`，
  再调 `tools/list`，把服务端自报的名字/版本与工具清单存下来 —— 工具清单一列
  是真的从服务端读回来的，不是我们在种子数据里编的。
* `stdio` 与 `sse` 传输**不做探测**：前者要在服务器上拉起子进程（本机安全边界不允许
  由 HTTP 接口触发），后者的传输方式不同。它们的配置照旧保存，状态如实标成
  "仅保存配置"。
* 本机部署最常见的就是连 `http://127.0.0.1:xxxx`，所以默认允许内网/回环地址；
  想收紧就设 `APP_MCP_ALLOW_PRIVATE_ENDPOINTS=false`，那会挡住回环与私有网段。
"""

from __future__ import annotations

import json
import secrets
import socket
import sqlite3
import time
from contextlib import closing
from dataclasses import dataclass
from ipaddress import ip_address
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Response, status

from apps.api.auth import Account, current_user
from apps.api.settings import settings
from packages.contracts.models import McpServerDraft, McpServerView

PROBE_TIMEOUT_SECONDS = 8.0
# 探测回来的响应体上限：MCP 服务端返回超大 JSON 时不要把它读进内存
MAX_PROBE_BYTES = 512 * 1024
CLIENT_INFO = {"name": "nexus-agent", "version": "0.1.0"}
PROTOCOL_VERSION = "2025-06-18"

PROBE_NEVER = "never"
PROBE_OK = "ok"
PROBE_FAILED = "failed"
PROBE_UNSUPPORTED = "unsupported"


class McpError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class ProbeResult:
    status: str
    detail: str
    server_name: str = ""
    server_version: str = ""
    tools: list[dict[str, object]] | None = None
    latency_ms: int = 0


def is_private_host(host: str) -> bool:
    """回环 / 私有网段 / 链路本地都算内网。解析失败时按内网处理（宁可拦错）。"""
    if not host:
        return True
    try:
        address = ip_address(host)
    except ValueError:
        try:
            address = ip_address(socket.gethostbyname(host))
        except (OSError, ValueError):
            return True
    return (
        address.is_private or address.is_loopback or address.is_link_local or address.is_reserved
    )


def validate_endpoint(url: str) -> str:
    parsed = urlparse(url.strip())
    if parsed.scheme not in {"http", "https"}:
        raise McpError(status.HTTP_400_BAD_REQUEST, "端点需要用 http:// 或 https:// 开头")
    if not parsed.hostname:
        raise McpError(status.HTTP_400_BAD_REQUEST, "端点缺少主机名")
    if not settings.mcp_allow_private_endpoints and is_private_host(parsed.hostname):
        raise McpError(
            status.HTTP_400_BAD_REQUEST,
            "当前配置不允许连接内网地址（APP_MCP_ALLOW_PRIVATE_ENDPOINTS=false）",
        )
    return url.strip()


def _jsonrpc(
    method: str, request_id: int | None, params: dict[str, object] | None = None
) -> dict[str, object]:
    payload: dict[str, object] = {"jsonrpc": "2.0", "method": method}
    if request_id is not None:
        payload["id"] = request_id
    if params is not None:
        payload["params"] = params
    return payload


def parse_rpc_response(response: httpx.Response) -> dict[str, object]:
    """Streamable HTTP 可能直接回 JSON，也可能回 SSE —— 两种都要认。"""
    content_type = response.headers.get("content-type", "")
    if "text/event-stream" in content_type:
        for line in response.text.splitlines():
            if not line.startswith("data:"):
                continue
            try:
                payload = json.loads(line[5:].strip())
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict) and ("result" in payload or "error" in payload):
                return payload
        raise McpError(status.HTTP_502_BAD_GATEWAY, "SSE 响应里没有可解析的 JSON-RPC 结果")
    try:
        payload = response.json()
    except (json.JSONDecodeError, ValueError) as exc:
        raise McpError(status.HTTP_502_BAD_GATEWAY, "服务端没有返回 JSON-RPC") from exc
    if not isinstance(payload, dict):
        raise McpError(status.HTTP_502_BAD_GATEWAY, "JSON-RPC 响应不是对象")
    return payload


def rpc_error_message(payload: dict[str, object]) -> str:
    error = payload.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or error)
    return ""


def normalize_tools(payload: dict[str, object]) -> list[dict[str, object]]:
    result = payload.get("result")
    raw_tools = result.get("tools") if isinstance(result, dict) else None
    if not isinstance(raw_tools, list):
        return []
    tools: list[dict[str, object]] = []
    for item in raw_tools[:50]:
        if not isinstance(item, dict):
            continue
        annotations = item.get("annotations")
        read_only = (
            bool(annotations.get("readOnlyHint")) if isinstance(annotations, dict) else False
        )
        tools.append(
            {
                "name": str(item.get("name") or ""),
                "description": str(item.get("description") or "")[:300],
                "access": "read" if read_only else "write",
            }
        )
    return tools


async def probe_http_server(endpoint: str, token: str = "") -> ProbeResult:
    """真实握手：initialize → notifications/initialized → tools/list。"""
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT_SECONDS) as client:
            handshake = await client.post(
                endpoint,
                headers=headers,
                json=_jsonrpc(
                    "initialize",
                    1,
                    {
                        "protocolVersion": PROTOCOL_VERSION,
                        "capabilities": {},
                        "clientInfo": CLIENT_INFO,
                    },
                ),
            )
            if handshake.status_code >= 400:
                return ProbeResult(
                    PROBE_FAILED, f"初始化被拒绝（HTTP {handshake.status_code}）"
                )
            if len(handshake.content) > MAX_PROBE_BYTES:
                return ProbeResult(PROBE_FAILED, "初始化响应过大，已放弃读取")
            payload = parse_rpc_response(handshake)
            if rpc_error_message(payload):
                return ProbeResult(PROBE_FAILED, f"初始化失败：{rpc_error_message(payload)}")

            result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
            raw_info = result.get("serverInfo")
            server_info = raw_info if isinstance(raw_info, dict) else {}
            server_name = str(server_info.get("name") or "")
            server_version = str(server_info.get("version") or "")

            session_id = handshake.headers.get("mcp-session-id", "")
            session_headers = dict(headers)
            if session_id:
                session_headers["mcp-session-id"] = session_id
            await client.post(
                endpoint,
                headers=session_headers,
                json=_jsonrpc("notifications/initialized", None, {}),
            )

            listing = await client.post(
                endpoint, headers=session_headers, json=_jsonrpc("tools/list", 2, {})
            )
            tools: list[dict[str, object]] = []
            if listing.status_code < 400 and len(listing.content) <= MAX_PROBE_BYTES:
                tools = normalize_tools(parse_rpc_response(listing))
    except httpx.HTTPError as exc:
        return ProbeResult(PROBE_FAILED, f"无法连接：{type(exc).__name__}")
    except McpError as exc:
        return ProbeResult(PROBE_FAILED, exc.detail)

    latency = int((time.perf_counter() - started) * 1000)
    label = f"{server_name} {server_version}".strip() or "未自报名称"
    return ProbeResult(
        PROBE_OK,
        f"握手成功 · {label} · 发现 {len(tools)} 个工具",
        server_name=server_name,
        server_version=server_version,
        tools=tools,
        latency_ms=latency,
    )


class McpStore:
    def __init__(self, database_path: Path) -> None:
        self.path = database_path.resolve()
        self._initialize()

    def list(self) -> list[dict[str, object]]:
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT * FROM mcp_servers ORDER BY created_at"
            ).fetchall()
        return [dict(row) for row in rows]

    def get(self, server_id: str) -> dict[str, object] | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT * FROM mcp_servers WHERE server_id = ?", (server_id,)
            ).fetchone()
        return dict(row) if row else None

    def create(self, draft: McpServerDraft, server_id: str) -> dict[str, object]:
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """
                INSERT INTO mcp_servers (
                    server_id, name, transport, endpoint, auth_token, allowed_agents, note, enabled
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    server_id,
                    draft.name,
                    draft.transport,
                    draft.endpoint,
                    draft.auth_token or "",
                    json.dumps(draft.allowed_agents, ensure_ascii=False),
                    draft.note,
                    1 if draft.enabled else 0,
                ),
            )
        created = self.get(server_id)
        assert created is not None
        return created

    def update(self, server_id: str, changes: dict[str, object]) -> dict[str, object] | None:
        if self.get(server_id) is None:
            return None
        fields: list[str] = []
        values: list[object] = []
        for key in ("name", "transport", "endpoint", "auth_token", "note"):
            if key in changes and changes[key] is not None:
                fields.append(f"{key} = ?")
                values.append(str(changes[key]))
        if "enabled" in changes and changes["enabled"] is not None:
            fields.append("enabled = ?")
            values.append(1 if changes["enabled"] else 0)
        if "allowed_agents" in changes and changes["allowed_agents"] is not None:
            fields.append("allowed_agents = ?")
            values.append(json.dumps(changes["allowed_agents"], ensure_ascii=False))
        if not fields:
            return self.get(server_id)
        fields.append("updated_at = CURRENT_TIMESTAMP")
        values.append(server_id)
        with closing(self._connect()) as connection, connection:
            connection.execute(
                f"UPDATE mcp_servers SET {', '.join(fields)} WHERE server_id = ?",  # noqa: S608 - 字段名来自白名单
                tuple(values),
            )
        return self.get(server_id)

    def delete(self, server_id: str) -> bool:
        if self.get(server_id) is None:
            return False
        with closing(self._connect()) as connection, connection:
            connection.execute("DELETE FROM mcp_servers WHERE server_id = ?", (server_id,))
        return True

    def record_probe(self, server_id: str, result: ProbeResult) -> dict[str, object] | None:
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """
                UPDATE mcp_servers
                   SET last_probe_status = ?, last_probe_detail = ?, server_name = ?,
                       server_version = ?, tools = ?, latency_ms = ?,
                       last_probe_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE server_id = ?
                """,
                (
                    result.status,
                    result.detail,
                    result.server_name,
                    result.server_version,
                    json.dumps(result.tools or [], ensure_ascii=False),
                    result.latency_ms,
                    server_id,
                ),
            )
        return self.get(server_id)

    def _initialize(self) -> None:
        with closing(self._connect()) as connection, connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS mcp_servers (
                    server_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    transport TEXT NOT NULL DEFAULT 'http',
                    endpoint TEXT NOT NULL,
                    auth_token TEXT NOT NULL DEFAULT '',
                    allowed_agents TEXT NOT NULL DEFAULT '[]',
                    note TEXT NOT NULL DEFAULT '',
                    enabled INTEGER NOT NULL DEFAULT 1,
                    server_name TEXT NOT NULL DEFAULT '',
                    server_version TEXT NOT NULL DEFAULT '',
                    tools TEXT NOT NULL DEFAULT '[]',
                    latency_ms INTEGER NOT NULL DEFAULT 0,
                    last_probe_status TEXT NOT NULL DEFAULT 'never',
                    last_probe_detail TEXT NOT NULL DEFAULT '',
                    last_probe_at TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection


def to_view(row: dict[str, object], *, include_token: bool = False) -> McpServerView:
    def as_list(value: object) -> list[object]:
        try:
            parsed = json.loads(str(value or "[]"))
        except json.JSONDecodeError:
            return []
        return parsed if isinstance(parsed, list) else []

    token = str(row.get("auth_token") or "")
    return McpServerView(
        server_id=str(row["server_id"]),
        name=str(row["name"]),
        transport=str(row["transport"]),
        endpoint=str(row["endpoint"]),
        allowed_agents=[str(item) for item in as_list(row.get("allowed_agents"))],
        note=str(row.get("note") or ""),
        enabled=bool(row.get("enabled")),
        server_name=str(row.get("server_name") or ""),
        server_version=str(row.get("server_version") or ""),
        tools=[item for item in as_list(row.get("tools")) if isinstance(item, dict)],
        latency_ms=int(row.get("latency_ms") or 0),
        last_probe_status=str(row.get("last_probe_status") or PROBE_NEVER),
        last_probe_detail=str(row.get("last_probe_detail") or ""),
        last_probe_at=str(row.get("last_probe_at") or ""),
        has_auth=bool(token),
        auth_token=token if include_token else "",
        created_at=str(row.get("created_at") or ""),
        updated_at=str(row.get("updated_at") or ""),
    )


_store: McpStore | None = None


def get_mcp_store() -> McpStore:
    global _store
    if _store is None:
        _store = McpStore(Path(settings.database_path))
    return _store


mcp_router = APIRouter(prefix="/api/mcp", tags=["mcp"])


@mcp_router.get("", response_model=list[McpServerView])
async def list_servers(_: Account = Depends(current_user)) -> list[McpServerView]:
    return [to_view(row) for row in get_mcp_store().list()]


@mcp_router.post("", response_model=McpServerView, status_code=status.HTTP_201_CREATED)
async def create_server(
    draft: McpServerDraft, _: Account = Depends(current_user)
) -> McpServerView:
    if draft.transport == "http":
        try:
            draft = draft.model_copy(update={"endpoint": validate_endpoint(draft.endpoint)})
        except McpError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    row = get_mcp_store().create(draft, f"mcp-{secrets.token_hex(6)}")
    return to_view(row)


@mcp_router.put("/{server_id}", response_model=McpServerView)
async def update_server(
    server_id: str, changes: dict[str, object], _: Account = Depends(current_user)
) -> McpServerView:
    allowed = {
        "name", "transport", "endpoint", "auth_token", "note", "enabled", "allowed_agents",
    }
    filtered = {key: value for key, value in changes.items() if key in allowed}
    if isinstance(filtered.get("endpoint"), str) and filtered.get("transport") == "http":
        try:
            filtered["endpoint"] = validate_endpoint(str(filtered["endpoint"]))
        except McpError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    row = get_mcp_store().update(server_id, filtered)
    if row is None:
        raise HTTPException(status_code=404, detail="MCP 服务器不存在")
    return to_view(row)


@mcp_router.delete("/{server_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_server(server_id: str, _: Account = Depends(current_user)) -> Response:
    if not get_mcp_store().delete(server_id):
        raise HTTPException(status_code=404, detail="MCP 服务器不存在")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@mcp_router.post("/{server_id}/probe", response_model=McpServerView)
async def probe_server(server_id: str, _: Account = Depends(current_user)) -> McpServerView:
    store = get_mcp_store()
    row = store.get(server_id)
    if row is None:
        raise HTTPException(status_code=404, detail="MCP 服务器不存在")

    transport = str(row.get("transport") or "http")
    if transport != "http":
        result = ProbeResult(
            PROBE_UNSUPPORTED,
            "stdio / sse 传输不支持在服务端探测，配置已保存但未验证连接",
        )
    else:
        endpoint = str(row.get("endpoint") or "")
        try:
            endpoint = validate_endpoint(endpoint)
        except McpError as exc:
            result = ProbeResult(PROBE_FAILED, exc.detail)
        else:
            result = await probe_http_server(endpoint, str(row.get("auth_token") or ""))

    updated = store.record_probe(server_id, result)
    assert updated is not None
    return to_view(updated)
