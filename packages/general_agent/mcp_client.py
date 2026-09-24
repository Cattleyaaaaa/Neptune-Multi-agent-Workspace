"""MCP Streamable HTTP 客户端：握手、列工具、调工具。

放在 packages 里是为了让运行时（Agent / ReAct）能真正调用 MCP 工具 ——
apps.api.mcp 只负责配置 CRUD 与探测，两边共用同一套 JSON-RPC 解析。

协议顺序遵循 MCP：`initialize` → `notifications/initialized` → `tools/list` / `tools/call`。
响应体可能是 JSON 也可能是 SSE，两种都要认。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import httpx

from packages.general_agent.net import http_trust_env_for

CLIENT_INFO = {"name": "neptune-agent", "version": "0.1.0"}
PROTOCOL_VERSION = "2025-06-18"
DEFAULT_TIMEOUT = 15.0
MAX_RESPONSE_BYTES = 512 * 1024


class McpRpcError(RuntimeError):
    pass


def jsonrpc(
    method: str, request_id: int | None, params: dict[str, object] | None = None
) -> dict[str, object]:
    payload: dict[str, object] = {"jsonrpc": "2.0", "method": method}
    if request_id is not None:
        payload["id"] = request_id
    if params is not None:
        payload["params"] = params
    return payload


def parse_rpc_response(response: httpx.Response) -> dict[str, object]:
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
        raise McpRpcError("SSE 响应里没有可解析的 JSON-RPC 结果")
    try:
        payload = response.json()
    except (json.JSONDecodeError, ValueError) as exc:
        raise McpRpcError("服务端没有返回 JSON-RPC") from exc
    if not isinstance(payload, dict):
        raise McpRpcError("JSON-RPC 响应不是对象")
    return payload


def rpc_error_message(payload: dict[str, object]) -> str:
    error = payload.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or error)
    return ""


def unwrap_result(payload: dict[str, object]) -> dict[str, object]:
    if rpc_error_message(payload):
        raise McpRpcError(rpc_error_message(payload))
    result = payload.get("result")
    return dict(result) if isinstance(result, dict) else {}


def normalize_tools(
    payload: dict[str, object], *, with_schema: bool = False
) -> list[dict[str, object]]:
    """默认只回三字段（界面展示用）；`with_schema=True` 会带上入参 schema，供调用时使用。"""
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
        entry: dict[str, object] = {
            "name": str(item.get("name") or ""),
            "description": str(item.get("description") or "")[:300],
            "access": "read" if read_only else "write",
        }
        if with_schema:
            schema = item.get("inputSchema")
            entry["input_schema"] = schema if isinstance(schema, dict) else {}
        tools.append(entry)
    return tools


def build_arguments(
    schema: dict[str, object], objective: str
) -> tuple[dict[str, object] | None, str]:
    """按 inputSchema 构造入参。构造不出来就返回 None 并说明原因。

    没有模型时这是唯一诚实的做法：宁可不调，也不要拿瞎猜的参数去写外部系统。
    """
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return {}, ""
    required = schema.get("required")
    required_names = [str(item) for item in required] if isinstance(required, list) else []
    arguments: dict[str, object] = {}
    for name, spec in properties.items():
        if not isinstance(spec, dict):
            continue
        kind = str(spec.get("type") or "")
        if kind == "string":
            arguments[str(name)] = objective
        elif kind in {"integer", "number"}:
            digits = [token for token in objective.replace(",", " ").split() if token.isdigit()]
            if not digits:
                if str(name) in required_names:
                    return None, f"参数 {name} 需要数字，目标里没有可提取的数值"
                continue
            arguments[str(name)] = int(digits[0]) if kind == "integer" else float(digits[0])
        elif kind == "boolean":
            arguments[str(name)] = False
        else:
            if str(name) in required_names:
                return None, f"参数 {name} 类型为 {kind or '未知'}，无法自动构造"
    missing = [name for name in required_names if name not in arguments]
    if missing:
        return None, f"缺少必填参数：{', '.join(missing)}"
    return arguments, ""


@dataclass(slots=True)
class McpSession:
    """一次会话 = 一次握手。调用完就丢弃，服务端重启也不会留下脏会话。"""

    endpoint: str
    token: str = ""
    timeout: float = DEFAULT_TIMEOUT
    _session_id: str = field(default="", init=False)

    def _client(self) -> httpx.AsyncClient:
        """内网端点直连，公网端点才走系统/环境代理。

        Windows 的系统代理（如 127.0.0.1:7897）会被 httpx 读到，但它不认注册表里的
        "本地地址绕过"列表 —— 于是发往 127.0.0.1 的 MCP 调用会被本机代理劫走并回 502。
        """
        return httpx.AsyncClient(
            timeout=self.timeout, trust_env=http_trust_env_for(self.endpoint)
        )

    def _headers(self) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if self._session_id:
            headers["mcp-session-id"] = self._session_id
        return headers

    async def initialize(self) -> dict[str, object]:
        async with self._client() as client:
            response = await client.post(
                self.endpoint,
                headers=self._headers(),
                json=jsonrpc(
                    "initialize",
                    1,
                    {
                        "protocolVersion": PROTOCOL_VERSION,
                        "capabilities": {},
                        "clientInfo": CLIENT_INFO,
                    },
                ),
            )
            if response.status_code >= 400:
                raise McpRpcError(f"初始化被拒绝（HTTP {response.status_code}）")
            if len(response.content) > MAX_RESPONSE_BYTES:
                raise McpRpcError("初始化响应过大，已放弃读取")
            payload = parse_rpc_response(response)
            info = unwrap_result(payload)
            self._session_id = response.headers.get("mcp-session-id", "")
            await client.post(
                self.endpoint,
                headers=self._headers(),
                json=jsonrpc("notifications/initialized", None, {}),
            )
            return info

    async def list_tools(self) -> list[dict[str, object]]:
        async with self._client() as client:
            response = await client.post(
                self.endpoint, headers=self._headers(), json=jsonrpc("tools/list", 2, {})
            )
            if response.status_code >= 400:
                raise McpRpcError(f"列工具失败（HTTP {response.status_code}）")
            if len(response.content) > MAX_RESPONSE_BYTES:
                raise McpRpcError("工具清单过大，已放弃读取")
            return normalize_tools(parse_rpc_response(response))

    async def call_tool(self, name: str, arguments: dict[str, object]) -> dict[str, object]:
        """真实调用一次 MCP 工具，返回结构化结果（含结构化内容/文本/错误）。"""
        async with self._client() as client:
            await self.initialize()
            response = await client.post(
                self.endpoint,
                headers=self._headers(),
                json=jsonrpc("tools/call", 3, {"name": name, "arguments": arguments}),
            )
            payload = parse_rpc_response(response) if response.status_code < 400 else {}
            if response.status_code >= 400:
                raise McpRpcError(f"工具调用失败（HTTP {response.status_code}）")
            if rpc_error_message(payload):
                raise McpRpcError(rpc_error_message(payload))
            result = unwrap_result(payload)
            return {
                "tool": name,
                "is_error": bool(result.get("isError")),
                "content": result.get("content", []),
                "structured": result.get("structuredContent", {}),
                "text": _content_text(result),
            }


def _content_text(result: dict[str, object]) -> str:
    """把 MCP 的 content 数组压成一段文本，便于进提示词与审计摘要。"""
    parts: list[str] = []
    content = result.get("content")
    if not isinstance(content, list):
        return ""
    for item in content[:20]:
        if isinstance(item, dict) and item.get("type") == "text":
            parts.append(str(item.get("text", "")))
    return "\n".join(parts)[:4_000]
