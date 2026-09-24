"""注册端的四道防线：蜜罐、填写时长、图形验证码、邮箱验证。

它们的强度不一样，测试也分开写清楚 —— 前两道只是提高批量注册的成本（可被绕过），
后两道才是真正的一次性凭据校验（过期、错次数、可重放性都在这里盯）。
"""

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from apps.api.auth import AuthService, auth_router, get_auth_service
from apps.api.auth_store import AuthStore
from apps.api.security import hash_password


@pytest.fixture()
def service(tmp_path: Path) -> AuthService:
    svc = AuthService(AuthStore(tmp_path / "auth.db"))
    svc.store.create_user(
        user_id="usr_test",
        username="admin",
        display_name="测试管理员",
        role="admin",
        password_hash=hash_password("admin123"),
    )
    return svc


@pytest.fixture(autouse=True)
def reset_registration_throttle() -> None:
    """按 IP 的注册节流是进程内的全局状态。

    不清掉的话，同一进程里别的测试先跑完就把每小时配额用掉了 —— 表现是"单独跑这个文件全过、
    跑全量就 429"。这本身说明节流是有效的，但测试之间必须隔离。
    """
    from apps.api import auth as auth_module

    auth_module._registration_attempts.clear()
    yield
    auth_module._registration_attempts.clear()


@pytest.fixture()
def client(service: AuthService) -> TestClient:
    application = FastAPI()
    application.include_router(auth_router)
    application.dependency_overrides[get_auth_service] = lambda: service
    return TestClient(application)


def captcha_answer(client: TestClient) -> tuple[str, str]:
    """取一道题并把答案算出来。题目形如「3 + 5 = ?」。"""
    payload = client.get("/api/auth/captcha").json()
    left, _, rest = payload["question"].partition(" + ")
    return payload["challenge_id"], str(int(left) + int(rest.split(" ")[0]))


def register_body(client: TestClient, **overrides: object) -> dict:
    challenge_id, answer = captcha_answer(client)
    body: dict = {
        "username": "new.user",
        "password": "member-pass-1",
        "display_name": "新用户",
        "captcha_id": challenge_id,
        "captcha_answer": answer,
        "form_elapsed_ms": 5000,
    }
    body.update(overrides)
    return body


# ---------------------------------------------------------------- ① 蜜罐


def test_honeypot_field_is_rejected(client: TestClient) -> None:
    """真实用户看不见这个字段，填了基本就是机器人。"""
    response = client.post(
        "/api/auth/register",
        json=register_body(client, website="https://spam.example/promo"),
    )

    assert response.status_code == 400
    assert "校验未通过" in response.json()["detail"]


# ---------------------------------------------------------------- ② 填写时长


@pytest.mark.parametrize("elapsed", [0, 200, 2999])
def test_submitting_too_fast_is_rejected(client: TestClient, elapsed: int) -> None:
    response = client.post(
        "/api/auth/register", json=register_body(client, form_elapsed_ms=elapsed)
    )

    assert response.status_code == 400
    assert "太快" in response.json()["detail"]


def test_absurdly_old_form_is_rejected(client: TestClient) -> None:
    """时间戳被改大（或页面挂了很久）也不收。"""
    response = client.post(
        "/api/auth/register", json=register_body(client, form_elapsed_ms=10 * 60 * 60 * 1000)
    )

    assert response.status_code == 400
    assert "过久" in response.json()["detail"]


# ---------------------------------------------------------------- ③ 图形验证码


def test_missing_captcha_is_rejected(client: TestClient) -> None:
    response = client.post(
        "/api/auth/register", json=register_body(client, captcha_id="", captcha_answer="")
    )

    assert response.status_code == 400
    assert "验证码" in response.json()["detail"]


def test_wrong_captcha_answer_is_rejected(client: TestClient) -> None:
    response = client.post(
        "/api/auth/register", json=register_body(client, captcha_answer="999")
    )

    assert response.status_code == 400
    assert "不正确" in response.json()["detail"]


def test_captcha_cannot_be_reused(client: TestClient) -> None:
    """一次性凭据：用过就作废，否则同一个答案可以被无限刷注册。"""
    body = register_body(client)
    first = client.post("/api/auth/register", json=body)
    assert first.status_code == 201

    second = client.post("/api/auth/register", json={**body, "username": "second.user"})
    assert second.status_code == 400
    assert "已使用过" in second.json()["detail"]


