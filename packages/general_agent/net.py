"""网络地址安全判定：MCP 探测和执行器写入共用同一套规则。

放在 packages 里是因为两边都要用：apps 依赖 packages，反过来不行。
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


def _resolve(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """把主机名解析成地址；解析不出来返回 None。"""
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        pass
    try:
        return ipaddress.ip_address(socket.gethostbyname(host))
    except (OSError, ValueError):
        return None


def _is_private_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return bool(
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_reserved
    )


def is_private_host(host: str) -> bool:
    """回环 / 私有网段 / 链路本地都算内网。解析失败时按内网处理（宁可拦错）。"""
    if not host:
        return True
    address = _resolve(host)
    return True if address is None else _is_private_address(address)


def host_allowed(host: str, allowed_hosts: tuple[str, ...]) -> bool:
    """白名单为空表示不限制；非空时主机名必须精确命中（小写比较）。"""
    if not allowed_hosts:
        return True
    lowered = host.strip().lower()
    return lowered in {item.strip().lower() for item in allowed_hosts if item.strip()}


def http_trust_env_for(url: str) -> bool:
    """内网端点直连、公网端点才走系统/环境代理。

    背景：Windows 上 urllib 会读到注册表里的系统代理（如 127.0.0.1:7897），httpx
    也认它，但**不认**注册表里的"本地地址绕过"列表 —— 于是发往 127.0.0.1 的 MCP
    探测/调用会被本机代理劫走并回 502。所以内网一律直连。

    与 `is_private_host` 的唯一区别是"解析不出地址"时的默认值：这里交给代理
    （代理侧可能解析得了），而 SSRF 判定必须失败关闭。两个相反的默认值都是有意的。
    """
    host = urlparse(url).hostname or ""
    address = _resolve(host) if host else None
    return True if address is None else not _is_private_address(address)
