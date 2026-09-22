"""Password hashing and the JWT primitives behind the dual-token session.

Two decisions worth stating out loud:

* Passwords use PBKDF2-HMAC-SHA256 from `hashlib` instead of bcrypt/argon2. That
  keeps the dependency list honest for a project that has to run offline, and
  the stored format is self-describing (`alg$iterations$salt$digest`) so the
  cost factor can be raised later without invalidating existing rows.
* Tokens are HS256 JWTs and *only* HS256. PyJWT is given an explicit algorithm
  allowlist on both ends, which is what closes the classic `alg: none` /
  algorithm-confusion hole: a token that advertises any other header is rejected
  before its payload is trusted.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from dataclasses import dataclass

import jwt

PBKDF2_ALGORITHM = "pbkdf2_sha256"
PBKDF2_ITERATIONS = 240_000
JWT_ALGORITHM = "HS256"

TOKEN_TYPE_ACCESS = "access"
TOKEN_TYPE_REFRESH = "refresh"

# 允许的时钟漂移，避免签发端与校验端有几秒误差就判无效。
CLOCK_SKEW_SECONDS = 5


class InvalidTokenError(Exception):
    """Raised for any token that is malformed, expired, or of the wrong type."""


def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64decode(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + padding)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return "$".join(
        [PBKDF2_ALGORITHM, str(PBKDF2_ITERATIONS), _b64encode(salt), _b64encode(digest)]
    )


def verify_password(password: str, stored: str) -> bool:
    """Constant-time comparison; any malformed row simply fails closed."""
    try:
        algorithm, iterations, salt_b64, digest_b64 = stored.split("$")
        expected = _b64decode(digest_b64)
        salt = _b64decode(salt_b64)
        rounds = int(iterations)
    except (ValueError, TypeError):
        return False
    if algorithm != PBKDF2_ALGORITHM or rounds <= 0:
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
    return hmac.compare_digest(actual, expected)


def new_token_id() -> str:
    return secrets.token_urlsafe(16)


def hash_token(token: str) -> str:
    """Refresh tokens are stored hashed, so a database leak is not a login."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class TokenClaims:
    subject: str
    role: str
    token_type: str
    token_id: str
    issued_at: int
    expires_at: int


def encode_token(
    *,
    secret: str,
    subject: str,
    role: str,
    token_type: str,
    token_id: str,
    ttl_seconds: int,
    now: int | None = None,
) -> tuple[str, int]:
    """Return the encoded token and the epoch second it expires at."""
    issued = int(time.time() if now is None else now)
    expires = issued + int(ttl_seconds)
    payload = {
        "sub": subject,
        "role": role,
        "typ": token_type,
        "jti": token_id,
        "iat": issued,
        "exp": expires,
    }
    return jwt.encode(payload, secret, algorithm=JWT_ALGORITHM), expires


def decode_token(
    *,
    secret: str,
    token: str,
    expected_type: str,
    now: int | None = None,
) -> TokenClaims:
    current = int(time.time() if now is None else now)
    try:
        payload = jwt.decode(
            token,
            secret,
            algorithms=[JWT_ALGORITHM],
            # 自己比对时间戳，这样 leeway 与返回值口径一致。
            options={"verify_exp": False, "verify_iat": False, "require": ["exp", "iat", "sub"]},
        )
    except jwt.PyJWTError as exc:  # 签名错误、格式错误、超长等
        raise InvalidTokenError("令牌无效") from exc

    token_type = payload.get("typ")
    if token_type != expected_type:
        # 访问令牌不能当刷新令牌用，反之亦然——否则短期令牌就能无限续期。
        raise InvalidTokenError("令牌类型不匹配")

    try:
        expires = int(payload["exp"])
        issued = int(payload["iat"])
        subject = str(payload["sub"])
    except (KeyError, TypeError, ValueError) as exc:
        raise InvalidTokenError("令牌声明缺失") from exc

    if expires + CLOCK_SKEW_SECONDS < current:
        raise InvalidTokenError("令牌已过期")
    if issued - CLOCK_SKEW_SECONDS > current:
        raise InvalidTokenError("令牌签发时间异常")

    return TokenClaims(
        subject=subject,
        role=str(payload.get("role") or "member"),
        token_type=token_type,
        token_id=str(payload.get("jti") or ""),
        issued_at=issued,
        expires_at=expires,
    )
