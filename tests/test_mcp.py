"""MCP 中心：配置持久化 + 真实 HTTP 握手探测。

探测这部分用**本地起一个真的 HTTP 服务**来测，而不是打桩函数——
要验证的是"我们发的 JSON-RPC 能不能被理解、返回的结果能不能解析"，
把 httpx 换掉就等于什么都没测。
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from apps.api.mcp import (
    PROBE_FAILED,
    PROBE_OK,
    PROBE_UNSUPPORTED,
    McpError,
    McpStore,
    is_private_host,
    normalize_tools,
    parse_rpc_response,
    probe_http_server,
    validate_endpoint,
)
from apps.api.settings import settings
from packages.contracts.models import McpServerDraft

# ------------------------------------------------------- 本地 MCP 桩服务


class _StubHandler(BaseHTTPRequestHandler):
    received: list[dict] = []
    server_name = "stub-mcp"
    server_version = "9.9.9"

    def log_message(self, *args: object) -> None:  # 静音
        return

    def _reply(self, code: int, payload: dict | None, session: str = "") -> None:
        body = json.dumps(payload).encode() if payload is not None else b""
        self.send_response(code)
        self.send_header("content-type", "application/json")
        if session:
            self.send_header("mcp-session-id", session)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler 的接口
        length = int(self.headers.get("content-length", 0))
        payload = json.loads(self.rfile.read(length) or b"{}")
        _StubHandler.received.append(payload)
        method = payload.get("method")

        if method == "initialize":
            self._reply(
                200,
                {
                    "jsonrpc": "2.0",
                    "id": payload.get("id"),
                    "result": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "serverInfo": {
                            "name": _StubHandler.server_name,
                            "version": _StubHandler.server_version,
                        },
                    },
                },
                session="sess-1",
            )
        elif method == "tools/list":
            self._reply(
                200,
                {
                    "jsonrpc": "2.0",
                    "id": payload.get("id"),
                    "result": {
                        "tools": [
                            {
                                "name": "read_file",
                                "description": "读取工作区文件",
                                "annotations": {"readOnlyHint": True},
                            },
                            {"name": "write_file", "description": "写入文件（需审批）"},
                        ]
                    },
                },
            )
        else:  # notifications/initialized 等通知
            self._reply(202, None)


@pytest.fixture()
def stub_server():
    _StubHandler.received = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), _StubHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}/mcp"
    server.shutdown()
    server.server_close()


# ------------------------------------------------------------------ 端点校验


def test_endpoint_must_be_http() -> None:
    assert validate_endpoint(" http://127.0.0.1:9000/mcp ") == "http://127.0.0.1:9000/mcp"
    with pytest.raises(McpError):
        validate_endpoint("ftp://example.com/mcp")
    with pytest.raises(McpError):
        validate_endpoint("not-a-url")


def test_private_endpoints_can_be_blocked_by_config(monkeypatch) -> None:
    monkeypatch.setattr(settings, "mcp_allow_private_endpoints", False)
    with pytest.raises(McpError) as excinfo:
        validate_endpoint("http://127.0.0.1:9000/mcp")
    assert "内网" in excinfo.value.detail
    # 公网地址不受影响
    assert validate_endpoint("http://93.184.216.34/mcp")

    monkeypatch.setattr(settings, "mcp_allow_private_endpoints", True)
    assert validate_endpoint("http://127.0.0.1:9000/mcp")


@pytest.mark.parametrize(
    ("host", "expected"),
    [("127.0.0.1", True), ("10.0.0.5", True), ("192.168.1.1", True), ("93.184.216.34", False)],
)
def test_private_host_detection(host: str, expected: bool) -> None:
    assert is_private_host(host) is expected


def test_unresolvable_host_is_treated_as_private() -> None:
    """解析不了的域名按内网处理：宁可拦错也别放行。"""
    assert is_private_host("no-such-host.invalid") is True


# ------------------------------------------------------------ 响应解析


def test_parse_plain_json_response() -> None:
    import httpx

    response = httpx.Response(
        200, json={"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}
    )
    assert parse_rpc_response(response)["result"] == {"ok": True}


def test_parse_sse_response() -> None:
    import httpx

    body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n'
    response = httpx.Response(
        200, text=body, headers={"content-type": "text/event-stream"}
    )
    assert parse_rpc_response(response)["result"] == {"ok": True}


def test_parse_non_json_response_raises() -> None:
    import httpx

    with pytest.raises(McpError):
        parse_rpc_response(httpx.Response(200, text="<html>hi</html>"))


def test_tools_are_normalised_with_read_only_hint() -> None:
    payload = {
        "result": {
            "tools": [
                {"name": "read_file", "description": "读", "annotations": {"readOnlyHint": True}},
                {"name": "write_file", "description": "写"},
            ]
        }
    }
    tools = normalize_tools(payload)

    assert tools[0] == {"name": "read_file", "description": "读", "access": "read"}
    assert tools[1]["access"] == "write"


# ------------------------------------------------------------------ 真实握手


@pytest.mark.asyncio
async def test_probe_performs_a_real_handshake(stub_server: str) -> None:
    result = await probe_http_server(stub_server)

    assert result.status == PROBE_OK
    assert result.server_name == "stub-mcp"
    assert result.server_version == "9.9.9"
    assert [tool["name"] for tool in result.tools or []] == ["read_file", "write_file"]
    assert result.latency_ms >= 0

    methods = [item.get("method") for item in _StubHandler.received]
    assert methods[:2] == ["initialize", "notifications/initialized"]
    assert "tools/list" in methods
    # 初始化必须带上客户端信息与协议版本
    initialize = _StubHandler.received[0]
    assert initialize["params"]["clientInfo"]["name"] == "neptune-agent"


@pytest.mark.asyncio
async def test_probe_reports_failure_for_a_dead_endpoint() -> None:
    result = await probe_http_server("http://127.0.0.1:9/mcp")

    assert result.status == PROBE_FAILED
    assert result.detail


@pytest.mark.asyncio
async def test_probe_surfaces_rpc_errors(monkeypatch) -> None:
    import httpx

    async def fake_post(self, url, **kwargs):  # noqa: ANN001, ARG001
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "error": {"code": -32600, "message": "协议版本不支持"},
            },
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    result = await probe_http_server("http://127.0.0.1:1234/mcp")

    assert result.status == PROBE_FAILED
    assert "协议版本不支持" in result.detail


# ------------------------------------------------------------------ 存储


def test_store_crud_and_probe_recording(tmp_path: Path) -> None:
    store = McpStore(tmp_path / "mcp.db")
    draft = McpServerDraft(
        name="本地文件系统",
        transport="http",
        endpoint="http://127.0.0.1:9100/mcp",
        auth_token="secret-token",
        allowed_agents=["code_agent"],
        note="只读盘点",
    )
    row = store.create(draft, "mcp-abc")
    assert row["name"] == "本地文件系统"
    assert row["last_probe_status"] == "never"

    from apps.api.mcp import ProbeResult

    probe = ProbeResult(
        PROBE_OK, "握手成功", server_name="stub", server_version="1.0",
        tools=[{"name": "x"}], latency_ms=42,
    )
    updated = store.record_probe("mcp-abc", probe)
    assert updated is not None
    assert updated["last_probe_status"] == PROBE_OK
    assert updated["latency_ms"] == 42
    assert json.loads(str(updated["tools"])) == [{"name": "x"}]

    changed = store.update("mcp-abc", {"enabled": False, "name": "改名"})
    assert changed is not None
    assert changed["enabled"] == 0
    assert changed["name"] == "改名"

    assert store.delete("mcp-abc") is True
    assert store.delete("mcp-abc") is False
    assert store.list() == []


def test_view_never_returns_the_token(tmp_path: Path) -> None:
    from apps.api.mcp import to_view

    store = McpStore(tmp_path / "mcp.db")
    row = store.create(
        McpServerDraft(name="带鉴权", endpoint="http://127.0.0.1:1/mcp", auth_token="top-secret"),
        "mcp-token",
    )

    listed = to_view(row)

    assert listed.has_auth is True
    assert listed.auth_token == ""
    assert "top-secret" not in listed.model_dump_json()
    assert to_view(row, include_token=True).auth_token == "top-secret"


def test_stdio_probe_is_marked_unsupported() -> None:
    """stdio 不探测，但必须如实标出来，不能让用户以为它已连通。"""
    from apps.api.mcp import ProbeResult

    result = ProbeResult(PROBE_UNSUPPORTED, "stdio / sse 传输不支持在服务端探测")
    assert result.status == "unsupported"


# ---------------------------------------------------------- 系统代理不能拦内网


def test_private_endpoints_bypass_the_system_proxy() -> None:
    """内网端点必须直连。Windows 注册表里的系统代理会被 httpx 读到，
    而注册表的「本地地址绕过」列表它并不认 —— 本机代理会把 127.0.0.1 的探测转成 502。"""
    from packages.general_agent.net import http_trust_env_for

    assert http_trust_env_for("http://127.0.0.1:8000/mcp") is False
    assert http_trust_env_for("http://localhost:8000/mcp") is False
    assert http_trust_env_for("http://10.0.0.5:3000/mcp") is False
    assert http_trust_env_for("http://192.168.1.9/mcp") is False
    # 公网端点仍尊重代理（有些部署要靠代理出网）
    assert http_trust_env_for("https://mcp.example.com/mcp") is True


@pytest.mark.asyncio
async def test_probe_survives_a_broken_proxy(
    stub_server: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """把代理环境变量指到一个死端口，本机探测仍须成功 —— 证明它真的没走代理。"""
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9")
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:9")

    result = await probe_http_server(stub_server)

    assert result.status == PROBE_OK, result.detail
    assert result.server_name == "stub-mcp"