def test_captcha_is_invalidated_after_too_many_wrong_guesses(
    client: TestClient, service: AuthService
) -> None:
    from apps.api.settings import settings

    challenge_id, answer = captcha_answer(client)
    for _ in range(settings.captcha_max_attempts):
        attempt = client.post(
            "/api/auth/register",
            json=register_body(client, captcha_id=challenge_id, captcha_answer="999"),
        )
        assert attempt.status_code == 400

    # 错够了次数：即便这次答对也不放行，必须重新获取
    blocked = client.post(
        "/api/auth/register",
        json=register_body(client, captcha_id=challenge_id, captcha_answer=answer),
    )
    assert blocked.status_code == 429
    assert "次数过多" in blocked.json()["detail"]


# ---------------------------------------------------------------- ④ 邮箱验证


def test_email_code_requires_smtp_configuration(client: TestClient) -> None:
    """没配邮件服务就明确报错 —— 不能假装"验证码已发送"。"""
    response = client.post("/api/auth/email-code", json={"email": "someone@example.com"})

    assert response.status_code == 503
    assert "未配置邮件服务" in response.json()["detail"]


def test_registration_works_without_email_when_smtp_is_missing(client: TestClient) -> None:
    """未配置 SMTP 时不强制邮箱验证，否则没人能注册。"""
    response = client.post("/api/auth/register", json=register_body(client))

    assert response.status_code == 201


def test_bad_email_format_is_rejected(client: TestClient) -> None:
    response = client.post("/api/auth/email-code", json={"email": "not-an-email"})

    assert response.status_code == 422


def test_email_verification_is_enforced_once_smtp_is_configured(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """配了 SMTP 就必须带邮箱与验证码，否则注册直接拒。"""
    from apps.api.settings import settings

    monkeypatch.setattr(settings, "smtp_host", "smtp.example.com")
    monkeypatch.setattr(settings, "smtp_from", "bot@example.com")
    monkeypatch.setattr(settings, "smtp_password", __import__("pydantic").SecretStr("secret"))

    response = client.post(
        "/api/auth/register", json=register_body(client, email="someone@example.com")
    )

    assert response.status_code == 400
    assert "邮箱验证" in response.json()["detail"]


def test_email_code_must_match_the_challenge(
    client: TestClient, service: AuthService, monkeypatch: pytest.MonkeyPatch
) -> None:
    """配好 SMTP 后邮箱验证是强制项：错的拒、对的过。"""
    import time

    from pydantic import SecretStr

    from apps.api.auth import CHALLENGE_EMAIL
    from apps.api.security import hash_token
    from apps.api.settings import settings

    monkeypatch.setattr(settings, "smtp_host", "smtp.example.com")
    monkeypatch.setattr(settings, "smtp_from", "bot@example.com")
    monkeypatch.setattr(settings, "smtp_password", SecretStr("secret"))

    now = int(time.time())
    service.store.create_challenge(
        challenge_id="eml_test",
        kind=CHALLENGE_EMAIL,
        target="someone@example.com",
        secret_hash=hash_token("123456"),
        expires_at=now + 600,
        now=now,
    )

    wrong = client.post(
        "/api/auth/register",
        json=register_body(client, email="someone@example.com", email_code="000000"),
    )
    assert wrong.status_code == 400
    assert "不正确" in wrong.json()["detail"]

    # 同一张凭据答对就能过 —— 也证明上面被拒的原因确实是验证码，而不是别的校验
    ok = client.post(
        "/api/auth/register",
        json=register_body(
            client, username="verified.user", email="someone@example.com", email_code="123456"
        ),
    )
    assert ok.status_code == 201, ok.text


def test_email_is_never_trusted_without_a_matching_code(
    client: TestClient, service: AuthService, monkeypatch: pytest.MonkeyPatch
) -> None:
    """没拿过验证码就直接填邮箱注册 —— 必须被拒（否则邮箱验证形同虚设）。"""
    from pydantic import SecretStr

    from apps.api.settings import settings

    monkeypatch.setattr(settings, "smtp_host", "smtp.example.com")
    monkeypatch.setattr(settings, "smtp_from", "bot@example.com")
    monkeypatch.setattr(settings, "smtp_password", SecretStr("secret"))

    response = client.post(
        "/api/auth/register",
        json=register_body(client, email="unverified@example.com", email_code="123456"),
    )

    assert response.status_code == 400
    assert "邮箱验证码" in response.json()["detail"]
