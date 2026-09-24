"""把已探测的 MCP 工具接进运行时工具注册表。

边界说清楚：

* 只有 `http` 传输、已启用、**且探测成功拿到工具清单**的服务器才会被接入 ——
  没有工具清单就无从知道该传什么参数，硬调只会制造噪音。
* 工具名统一带 `mcp:<server_id>:<tool>` 前缀，避免与内置工具撞名。
* 权限：只读工具按服务器配置的 `allowed_agents` 授权；**写入类工具只交给
  execution_agent**，并且仍需审批门禁，研究/文档 Agent 不会顺手改外部系统。
* 入参按 `inputSchema` 构造；构造不出来就不调用，并在回执里写明原因。
"""

from __future__ import annotations

import json
from typing import Any

from apps.api.mcp import McpStore
from packages.general_agent.mcp_client import McpSession
from packages.general_agent.tools import ToolDefinition

PREFIX = "mcp:"
# 服务器没配置 allowed_agents 时的默认授权范围（不含执行 Agent：写入要显式授权）。
DEFAULT_AGENTS = (
    "research_agent",
    "data_agent",
    "code_agent",
    "document_agent",
    "review_agent",
    "react_agent",
)


def qualify(server_id: str, tool_name: str) -> str:
    return f"{PREFIX}{server_id}:{tool_name}"


def unqualify(qualified: str) -> tuple[str, str]:
    body = qualified[len(PREFIX) :] if qualified.startswith(PREFIX) else qualified
    server_id, _, tool_name = body.partition(":")
    return server_id, tool_name


def _load(value: object) -> list[Any]:
    try:
        parsed = json.loads(str(value or "[]"))
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


class McpToolProvider:
    """实现 ExternalToolProvider。每次 definitions() 都读库，配置改动即时生效。"""

    def __init__(self, store: McpStore) -> None:
        self._store = store

    def definitions(self) -> list[ToolDefinition]:
        items: list[ToolDefinition] = []
        for row in self._store.list():
            if not row.get("enabled") or str(row.get("transport")) != "http":
                continue
            allowed = [str(item) for item in _load(row.get("allowed_agents"))]
            effective = allowed or list(DEFAULT_AGENTS)
            for tool in _load(row.get("tools")):
                if not isinstance(tool, dict):
                    continue
                remote_name = str(tool.get("name") or "")
                if not remote_name:
                    continue
                access = "read" if tool.get("access") == "read" else "write"
                agents = (
                    tuple(effective)
                    if access == "read"
                    else tuple({"execution_agent"} & set(effective))
                )
                if not agents:
                    continue
                qualified = qualify(str(row["server_id"]), remote_name)
                schema = tool.get("input_schema")
                items.append(
                    ToolDefinition(
                        name=qualified,
                        description=f"[MCP · {row.get('name')}] {tool.get('description', '')}",
                        allowed_agents=agents,
                        access=access,
                        handler=self._handler(qualified),
                        schema=schema if isinstance(schema, dict) else {},
                    )
                )
        return items

    def _handler(self, qualified: str):
        async def handler(arguments: dict[str, object]) -> dict[str, object]:
            return await self.call(qualified, arguments)

        return handler

    async def call(self, tool_name: str, arguments: dict[str, object]) -> dict[str, object]:
        server_id, remote_name = unqualify(tool_name)
        row = self._store.get(server_id)
        if row is None:
            raise RuntimeError(f"MCP 服务器不存在：{server_id}")
        if not row.get("enabled"):
            raise RuntimeError("MCP 服务器已停用")
        session = McpSession(
            endpoint=str(row.get("endpoint") or ""),
            token=str(row.get("auth_token") or ""),
        )
        return await session.call_tool(remote_name, arguments)
