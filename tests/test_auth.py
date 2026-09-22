"""双令牌登录的行为契约。

重点覆盖三件容易做错的事：
1. 访问令牌不能当刷新令牌用——否则短期令牌就能自己续自己；
2. 刷新即轮换，轮换后的旧令牌重放要按泄露处理，连带吊销该账号全部会话；
3. 主动登出留下的陈旧令牌被重放时**不能**连坐其他设备——这是实现时真踩过的坑。
"""

import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr

from apps.api.auth import AuthError, AuthService, auth_router, get_auth_service
from apps.api.auth_store import AuthStore
from apps.api.security import (
    TOKEN_TYPE_ACCESS,
    InvalidTokenError,
    decode_token,
    encode_token,
    hash_password,
    verify_password,
)
from apps.api.settings import settings

USERNAME = "admin"
PASSWORD = "admin123"
NEW_PASSWORD = "Str0nger-Passw0rd"
SECRET = "unit-test-secret-0123456789-abcdefghij"


def build(tmp_path: Path, *, username: str = USERNAME, password: str = PASSWORD) -> AuthService:
    service = AuthService(AuthStore(tmp_path / "auth.db"))
    service.store.create_user(
        user_id="usr_test",
        username=username,
        display_name="测试管理员",
        role="admin",
        password_hash=hash_password(password),
    )
    return service


@pytest.fixture()
def app(tmp_path: Path) -> FastAPI:
    """一个只挂了 auth 路由的应用，数据库指向 tmp_path。"""
    service = build(tmp_path)
    application = FastAPI()
    application.include_router(auth_router)
    application.dependency_overrides[get_auth_service] = lambda: service
    return application


@pytest.fixture()
def service(app: FastAPI) -> AuthService:
    return app.dependency_overrides[get_auth_service]()


def login(
    app: FastAPI,
    *,
    username: str = USERNAME,
    password: str = PASSWORD,
    remember: bool = False,
) -> tuple[TestClient, dict]:
    """每个调用点都拿到独立的 cookie jar，才能模拟"两台设备"。"""
    client = TestClient(app)
    response = client.post(
        "/api/auth/login",
        json={"username": username, "password": password, "remember": remember},
    )
    assert response.status_code == 200, response.text
    return client, response.json()


def issued_tokens(client: TestClient) -> dict[str, str]:
    """从客户端的 cookie jar 里取回令牌，用于重放实验。"""
    return {
        cookie.name: cookie.value
        for cookie in client.cookies.jar
        if cookie.name in {settings.cookie_access_name, settings.cookie_refresh_name}
    }


# ---------------------------------------------------------------- 密码哈希


def test_password_hash_is_salted_and_verifiable() -> None:
    first = hash_password(PASSWORD)
    second = hash_password(PASSWORD)

    assert first != second, "同一密码两次哈希必须不同（盐不同）"
    assert PASSWORD not in first
    assert verify_password(PASSWORD, first)
    assert not verify_password("wrong", first)


@pytest.mark.parametrize("broken", ["", "garbage", "md5$1$aa$bb", "pbkdf2_sha256$0$aa$bb"])
def test_malformed_hash_fails_closed(broken: str) -> None:
    assert not verify_password(PASSWORD, broken)


def test_token_type_and_signature_are_enforced() -> None:
    token, _ = encode_token(
        secret=SECRET,
        subject="usr_test",
        role="admin",
        token_type=TOKEN_TYPE_ACCESS,
        token_id="jti",
        ttl_seconds=60,
    )
    claims = decode_token(secret=SECRET, token=token, expected_type=TOKEN_TYPE_ACCESS)
    assert claims.token_id == "jti"
    with pytest.raises(InvalidTokenError):
        decode_token(secret=SECRET, token=token, expected_type="refresh")
    with pytest.raises(InvalidTokenError):
        decode_token(secret="other-secret", token=token, expected_type=TOKEN_TYPE_ACCESS)


def test_short_jwt_secret_is_refused(tmp_path: Path, monkeypatch) -> None:
    """弱密钥等于没有签名，宁可在启动时就报错。"""
    monkeypatch.setattr(settings, "jwt_secret", SecretStr("too-short"))
    with pytest.raises(ValueError, match="太短"):
        AuthService(AuthStore(tmp_path / "weak.db"))


