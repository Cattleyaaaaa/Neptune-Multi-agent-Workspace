"""Dual-token authentication: issue, refresh, revoke, and enforce.

Flow
----
* `POST /api/auth/login`     → short-lived **access** token + long-lived **refresh** token.
  Both are returned in the body (so scripts and native clients can use them) and,
  for browsers, mirrored into httpOnly cookies.
* `POST /api/auth/refresh`   → rotates the refresh token and mints a new access
  token. Sliding renewal: each refresh restarts the original lease, so an active
  session never expires, while an idle one does.
* `POST /api/auth/logout`    → revokes the presented refresh session.
* Replaying an already-rotated refresh token is treated as a leak: every session
  for that account is revoked immediately.

Why two tokens: access tokens are verified statelessly on every request, so they
must be short-lived and cannot be recalled; refresh tokens are checked against
the database, so they *can* be revoked and rotated. The asymmetry is what lets
logout and "log out everywhere" actually mean something.
"""

from __future__ import annotations

import hmac
import logging
import secrets
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security.utils import get_authorization_scheme_param

from apps.api.auth_store import (
    JWT_SECRET_NAME,
    ROLE_ADMIN,
    ROLE_MEMBER,
    AuthStore,
    epoch_to_iso,
)
from apps.api.security import (
    TOKEN_TYPE_ACCESS,
    TOKEN_TYPE_REFRESH,
    InvalidTokenError,
    decode_token,
    encode_token,
    hash_password,
    hash_token,
    new_token_id,
    verify_password,
)
from apps.api.settings import settings
from packages.contracts.models import (
    ChangePasswordRequest,
    LoginRequest,
    MeView,
    RefreshRequest,
    RegisterRequest,
    SessionListView,
    SessionView,
    TokenPairView,
    UserView,
)

logger = logging.getLogger("nexus.auth")

DEFAULT_ADMIN_PASSWORD = "admin123"
_VALID_SAMESITE = {"lax", "strict", "none"}
# HS256 的密钥强度就是签名的全部强度，短密钥等于没有签名。
MIN_SECRET_LENGTH = 32


class AuthError(Exception):
    def __init__(self, status_code: int, detail: str, *, retry_after: int = 0) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.retry_after = retry_after


@dataclass(frozen=True)
class Account:
    user_id: str
    username: str
    display_name: str
    role: str
    must_change_password: bool


@dataclass(frozen=True)
class TokenPair:
    access_token: str
    refresh_token: str
    refresh_token_id: str
    access_expires_at: int
    refresh_expires_at: int


