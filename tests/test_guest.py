"""访客入口的行为契约。

访客是"能看、不能改"的会话：不注册也能进工作台，但任何写操作必须被拒。
这组测试盯住两件容易出错的事：
1. 只读必须是后端强制的 —— 前端禁用不算数，绕过界面直接发请求也要 403；
2. 访客账号不能被当成普通账号用密码登录（它的密码是不可用的随机串）。
"""

from pathlib import Path

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from apps.api.auth import (
    Account,
    AuthService,
    auth_router,
    current_user,
    get_auth_service,
    guest_write_guard,
)
from apps.api.auth_store import AuthStore
from apps.api.security import hash_password
from apps.api.settings import settings


@pytest.fixture()
def app(tmp_path: Path) -> FastAPI:
    """只挂认证路由的应用，外加一个"任意写操作"探针来检验只读守卫。"""
    service = AuthService(AuthStore(tmp_path / "auth.db"))
    service.store.create_user(
        user_id="usr_admin",
        username="admin",
        display_name="管理员",
        role="admin",
        password_hash=hash_password("admin123"),
    )
    application = FastAPI()
    application.include_router(auth_router)

    @application.middleware("http")
    async def guard(request, call_next):  # type: ignore[no-untyped-def]
        return await guest_write_guard(request, call_next)

    @application.post("/api/probe/write")
    async def probe(_: Account = Depends(current_user)) -> dict[str, bool]:
        return {"ok": True}

    application.dependency_overrides[get_auth_service] = lambda: service
    return application


def guest_client(app: FastAPI) -> TestClient:
    client = TestClient(app)
    response = client.post("/api/auth/guest")
    assert response.status_code == 200, response.text
    return client


def test_guest_login_issues_tokens_and_reports_role(app: FastAPI) -> None:
    client = guest_client(app)

    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["user"]["role"] == "guest"


def test_guest_can_read(app: FastAPI) -> None:
    client = guest_client(app)

    assert client.get("/api/auth/me").status_code == 200
    assert client.get("/api/auth/sessions").status_code == 200


def test_guest_cannot_write(app: FastAPI) -> None:
    """只读必须是后端强制的：绕过界面直接发写请求同样要被拒。"""
    client = guest_client(app)

    response = client.post("/api/probe/write")
    assert response.status_code == 403
    assert "只读" in response.json()["detail"]


def test_guest_can_refresh_and_logout(app: FastAPI) -> None:
    """续期与退出不在只读范围内，否则访客一进门就被自己卡住。"""
    client = guest_client(app)

    assert client.post("/api/auth/refresh").status_code == 200
    assert client.post("/api/auth/logout").status_code == 204


def test_member_is_not_affected_by_the_guard(app: FastAPI) -> None:
    client = TestClient(app)
    assert client.post(
        "/api/auth/login", json={"username": "admin", "password": "admin123"}
    ).status_code == 200

    assert client.post("/api/probe/write").status_code == 200


def test_guest_account_cannot_be_used_with_a_password(app: FastAPI) -> None:
    """访客账号的密码是不可用的随机串，用密码登录必须失败。"""
    client = TestClient(app)
    guest_client(app)  # 确保访客账号已创建

    response = client.post(
        "/api/auth/login", json={"username": "guest", "password": "whatever"}
    )
    assert response.status_code == 401


def test_guest_can_be_disabled(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "allow_guest", False)

    response = TestClient(app).post("/api/auth/guest")

    assert response.status_code == 403
    assert "访客" in response.json()["detail"]