def test_expired_token_is_rejected() -> None:
    yesterday = int((datetime.now(tz=UTC) - timedelta(days=1)).timestamp())
    token, _ = encode_token(
        secret=SECRET,
        subject="usr_test",
        role="admin",
        token_type=TOKEN_TYPE_ACCESS,
        token_id="jti",
        ttl_seconds=60,
        now=yesterday,
    )
    with pytest.raises(InvalidTokenError):
        decode_token(secret=SECRET, token=token, expected_type=TOKEN_TYPE_ACCESS)


# ------------------------------------------------------------------- 播种


def test_seed_admin_is_idempotent_and_flagged(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(settings, "admin_password", None)
    service = AuthService(AuthStore(tmp_path / "seed.db"))

    service.ensure_seed_admin()
    service.ensure_seed_admin()

    assert service.store.count_users() == 1
    record = service.store.get_user_by_username(settings.admin_username)
    assert record is not None
    assert record["role"] == "admin"
    # 用内置默认密码播种时必须标记为待修改，前端会据此提示
    assert record["must_change_password"] == 1


def test_seed_admin_honours_configured_password(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(settings, "admin_password", SecretStr("from-env-password"))
    service = AuthService(AuthStore(tmp_path / "seed2.db"))
    service.ensure_seed_admin()

    record = service.store.get_user_by_username(settings.admin_username)
    assert record is not None
    assert record["must_change_password"] == 0
    assert verify_password("from-env-password", str(record["password_hash"]))


# --------------------------------------------------------------- 登录契约


def test_login_returns_dual_tokens(app: FastAPI) -> None:
    _, body = login(app, remember=True)

    assert body["token_type"] == "bearer"
    assert body["access_token"] != body["refresh_token"]
    assert body["expires_in"] == settings.access_token_ttl_seconds
    assert body["refresh_expires_in"] == settings.remember_refresh_token_ttl_seconds
    assert body["user"]["username"] == USERNAME
    assert body["user"]["role"] == "admin"


def test_login_sets_http_only_cookies(app: FastAPI) -> None:
    client = TestClient(app)
    response = client.post(
        "/api/auth/login", json={"username": USERNAME, "password": PASSWORD}
    )
    raw = response.headers.get_list("set-cookie")

    assert len(raw) == 2, raw
    assert all("HttpOnly" in item for item in raw)
    assert any(item.startswith(f"{settings.cookie_access_name}=") for item in raw)
    assert any(item.startswith(f"{settings.cookie_refresh_name}=") for item in raw)


def test_remember_flag_controls_the_refresh_lease(app: FastAPI) -> None:
    _, short = login(app, remember=False)
    _, long = login(app, remember=True)

    assert short["refresh_expires_in"] == settings.refresh_token_ttl_seconds
    assert long["refresh_expires_in"] == settings.remember_refresh_token_ttl_seconds


def test_protected_route_rejects_anonymous_and_accepts_both_transports(app: FastAPI) -> None:
    assert TestClient(app).get("/api/auth/me").status_code == 401

    client, body = login(app)
    assert client.get("/api/auth/me").json()["user"]["username"] == USERNAME

    header_only = TestClient(app).get(
        "/api/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"}
    )
    assert header_only.status_code == 200


def test_refresh_token_cannot_be_used_as_an_access_token(app: FastAPI) -> None:
    _, body = login(app)
    anonymous = TestClient(app)

    response = anonymous.get(
        "/api/auth/me", headers={"Authorization": f"Bearer {body['refresh_token']}"}
    )
    assert response.status_code == 401
    replayed_as_access = anonymous.post(
        "/api/auth/refresh", json={"refresh_token": body["access_token"]}
    ).status_code
    assert replayed_as_access == 401


def test_wrong_password_locks_the_account(app: FastAPI) -> None:
    client = TestClient(app)

    for _ in range(settings.login_max_failures):
        attempt = client.post("/api/auth/login", json={"username": USERNAME, "password": "nope"})
        assert attempt.status_code == 401

    locked = client.post("/api/auth/login", json={"username": USERNAME, "password": PASSWORD})
    assert locked.status_code == 429
    assert "Retry-After" in locked.headers


def test_unknown_username_looks_the_same_as_a_wrong_password(app: FastAPI) -> None:
    response = TestClient(app).post(
        "/api/auth/login", json={"username": "nobody", "password": PASSWORD}
    )
    assert response.status_code == 401
    assert response.json()["detail"] == "用户名或密码不正确"


# ------------------------------------------------------------------- 续期


def test_refresh_rotates_both_tokens(app: FastAPI) -> None:
    client, first = login(app, remember=True)

    response = client.post("/api/auth/refresh")
    assert response.status_code == 200
    second = response.json()

    assert second["access_token"] != first["access_token"]
    assert second["refresh_token"] != first["refresh_token"]
    # 滑动续期沿用原租约，反复刷新不会把有效期上限放大
    assert second["refresh_expires_in"] == settings.remember_refresh_token_ttl_seconds


def test_replaying_a_rotated_token_revokes_every_session(
    app: FastAPI, service: AuthService
) -> None:
    client, first = login(app)
    rotated = client.post("/api/auth/refresh").json()

    attacker = TestClient(app)
    replay = attacker.post("/api/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert replay.status_code == 401

    assert service.store.list_active_sessions("usr_test", now=int(time.time())) == []
    # 轮换得到的那一个也一起作废
    assert (
        attacker.post(
            "/api/auth/refresh", json={"refresh_token": rotated["refresh_token"]}
        ).status_code
        == 401
    )


def test_logout_replay_does_not_disconnect_other_devices(
    app: FastAPI, service: AuthService
) -> None:
    """登出后的陈旧令牌属于"客户端还没收到通知"，不等于泄露，不能连坐。"""
    first_client, first = login(app)
    second_client, second = login(app)

    assert first_client.post("/api/auth/logout").status_code == 204

    replay = TestClient(app)
    assert (
        replay.post("/api/auth/refresh", json={"refresh_token": first["refresh_token"]}).status_code
        == 401
    )
    still_signed_in = replay.post(
        "/api/auth/refresh", json={"refresh_token": second["refresh_token"]}
    ).status_code
    assert still_signed_in == 200, "登出其中一个会话不应该影响另一个"
    assert second_client.get("/api/auth/sessions").status_code == 200
    assert len(service.store.list_active_sessions("usr_test", now=int(time.time()))) == 1


def test_logout_clears_the_cookies(app: FastAPI) -> None:
    client, _ = login(app)
    assert client.post("/api/auth/logout").status_code == 204
    # cookie 已被清除，无 body 的 refresh 应该直接说缺令牌
    assert client.post("/api/auth/refresh").status_code == 401


# --------------------------------------------------------------- 会话管理


def test_sessions_listing_marks_current_and_revocation_works(
    app: FastAPI, service: AuthService
) -> None:
    first_client, first = login(app)
    second_client, _ = login(app)

    sessions = second_client.get("/api/auth/sessions").json()["sessions"]
    assert len(sessions) == 2
    assert sum(1 for item in sessions if item["current"]) == 1
    assert all(item["issued_at"].endswith("Z") for item in sessions)

    other = next(item for item in sessions if not item["current"])
    assert second_client.delete(f"/api/auth/sessions/{other['session_id']}").status_code == 204
    assert len(second_client.get("/api/auth/sessions").json()["sessions"]) == 1
    assert len(service.store.list_active_sessions("usr_test", now=int(time.time()))) == 1

    # 被注销会话的刷新令牌立刻失效
    assert (
        TestClient(app)
        .post("/api/auth/refresh", json={"refresh_token": first["refresh_token"]})
        .status_code
        == 401
    )


def test_cannot_revoke_another_accounts_session(app: FastAPI, service: AuthService) -> None:
    service.store.create_user(
        user_id="usr_other",
        username="other",
        display_name="别人",
        role="member",
        password_hash=hash_password("other-pass-1"),
    )
    other_client, _ = login(app, username="other", password="other-pass-1")
    other_session = other_client.get("/api/auth/sessions").json()["sessions"][0]["session_id"]

    admin_client, _ = login(app)
    assert admin_client.delete(f"/api/auth/sessions/{other_session}").status_code == 404
    assert len(other_client.get("/api/auth/sessions").json()["sessions"]) == 1


# --------------------------------------------------------------- 修改密码


def test_change_password_revokes_all_sessions(app: FastAPI) -> None:
    first_client, first = login(app)
    _, second = login(app)

    wrong = first_client.post(
        "/api/auth/change-password",
        json={"current_password": "not-the-password", "new_password": NEW_PASSWORD},
    )
    assert wrong.status_code == 400

    changed = first_client.post(
        "/api/auth/change-password",
        json={"current_password": PASSWORD, "new_password": NEW_PASSWORD},
    )
    assert changed.status_code == 204

    for token in (first["refresh_token"], second["refresh_token"]):
        assert (
            TestClient(app).post("/api/auth/refresh", json={"refresh_token": token}).status_code
            == 401
        )

    fresh = TestClient(app)
    assert (
        fresh.post("/api/auth/login", json={"username": USERNAME, "password": PASSWORD}).status_code
        == 401
    )
    assert (
        fresh.post(
            "/api/auth/login", json={"username": USERNAME, "password": NEW_PASSWORD}
        ).status_code
        == 200
    )


def test_change_password_rejects_reuse_and_short_values(app: FastAPI) -> None:
    client, _ = login(app)
    reused = client.post(
        "/api/auth/change-password",
        json={"current_password": PASSWORD, "new_password": PASSWORD},
    )
    assert reused.status_code == 400

    short = client.post(
        "/api/auth/change-password",
        json={"current_password": PASSWORD, "new_password": "short"},
    )
    assert short.status_code == 422, "长度约束由 pydantic 模型挡住"


# --------------------------------------------------------------- 服务层


def test_disabled_account_cannot_use_its_existing_token(tmp_path: Path) -> None:
    service = build(tmp_path)
    pair = service.login(
        username=USERNAME, password=PASSWORD, remember=False, user_agent="", client_ip=""
    )
    service.store.set_disabled("usr_test", True)

    with pytest.raises(AuthError) as excinfo:
        service.authenticate(token=pair.access_token)
    assert excinfo.value.status_code == 401
    assert excinfo.value.detail == "账号不存在或已停用"


def test_role_is_read_from_the_database_not_the_token(tmp_path: Path) -> None:
    """改权限不该等访问令牌过期：降级后旧令牌里写的 admin 不作数。"""
    service = build(tmp_path)
    pair = service.login(
        username=USERNAME, password=PASSWORD, remember=False, user_agent="", client_ip=""
    )
    assert service.authenticate(token=pair.access_token).role == "admin"

    service.store.set_role("usr_test", "member")
    assert service.authenticate(token=pair.access_token).role == "member"


# ---------------------------------------------------------------- 注册


def test_register_creates_a_member_and_signs_in(app: FastAPI) -> None:
    client = TestClient(app)
    response = client.post(
        "/api/auth/register",
        json={"username": "zhang.wei", "password": "member-pass-1", "display_name": "张维"},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["user"]["username"] == "zhang.wei"
    assert body["user"]["role"] == "member", "自助注册不能拿到管理员"
    assert body["access_token"] != body["refresh_token"]
    # 注册即登录：同一客户端直接能访问受保护接口
    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["user"]["display_name"] == "张维"


def test_register_without_display_name_falls_back_to_username(app: FastAPI) -> None:
    response = TestClient(app).post(
        "/api/auth/register", json={"username": "plain.user", "password": "member-pass-1"}
    )
    assert response.status_code == 201
    assert response.json()["user"]["display_name"] == "plain.user"


def test_register_rejects_duplicate_username(app: FastAPI) -> None:
    response = TestClient(app).post(
        "/api/auth/register", json={"username": USERNAME, "password": "member-pass-1"}
    )
    assert response.status_code == 409


@pytest.mark.parametrize(
    "payload",
    [
        {"username": "ab", "password": "member-pass-1"},  # 用户名太短
        {"username": "有中文", "password": "member-pass-1"},  # 非 ASCII
        {"username": "ok_name", "password": "short"},  # 密码太短
        {"username": "ok_name", "password": "member-pass-1", "display_name": "x" * 65},
    ],
)
def test_register_rejects_invalid_payload(app: FastAPI, payload: dict) -> None:
    assert TestClient(app).post("/api/auth/register", json=payload).status_code == 422


def test_registration_can_be_disabled(app: FastAPI, monkeypatch) -> None:
    from apps.api import auth as auth_module

    monkeypatch.setattr(auth_module.settings, "allow_registration", False)
    response = TestClient(app).post(
        "/api/auth/register", json={"username": "lateuser", "password": "member-pass-1"}
    )
    assert response.status_code == 403
    assert "未开放注册" in response.json()["detail"]


def test_registration_is_throttled_per_ip(app: FastAPI, monkeypatch) -> None:
    from apps.api import auth as auth_module

    monkeypatch.setattr(auth_module.settings, "registration_limit_per_hour", 2)
    auth_module._registration_attempts.clear()
    client = TestClient(app)

    for index in range(2):
        created = client.post(
            "/api/auth/register",
            json={"username": f"user-{index}", "password": "member-pass-1"},
        )
        assert created.status_code == 201

    throttled = client.post(
        "/api/auth/register", json={"username": "user-x", "password": "member-pass-1"}
    )
    assert throttled.status_code == 429
    assert "Retry-After" in throttled.headers