class AuthService:
    def __init__(self, store: AuthStore) -> None:
        self.store = store
        self._secret = self._resolve_secret()

    # --- setup ------------------------------------------------------------
    def _resolve_secret(self) -> str:
        configured = settings.jwt_secret
        if configured is not None and configured.get_secret_value().strip():
            secret = configured.get_secret_value().strip()
            if len(secret) < MIN_SECRET_LENGTH:
                raise ValueError(
                    f"APP_JWT_SECRET 太短（{len(secret)} 字符，至少 {MIN_SECRET_LENGTH}）。"
                    "HS256 的密钥强度就是签名强度本身，短密钥等于没有签名。"
                    '可用 python -c "import secrets;print(secrets.token_urlsafe(48))" 生成。'
                )
            return secret
        # 生成一次并落库：`--reload` 重启、以及单机多进程，都能继续校验旧令牌。
        # 多实例部署必须改用 APP_JWT_SECRET，否则各实例签名不同。
        stored = self.store.get_secret(JWT_SECRET_NAME)
        if stored:
            return stored
        generated = secrets.token_urlsafe(48)
        self.store.put_secret(JWT_SECRET_NAME, generated)
        logger.warning(
            "APP_JWT_SECRET 未配置，已生成随机密钥并写入数据库。"
            "部署到云端请显式设置该变量，否则多实例之间无法互认令牌。"
        )
        return generated

    def ensure_seed_admin(self) -> None:
        """First boot has no users; without a seeded account nobody could log in."""
        if self.store.count_users():
            return
        configured = settings.admin_password.get_secret_value() if settings.admin_password else ""
        password = configured.strip() or DEFAULT_ADMIN_PASSWORD
        self.store.create_user(
            user_id=f"usr_{secrets.token_hex(8)}",
            username=settings.admin_username,
            display_name=settings.admin_display_name,
            role=ROLE_ADMIN,
            password_hash=hash_password(password),
            must_change_password=password == DEFAULT_ADMIN_PASSWORD,
        )
        if password == DEFAULT_ADMIN_PASSWORD:
            logger.warning(
                "已创建初始账号 %s，密码为内置默认值（见 .env.example）。"
                "该账号已被标记为必须修改密码，请登录后立即在「账号设置」中更换，"
                "或改用 APP_ADMIN_PASSWORD 指定初始密码。",
                settings.admin_username,
            )
        else:
            logger.info("已按 APP_ADMIN_PASSWORD 创建初始账号 %s", settings.admin_username)

    # --- login / refresh / logout ----------------------------------------
    def login(
        self,
        *,
        username: str,
        password: str,
        remember: bool,
        user_agent: str,
        client_ip: str,
    ) -> TokenPair:
        now = int(time.time())
        record = self.store.get_user_by_username(username)
        if record is None:
            # 走一遍同等开销的哈希，避免用响应时间枚举出哪些用户名存在。
            hash_password(password)
            raise AuthError(status.HTTP_401_UNAUTHORIZED, "用户名或密码不正确")

        user_id = str(record["user_id"])
        if int(record["disabled"] or 0):
            raise AuthError(status.HTTP_403_FORBIDDEN, "该账号已被停用")

        locked_until = int(record["locked_until"] or 0)
        if locked_until > now:
            raise AuthError(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "登录失败次数过多，请稍后再试",
                retry_after=locked_until - now,
            )

        if not verify_password(password, str(record["password_hash"])):
            self.store.register_failure(
                user_id,
                max_failures=settings.login_max_failures,
                lockout_seconds=settings.login_lockout_seconds,
                now=now,
            )
            raise AuthError(status.HTTP_401_UNAUTHORIZED, "用户名或密码不正确")

        self.store.mark_login_success(user_id)
        self.store.prune_refreshes(now=now)
        return self._issue_pair(
            self._account(record),
            remember=remember,
            user_agent=user_agent,
            client_ip=client_ip,
        )

    def register(
        self,
        *,
        username: str,
        password: str,
        display_name: str | None,
        user_agent: str,
        client_ip: str,
    ) -> TokenPair:
        """自助注册：永远只给 member 角色，管理员只能由播种或后台创建。

        注册成功即登录（返回双令牌），否则用户还得再输一次密码，没这个必要。
        """
        if not settings.allow_registration:
            raise AuthError(
                status.HTTP_403_FORBIDDEN, "当前环境未开放注册，请联系管理员创建账号"
            )
        try:
            self.store.create_user(
                user_id=f"usr_{secrets.token_hex(8)}",
                username=username,
                display_name=(display_name or "").strip() or username,
                role=ROLE_MEMBER,
                password_hash=hash_password(password),
            )
        except sqlite3.IntegrityError as exc:
            # 用户名唯一索引兜底：先查后建之间仍可能有并发注册
            raise AuthError(status.HTTP_409_CONFLICT, "该用户名已被占用") from exc
        record = self.store.get_user_by_username(username)
        if record is None:  # 理论上不可能，防御一下
            raise AuthError(status.HTTP_500_INTERNAL_SERVER_ERROR, "注册失败，请重试")
        self.store.mark_login_success(str(record["user_id"]))
        logger.info("新账号注册：%s（%s）", username, ROLE_MEMBER)
        return self._issue_pair(
            self._account(record), user_agent=user_agent, client_ip=client_ip
        )

    def refresh(self, *, token: str, user_agent: str, client_ip: str) -> TokenPair:
        now = int(time.time())
        try:
            claims = decode_token(
                secret=self._secret, token=token, expected_type=TOKEN_TYPE_REFRESH
            )
        except InvalidTokenError as exc:
            raise AuthError(status.HTTP_401_UNAUTHORIZED, "刷新令牌无效或已过期") from exc

        row = self.store.get_refresh(claims.token_id)
        if row is None or not hmac.compare_digest(str(row["token_hash"]), hash_token(token)):
            raise AuthError(status.HTTP_401_UNAUTHORIZED, "会话不存在，请重新登录")

        if int(row["revoked_at"] or 0):
            # 只有"轮换后的旧令牌再次出现"才是泄露信号（replaced_by 有值）。
            # 主动登出/注销会话留下的令牌被重放是正常的（比如关掉的页面又发了一次请求），
            # 那种情况只回 401，不能连带把用户其他设备一起踢下线。
            if row["replaced_by"]:
                revoked = self.store.revoke_all_refreshes(claims.subject, now=now)
                logger.warning(
                    "检测到刷新令牌重放，已吊销账号 %s 的 %d 个会话", claims.subject, revoked
                )
            raise AuthError(status.HTTP_401_UNAUTHORIZED, "会话已失效，请重新登录")

        if int(row["expires_at"]) <= now:
            self.store.revoke_refresh(claims.token_id, now=now)
            raise AuthError(status.HTTP_401_UNAUTHORIZED, "刷新令牌已过期，请重新登录")

        record = self.store.get_user(claims.subject)
        if record is None or int(record["disabled"] or 0):
            raise AuthError(status.HTTP_401_UNAUTHORIZED, "账号不存在或已停用")

        # 滑动续期沿用原租约长度，不会因为反复刷新而无限放大有效期上限。
        lease = int(row["ttl_seconds"] or 0) or settings.refresh_token_ttl_seconds
        pair = self._issue_pair(
            self._account(record),
            lease_seconds=lease,
            user_agent=user_agent or str(row["user_agent"] or ""),
            client_ip=client_ip or str(row["client_ip"] or ""),
        )
        self.store.revoke_refresh(claims.token_id, replaced_by=pair.refresh_token_id, now=now)
        return pair

    def logout(self, *, token: str) -> None:
        if not token:
            return
        try:
            claims = decode_token(
                secret=self._secret, token=token, expected_type=TOKEN_TYPE_REFRESH
            )
        except InvalidTokenError:
            # 过期或伪造的令牌没什么可吊销的，但登出必须幂等成功。
            return
        self.store.revoke_refresh(claims.token_id, now=int(time.time()))

    def authenticate(self, *, token: str) -> Account:
        try:
            claims = decode_token(
                secret=self._secret, token=token, expected_type=TOKEN_TYPE_ACCESS
            )
        except InvalidTokenError as exc:
            raise AuthError(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc
        record = self.store.get_user(claims.subject)
        if record is None or int(record["disabled"] or 0):
            raise AuthError(status.HTTP_401_UNAUTHORIZED, "账号不存在或已停用")
        # 角色以数据库为准，改权限不必等访问令牌过期。
        return self._account(record)

    # --- password and sessions -------------------------------------------
    def change_password(self, *, account: Account, current: str, new: str) -> None:
        record = self.store.get_user(account.user_id)
        if record is None:
            raise AuthError(status.HTTP_404_NOT_FOUND, "账号不存在")
        if not verify_password(current, str(record["password_hash"])):
            raise AuthError(status.HTTP_400_BAD_REQUEST, "当前密码不正确")
        if verify_password(new, str(record["password_hash"])):
            raise AuthError(status.HTTP_400_BAD_REQUEST, "新密码不能与当前密码相同")

        self.store.set_password(account.user_id, hash_password(new))
        # 改密码意味着"我怀疑旧凭据已泄露"，因此连同当前会话一起注销，全部设备重新登录。
        revoked = self.store.revoke_all_refreshes(account.user_id, now=int(time.time()))
        logger.info("账号 %s 已修改密码，吊销 %d 个会话", account.username, revoked)

    def list_sessions(self, *, account: Account, current_token: str) -> list[dict[str, object]]:
        now = int(time.time())
        current_id = self._token_id(current_token)
        rows = self.store.list_active_sessions(account.user_id, now=now)
        return [
            {
                "session_id": str(row["token_id"]),
                "user_agent": str(row["user_agent"] or ""),
                "client_ip": str(row["client_ip"] or ""),
                "issued_at": epoch_to_iso(int(row["issued_at"])),
                "expires_at": epoch_to_iso(int(row["expires_at"])),
                "current": str(row["token_id"]) == current_id,
            }
            for row in rows
        ]

    def revoke_session(self, *, account: Account, session_id: str) -> bool:
        row = self.store.get_refresh(session_id)
        if row is None or str(row["user_id"]) != account.user_id:
            raise AuthError(status.HTTP_404_NOT_FOUND, "会话不存在")
        self.store.revoke_refresh(session_id, now=int(time.time()))
        return True

    # --- internals --------------------------------------------------------
    def _account(self, record: dict[str, object]) -> Account:
        return Account(
            user_id=str(record["user_id"]),
            username=str(record["username"]),
            display_name=str(record["display_name"] or record["username"]),
            role=str(record["role"] or "member"),
            must_change_password=bool(int(record["must_change_password"] or 0)),
        )

    def _token_id(self, token: str) -> str:
        if not token:
            return ""
        try:
            return decode_token(
                secret=self._secret, token=token, expected_type=TOKEN_TYPE_REFRESH
            ).token_id
        except InvalidTokenError:
            return ""

    # 下面两个是给路由层读"这个令牌什么时候过期"用的；令牌不可解析时返回空值，
    # 让接口可以照常返回其余信息，而不是整条请求失败。
    def token_id(self, token: str) -> str:
        return self._token_id(token)

    def token_expiry(self, token: str, *, refresh: bool = False) -> int:
        if not token:
            return 0
        try:
            return decode_token(
                secret=self._secret,
                token=token,
                expected_type=TOKEN_TYPE_REFRESH if refresh else TOKEN_TYPE_ACCESS,
            ).expires_at
        except InvalidTokenError:
            return 0

    def _issue_pair(
        self,
        account: Account,
        *,
        remember: bool = False,
        lease_seconds: int | None = None,
        user_agent: str = "",
        client_ip: str = "",
    ) -> TokenPair:
        now = int(time.time())
        lease = lease_seconds or (
            settings.remember_refresh_token_ttl_seconds
            if remember
            else settings.refresh_token_ttl_seconds
        )
        access_token, access_expires = encode_token(
            secret=self._secret,
            subject=account.user_id,
            role=account.role,
            token_type=TOKEN_TYPE_ACCESS,
            token_id=new_token_id(),
            ttl_seconds=settings.access_token_ttl_seconds,
            now=now,
        )
        refresh_token_id = new_token_id()
        refresh_token, refresh_expires = encode_token(
            secret=self._secret,
            subject=account.user_id,
            role=account.role,
            token_type=TOKEN_TYPE_REFRESH,
            token_id=refresh_token_id,
            ttl_seconds=lease,
            now=now,
        )
        self.store.insert_refresh(
            token_id=refresh_token_id,
            user_id=account.user_id,
            token_hash=hash_token(refresh_token),
            issued_at=now,
            expires_at=refresh_expires,
            ttl_seconds=int(lease),
            user_agent=user_agent,
            client_ip=client_ip,
        )
        return TokenPair(
            access_token=access_token,
            refresh_token=refresh_token,
            refresh_token_id=refresh_token_id,
            access_expires_at=access_expires,
            refresh_expires_at=refresh_expires,
        )


# --- request plumbing ----------------------------------------------------
def _extract_access_token(request: Request) -> str:
    scheme, token = get_authorization_scheme_param(request.headers.get("authorization", ""))
    if scheme.lower() == "bearer" and token:
        return token
    cookie = request.cookies.get(settings.cookie_access_name)
    if cookie:
        return cookie
    if settings.allow_token_in_query:
        query_token = request.query_params.get("access_token")
        if query_token:
            return query_token
    return ""


def extract_refresh_token(request: Request, body_token: str | None = None) -> str:
    """浏览器走 httpOnly cookie；脚本可以放在 body 或 Authorization 头里。"""
    scheme, header_token = get_authorization_scheme_param(
        request.headers.get("authorization", "")
    )
    if scheme.lower() == "bearer" and header_token:
        return header_token
    if body_token:
        return body_token
    return request.cookies.get(settings.cookie_refresh_name, "")


def _samesite() -> str:
    value = settings.cookie_samesite.strip().lower()
    return value if value in _VALID_SAMESITE else "lax"


def set_auth_cookies(response: Response, pair: TokenPair) -> None:
    now = int(time.time())
    common = {
        "httponly": True,
        "secure": settings.cookie_secure,
        "samesite": _samesite(),
        "domain": settings.cookie_domain,
    }
    response.set_cookie(
        settings.cookie_access_name,
        pair.access_token,
        max_age=max(1, pair.access_expires_at - now),
        path="/",
        **common,
    )
    response.set_cookie(
        settings.cookie_refresh_name,
        pair.refresh_token,
        max_age=max(1, pair.refresh_expires_at - now),
        path=settings.cookie_refresh_path,
        **common,
    )


def clear_auth_cookies(response: Response) -> None:
    common = {
        "httponly": True,
        "secure": settings.cookie_secure,
        "samesite": _samesite(),
        "domain": settings.cookie_domain,
    }
    response.delete_cookie(settings.cookie_access_name, path="/", **common)
    response.delete_cookie(
        settings.cookie_refresh_name, path=settings.cookie_refresh_path, **common
    )


def _to_http_error(exc: AuthError) -> HTTPException:
    headers = {"WWW-Authenticate": "Bearer"}
    if exc.retry_after:
        headers["Retry-After"] = str(exc.retry_after)
    return HTTPException(status_code=exc.status_code, detail=exc.detail, headers=headers)


_service: AuthService | None = None


def get_auth_service() -> AuthService:
    """FastAPI dependency. Lazy on purpose: importing the module must not touch
    the database, and tests can point it at a throwaway store through
    `app.dependency_overrides[get_auth_service]`."""
    global _service
    if _service is None:
        _service = AuthService(AuthStore(Path(settings.database_path)))
    return _service


def ensure_seed_admin() -> None:
    get_auth_service().ensure_seed_admin()


async def current_user(
    request: Request, service: AuthService = Depends(get_auth_service)
) -> Account:
    """Dependency for every protected route."""
    token = _extract_access_token(request)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="未登录或登录已过期",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        return service.authenticate(token=token)
    except AuthError as exc:
        raise _to_http_error(exc) from exc


def require_admin(account: Account = Depends(current_user)) -> Account:
    if account.role != ROLE_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要管理员权限")
    return account


def _user_view(account: Account) -> UserView:
    return UserView(
        user_id=account.user_id,
        username=account.username,
        display_name=account.display_name,
        role=ROLE_ADMIN if account.role == ROLE_ADMIN else "member",
        must_change_password=account.must_change_password,
    )


def _pair_view(pair: TokenPair, account: Account) -> TokenPairView:
    now = int(time.time())
    return TokenPairView(
        access_token=pair.access_token,
        refresh_token=pair.refresh_token,
        token_type="bearer",
        expires_in=max(0, pair.access_expires_at - now),
        refresh_expires_in=max(0, pair.refresh_expires_at - now),
        access_expires_at=epoch_to_iso(pair.access_expires_at),
        refresh_expires_at=epoch_to_iso(pair.refresh_expires_at),
        user=_user_view(account),
    )


def _client_ip(request: Request) -> str:
    """Trusts X-Forwarded-For only because a reverse proxy is the expected
    deployment; without one the header is attacker-controlled, so it is recorded
    for display only and never used for authorisation."""
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else ""


# 注册是匿名接口，必须节流。用进程内滑窗就够本地用；多实例要换成共享存储。
_registration_attempts: dict[str, list[float]] = {}


def _throttle_registration(client_ip: str) -> None:
    limit = max(1, settings.registration_limit_per_hour)
    window = 3600.0
    now = time.monotonic()
    recent = [t for t in _registration_attempts.get(client_ip, []) if now - t < window]
    if len(recent) >= limit:
        raise AuthError(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "注册过于频繁，请稍后再试",
            retry_after=max(1, int(window - (now - recent[0]))),
        )
    recent.append(now)
    _registration_attempts[client_ip] = recent


auth_router = APIRouter(prefix="/api/auth", tags=["auth"])


@auth_router.post("/login", response_model=TokenPairView)
async def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    service: AuthService = Depends(get_auth_service),
) -> TokenPairView:
    try:
        pair = service.login(
            username=payload.username,
            password=payload.password,
            remember=payload.remember,
            user_agent=request.headers.get("user-agent", ""),
            client_ip=_client_ip(request),
        )
    except AuthError as exc:
        raise _to_http_error(exc) from exc
    account = service.authenticate(token=pair.access_token)
    set_auth_cookies(response, pair)
    return _pair_view(pair, account)


