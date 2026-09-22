import csv
import ipaddress
import re
import socket
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from io import StringIO
from pathlib import Path
from statistics import fmean
from urllib.parse import urljoin, urlparse

import httpx


class ToolPermissionError(PermissionError):
    pass


@dataclass(frozen=True, slots=True)
class ToolDefinition:
    name: str
    description: str
    allowed_agents: tuple[str, ...]
    access: str
    handler: Callable[[dict[str, object]], dict[str, object]]


class ToolRegistry:
    def __init__(self, project_root: Path) -> None:
        self.project_root = project_root.resolve()
        self._tools: dict[str, ToolDefinition] = {}
        self._register_defaults()

    def invoke(
        self, tool_name: str, agent: str, arguments: dict[str, object]
    ) -> tuple[dict[str, object], dict[str, object]]:
        try:
            tool = self._tools[tool_name]
        except KeyError as exc:
            raise KeyError(f"Unknown tool: {tool_name}") from exc
        if agent not in tool.allowed_agents:
            raise ToolPermissionError(f"{agent} is not allowed to call {tool_name}")
        try:
            result = tool.handler(arguments)
            status = "succeeded"
        except Exception as exc:
            result = {"error": str(exc), "error_type": type(exc).__name__}
            status = "failed"
        audit = {
            "tool": tool.name,
            "agent": agent,
            "access": tool.access,
            "status": status,
            "summary": self._summarize(tool.name, result),
        }
        return result, audit

    def definitions(self) -> list[dict[str, object]]:
        return [
            {
                "name": tool.name,
                "description": tool.description,
                "allowed_agents": list(tool.allowed_agents),
                "access": tool.access,
            }
            for tool in self._tools.values()
        ]

    def _register_defaults(self) -> None:
        self._register(
            ToolDefinition(
                "extract_research_inputs",
                "Extract URLs and research constraints from user-provided context.",
                ("research_agent",),
                "read",
                self._extract_research_inputs,
            )
        )
        self._register(
            ToolDefinition(
                "fetch_public_url",
                "Fetch text from a user-provided public HTTP URL with SSRF protection.",
                ("research_agent",),
                "network_read",
                self._fetch_public_url,
            )
        )
        self._register(
            ToolDefinition(
                "analyze_csv",
                "Parse CSV text and calculate schema and numeric summaries.",
                ("data_agent",),
                "read",
                self._analyze_csv,
            )
        )
        self._register(
            ToolDefinition(
                "inspect_workspace",
                "Inventory source files in the configured workspace without reading secrets.",
                ("code_agent",),
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
        content = str(arguments.get("content", "")).strip()
        if not content or "\n" not in content:
            return {"detected": False, "reason": "上下文中没有可解析的 CSV 数据"}
        content = content[:1_000_000]
        try:
            dialect = csv.Sniffer().sniff(content[:4096], delimiters=",;\t|")
            reader = csv.DictReader(StringIO(content), dialect=dialect)
            rows = list(reader)[:5000]
        except (csv.Error, UnicodeError):
            return {"detected": False, "reason": "CSV 格式无法识别"}
        columns = list(reader.fieldnames or [])
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
                    headers={"User-Agent": "NexusAgent/0.1"},
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
        return "生成已审批动作的模拟执行回执"
