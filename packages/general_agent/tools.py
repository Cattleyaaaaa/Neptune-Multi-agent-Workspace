import asyncio
import csv
import inspect
import ipaddress
import re
import socket
from collections import Counter
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from io import StringIO
from pathlib import Path
from statistics import fmean
from typing import Protocol
from urllib.parse import urljoin, urlparse

import httpx

from packages.general_agent.execution import WriteError, WriteExecutor, WriteRequest
from packages.general_agent.net import is_private_host

ToolHandler = Callable[[dict[str, object]], dict[str, object]] | Callable[
    [dict[str, object]], Awaitable[dict[str, object]]
]


class ToolPermissionError(PermissionError):
    pass


@dataclass(frozen=True, slots=True)
class ToolDefinition:
    name: str
    description: str
    allowed_agents: tuple[str, ...]
    access: str
    handler: ToolHandler
    # MCP 工具的入参 schema。留空表示"无需参数或参数未知"。
    schema: dict[str, object] = field(default_factory=dict)


class ExternalToolProvider(Protocol):
    """外部工具来源（目前是 MCP）。注册表不关心它背后是谁。"""

    def definitions(self) -> list[ToolDefinition]: ...

    async def call(self, tool_name: str, arguments: dict[str, object]) -> dict[str, object]: ...


def _has_delimiter(line: str) -> bool:
    return any(delimiter in line for delimiter in (",", ";", "\t", "|"))


def csv_blocks(content: str) -> list[str]:
    """把上下文切成若干"看起来像表格"的连续行块，长的在前。

    任务的 context 会在末尾被追加系统约束与知识库片段，整段丢给 csv.Sniffer 会被
    判成"格式无法识别"（实测：用户明明贴了 CSV，数据步骤却回"请粘贴 CSV"）。所以先
    把真正的表格块挑出来再解析。
    """
    blocks: list[list[str]] = []
    current: list[str] = []
    for line in content.splitlines():
        if line.strip() and _has_delimiter(line):
            current.append(line)
        elif current:
            blocks.append(current)
            current = []
    if current:
        blocks.append(current)
    blocks.sort(key=len, reverse=True)
    return ["\n".join(block) for block in blocks if len(block) >= 2]


def parse_csv_table(content: str) -> tuple[list[dict[str, str]], list[str]] | None:
    """在上下文里找出第一段能解析出"至少两列、至少一行"的表格。"""
    for block in csv_blocks(content):
        try:
            dialect = csv.Sniffer().sniff(block[:4096], delimiters=",;\t|")
        except (csv.Error, UnicodeError):
            continue
        reader = csv.DictReader(StringIO(block), dialect=dialect)
        rows = list(reader)[:5000]
        columns = [name for name in (reader.fieldnames or []) if name]
        if len(columns) >= 2 and rows:
            return rows, columns
    return None