@auth_router.post("/register", response_model=TokenPairView, status_code=status.HTTP_201_CREATED)
async def register(
    payload: RegisterRequest,
    request: Request,
    response: Response,
    service: AuthService = Depends(get_auth_service),
) -> TokenPairView:
    ip = _client_ip(request)
    try:
        _throttle_registration(ip)
        pair = service.register(
            username=payload.username,
            password=payload.password,
            display_name=payload.display_name,
            user_agent=request.headers.get("user-agent", ""),
            client_ip=ip,
        )
    except AuthError as exc:
        raise _to_http_error(exc) from exc
    account = service.authenticate(token=pair.access_token)
    set_auth_cookies(response, pair)
    return _pair_view(pair, account)


@auth_router.post("/refresh", response_model=TokenPairView)
async def refresh(
    request: Request,
    response: Response,
    payload: RefreshRequest | None = None,
    service: AuthService = Depends(get_auth_service),
) -> TokenPairView:
    token = extract_refresh_token(request, payload.refresh_token if payload else None)
    if not token:
        clear_auth_cookies(response)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="缺少刷新令牌",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        pair = service.refresh(
            token=token,
            user_agent=request.headers.get("user-agent", ""),
            client_ip=_client_ip(request),
        )
    except AuthError as exc:
        # 令牌已不可用，顺手把浏览器里那两个失效 cookie 清掉，避免反复重试。
        clear_auth_cookies(response)
        raise _to_http_error(exc) from exc
    account = service.authenticate(token=pair.access_token)
    set_auth_cookies(response, pair)
    return _pair_view(pair, account)


@auth_router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    response: Response,
    payload: RefreshRequest | None = None,
    service: AuthService = Depends(get_auth_service),
) -> Response:
    token = extract_refresh_token(request, payload.refresh_token if payload else None)
    service.logout(token=token)
    clear_auth_cookies(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@auth_router.get("/me", response_model=MeView)
async def me(
    request: Request,
    account: Account = Depends(current_user),
    service: AuthService = Depends(get_auth_service),
) -> MeView:
    # 把两个令牌的到期时间回给前端，让它能在访问令牌过期前主动续期，
    # 而不是等某个请求先吃一次 401。
    return MeView(
        user=_user_view(account),
        access_expires_at=epoch_to_iso(service.token_expiry(_extract_access_token(request))),
        refresh_expires_at=epoch_to_iso(
            service.token_expiry(extract_refresh_token(request), refresh=True)
        ),
    )


@auth_router.post("/change-password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    payload: ChangePasswordRequest,
    response: Response,
    account: Account = Depends(current_user),
    service: AuthService = Depends(get_auth_service),
) -> Response:
    try:
        service.change_password(
            account=account, current=payload.current_password, new=payload.new_password
        )
    except AuthError as exc:
        raise _to_http_error(exc) from exc
    clear_auth_cookies(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@auth_router.get("/sessions", response_model=SessionListView)
async def list_sessions(
    request: Request,
    account: Account = Depends(current_user),
    service: AuthService = Depends(get_auth_service),
) -> SessionListView:
    current_token = extract_refresh_token(request)
    rows = service.list_sessions(account=account, current_token=current_token)
    return SessionListView(
        sessions=[SessionView(**row) for row in rows],
        access_expires_at=epoch_to_iso(service.token_expiry(_extract_access_token(request))),
        refresh_expires_at=epoch_to_iso(service.token_expiry(current_token, refresh=True)),
    )


@auth_router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_session(
    session_id: str,
    request: Request,
    response: Response,
    account: Account = Depends(current_user),
    service: AuthService = Depends(get_auth_service),
) -> Response:
    try:
        service.revoke_session(account=account, session_id=session_id)
    except AuthError as exc:
        raise _to_http_error(exc) from exc
    # 踢掉的如果是自己，就没必要留着 cookie 了。
    if service.token_id(extract_refresh_token(request)) == session_id:
        clear_auth_cookies(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response