class ToolRegistry:
    def __init__(self, project_root: Path, executor: WriteExecutor | None = None) -> None:
        self.project_root = project_root.resolve()
        self._tools: dict[str, ToolDefinition] = {}
        self._executor = executor
        self._external: ExternalToolProvider | None = None
        self._register_defaults()

    def set_executor(self, executor: WriteExecutor | None) -> None:
        self._executor = executor

    def set_external_provider(self, provider: ExternalToolProvider | None) -> None:
        self._external = provider

    def external_definitions(self) -> list[ToolDefinition]:
        return list(self._external.definitions()) if self._external else []

    def _resolve(self, tool_name: str) -> tuple[ToolDefinition, bool]:
        """返回 (工具定义, 是否来自外部)。"""
        tool = self._tools.get(tool_name)
        if tool is not None:
            return tool, False
        for item in self.external_definitions():
            if item.name == tool_name:
                return item, True
        raise KeyError(f"Unknown tool: {tool_name}")

    def invoke(
        self, tool_name: str, agent: str, arguments: dict[str, object]
    ) -> tuple[dict[str, object], dict[str, object]]:
        """同步调用：只适用于内置同步工具（外部工具请走 ainvoke）。"""
        try:
            tool, is_external = self._resolve(tool_name)
        except KeyError as exc:
            raise KeyError(f"Unknown tool: {tool_name}") from exc
        if is_external:
            raise ToolPermissionError(f"{tool_name} 是异步外部工具，请使用 ainvoke 调用")
        if agent not in tool.allowed_agents:
            raise ToolPermissionError(f"{agent} is not allowed to call {tool_name}")
        try:
            result = tool.handler(arguments)  # type: ignore[assignment,operator]
            status = "succeeded"
        except Exception as exc:
            result = {"error": str(exc), "error_type": type(exc).__name__}
            status = "failed"
        return result, self._audit(tool.name, agent, tool.access, status, result)

    async def ainvoke(
        self, tool_name: str, agent: str, arguments: dict[str, object]
    ) -> tuple[dict[str, object], dict[str, object]]:
        """异步调用：内置同步工具放进线程，异步工具（MCP）直接 await。"""
        try:
            tool, is_external = self._resolve(tool_name)
        except KeyError as exc:
            raise KeyError(f"Unknown tool: {tool_name}") from exc
        if agent not in tool.allowed_agents:
            raise ToolPermissionError(f"{agent} is not allowed to call {tool_name}")
        try:
            if is_external:
                assert self._external is not None
                result = await self._external.call(tool_name, arguments)
            elif inspect.iscoroutinefunction(tool.handler):
                result = await tool.handler(arguments)  # type: ignore[misc,operator]
            else:
                result = await asyncio.to_thread(tool.handler, arguments)  # type: ignore[arg-type,operator]
            status = "succeeded"
        except Exception as exc:
            result = {"error": str(exc), "error_type": type(exc).__name__}
            status = "failed"
        return result, self._audit(tool.name, agent, tool.access, status, result)

    def _audit(
        self,
        tool_name: str,
        agent: str,
        access: str,
        status: str,
        result: dict[str, object],
    ) -> dict[str, object]:
        return {
            "tool": tool_name,
            "agent": agent,
            "access": access,
            "status": status,
            "summary": self._summarize(tool_name, result),
        }

    def definitions(self) -> list[dict[str, object]]:
        items = [
            {
                "name": tool.name,
                "description": tool.description,
                "allowed_agents": list(tool.allowed_agents),
                "access": tool.access,
                "source": "builtin",
            }
            for tool in self._tools.values()
        ]
        items.extend(
            {
                "name": tool.name,
                "description": tool.description,
                "allowed_agents": list(tool.allowed_agents),
                "access": tool.access,
                "source": "mcp",
                "input_schema": tool.schema,
            }
            for tool in self.external_definitions()
        )
        return items

    def _register_defaults(self) -> None:
        self._register(
            ToolDefinition(
                "extract_research_inputs",
                "Extract URLs and research constraints from user-provided context.",
                ("research_agent", "react_agent"),
                "read",
                self._extract_research_inputs,
            )
        )
        self._register(
            ToolDefinition(
                "fetch_public_url",
                "Fetch text from a user-provided public HTTP URL with SSRF protection.",
                ("research_agent", "react_agent"),
                "network_read",
                self._fetch_public_url,
            )
        )
        self._register(
            ToolDefinition(
                "analyze_csv",
                "Parse CSV text and calculate schema and numeric summaries.",
                ("data_agent", "react_agent"),
                "read",
                self._analyze_csv,
            )
        )
        self._register(
            ToolDefinition(
                "inspect_workspace",
                "Inventory source files in the configured workspace without reading secrets.",
                ("code_agent", "react_agent"),
                "read",
                self._inspect_workspace,
            )
        )
        self._register(
            ToolDefinition(
                "prepare_external_action",
                "Create an auditable simulated execution receipt.",
                ("execution_agent",),
                "simulated_write",
                self._prepare_external_action,
            )
        )
        self._register(
            ToolDefinition(
                "execute_external_write",
                "Perform the approved write for real (http / file / database).",
                ("execution_agent",),
                "write",
                self._execute_external_write,
            )
        )
        self._register(
            ToolDefinition(
                "restore_file_snapshot",
                "Roll back a previous file write using its snapshot id.",
                ("execution_agent",),
                "write",
                self._restore_file_snapshot,
            )
        )

    def _register(self, tool: ToolDefinition) -> None:
        self._tools[tool.name] = tool

    @staticmethod
    def _extract_research_inputs(arguments: dict[str, object]) -> dict[str, object]:
        objective = str(arguments.get("objective", ""))
        context = str(arguments.get("context", ""))
        urls = list(dict.fromkeys(re.findall(r"https?://[^\s<>)\]]+", f"{objective}\n{context}")))
        constraints = [line.strip(" -•") for line in context.splitlines() if line.strip()]
        return {
            "urls": urls[:20],
            "context_items": constraints[:30],
            "has_sources": bool(urls),
        }

    @staticmethod
    def _analyze_csv(arguments: dict[str, object]) -> dict[str, object]:
        content = str(arguments.get("content", "")).strip()[:1_000_000]
        if not content:
            return {"detected": False, "reason": "上下文中没有可解析的 CSV 数据"}
        parsed = parse_csv_table(content)
        if parsed is None:
            return {"detected": False, "reason": "没有识别到表格数据（至少需要两行两列）"}
        rows, columns = parsed
        numeric: dict[str, list[float]] = {column: [] for column in columns}
        missing = Counter()
        for row in rows:
            for column in columns:
                raw = (row.get(column) or "").strip()
                if not raw:
                    missing[column] += 1
                    continue
                try:
                    numeric[column].append(float(raw.replace(",", "")))
                except ValueError:
                    pass
        summaries = {
            column: {
                "count": len(values),
                "min": min(values),
                "max": max(values),
                "mean": round(fmean(values), 4),
            }
            for column, values in numeric.items()
            if values and len(values) >= max(1, len(rows) // 2)
        }
        return {
            "detected": True,
            "row_count": len(rows),
            "columns": columns,
            "numeric_summary": summaries,
            "missing_values": dict(missing),
            "truncated": len(rows) == 5000,
        }

    def _inspect_workspace(self, arguments: dict[str, object]) -> dict[str, object]:
        ignored = {".git", ".venv", ".next", "node_modules", ".uv-cache", "__pycache__"}
        suffixes: Counter[str] = Counter()
        samples: list[str] = []
        total = 0
        for path in self.project_root.rglob("*"):
            if any(part in ignored for part in path.parts) or not path.is_file():
                continue
            total += 1
            suffixes[path.suffix.lower() or "[no extension]"] += 1
            if len(samples) < 20:
                samples.append(path.relative_to(self.project_root).as_posix())
            if total >= 2000:
                break
        return {
            "root": self.project_root.name,
            "file_count": total,
            "languages": dict(suffixes.most_common(12)),
            "sample_files": samples,
            "truncated": total == 2000,
            "requested_focus": str(arguments.get("objective", "")),
        }

    @staticmethod
    def _fetch_public_url(arguments: dict[str, object]) -> dict[str, object]:
        current_url = str(arguments.get("url", ""))
        for _ in range(4):
            ToolRegistry._validate_public_url(current_url)
            with httpx.Client(timeout=12, follow_redirects=False) as client:
                with client.stream(
                    "GET",
                    current_url,
                    headers={"User-Agent": "NeptuneAgent/0.1"},
                ) as response:
                    if response.status_code in {301, 302, 303, 307, 308}:
                        location = response.headers.get("location")
                        if not location:
                            raise ValueError("Redirect response did not include a location")
                        current_url = urljoin(current_url, location)
                        continue
                    response.raise_for_status()
                    content_type = response.headers.get("content-type", "")
                    if not any(kind in content_type for kind in ("text/", "json", "xml")):
                        raise ValueError(f"Unsupported content type: {content_type}")
                    chunks: list[bytes] = []
                    size = 0
                    for chunk in response.iter_bytes():
                        size += len(chunk)
                        if size > 1_000_000:
                            raise ValueError("Remote content exceeds 1 MB")
                        chunks.append(chunk)
                    text = b"".join(chunks).decode(response.encoding or "utf-8", errors="replace")
            cleaned = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", text)
            cleaned = re.sub(r"<[^>]+>", " ", cleaned)
            cleaned = re.sub(r"\s+", " ", cleaned).strip()
            title_match = re.search(r"<title[^>]*>(.*?)</title>", text, re.IGNORECASE | re.DOTALL)
            return {
                "url": current_url,
                "status_code": response.status_code,
                "title": re.sub(r"\s+", " ", title_match.group(1)).strip() if title_match else "",
                "text_excerpt": cleaned[:12_000],
                "content_type": content_type,
            }
        raise ValueError("Too many redirects")

    @staticmethod
    def _validate_public_url(url: str) -> None:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("Only public HTTP and HTTPS URLs are supported")
        if is_private_host(parsed.hostname):
            raise ValueError("Private or local network addresses are not allowed")
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
        for address in addresses:
            ip = ipaddress.ip_address(address[4][0])
            if (
                ip.is_private
                or ip.is_loopback
                or ip.is_link_local
                or ip.is_reserved
                or ip.is_multicast
                or ip.is_unspecified
            ):
                raise ValueError("Private or local network addresses are not allowed")

    @staticmethod
    def _prepare_external_action(arguments: dict[str, object]) -> dict[str, object]:
        return {
            "status": "simulated",
            "objective": str(arguments.get("objective", "")),
            "approval_id": str(arguments.get("approval_id", "")),
            "approver_id": str(arguments.get("approver_id", "")),
        }

    def _execute_external_write(self, arguments: dict[str, object]) -> dict[str, object]:
        """真实写入。没有适配器就明确报错，绝不退化成"假装写成功"。"""
        if self._executor is None:
            raise WriteError("未配置执行适配器，无法执行真实写入")
        request = WriteRequest.from_dict(arguments)
        return self._executor.execute(request, dry_run=bool(arguments.get("dry_run"))).to_dict()

    def _restore_file_snapshot(self, arguments: dict[str, object]) -> dict[str, object]:
        if self._executor is None:
            raise WriteError("未配置执行适配器，无法回滚文件")
        snapshot_id = str(arguments.get("snapshot_id", ""))
        if not snapshot_id:
            raise WriteError("回滚缺少 snapshot_id")
        return self._executor.restore(snapshot_id)

    @staticmethod
    def _summarize(tool_name: str, result: dict[str, object]) -> str:
        if tool_name == "analyze_csv" and result.get("detected"):
            return f"解析 {result['row_count']} 行、{len(result['columns'])} 列 CSV 数据"
        if tool_name == "inspect_workspace":
            return f"只读盘点 {result['file_count']} 个工作区文件"
        if tool_name == "extract_research_inputs":
            return f"提取 {len(result['urls'])} 个来源链接"
        if tool_name == "fetch_public_url":
            return (
                f"读取公开网页 {result.get('title') or result.get('url')}"
                if "error" not in result
                else f"网页读取失败：{result['error_type']}"
            )
        if tool_name == "execute_external_write":
            if result.get("error"):
                return f"写入失败：{str(result['error'])[:80]}"
            if result.get("mode") == "simulate":
                return f"演练写入（未落盘）：{result.get('target')}"
            return f"已真实写入：{result.get('target')}"
        if tool_name == "restore_file_snapshot":
            return f"已回滚快照 {result.get('snapshot_id', '')}"
        return "生成已审批动作的模拟执行回执"
