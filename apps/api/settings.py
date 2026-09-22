from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="APP_", env_file=".env", extra="ignore")

    cors_origins: str = "http://localhost:3000"
    reasoning_provider: str = "local"
    openai_api_key: SecretStr | None = None
    openai_model: str = "gpt-5.4-mini"
    database_path: str = "data/nexus.db"

    # --- 认证（双令牌） ---------------------------------------------------
    # 未设置时会在首次启动生成一个随机密钥并写进数据库，这样 --reload 重启
    # 不会把所有会话踢下线。上云必须显式设置 APP_JWT_SECRET，否则多实例之间
    # 无法互相校验对方签发的令牌。
    jwt_secret: SecretStr | None = None
    access_token_ttl_seconds: int = 30 * 60
    refresh_token_ttl_seconds: int = 24 * 60 * 60
    remember_refresh_token_ttl_seconds: int = 14 * 24 * 60 * 60

    # --- Cookie 传输（浏览器走 cookie，脚本/原生客户端走 Authorization 头）--
    cookie_access_name: str = "nexus_access"
    cookie_refresh_name: str = "nexus_refresh"
    # 刷新令牌必须挂在整个站点上，否则 middleware 无法在服务端做登录跳转。
    cookie_refresh_path: str = "/"
    # 本地是 http://localhost，浏览器会拒绝 Secure cookie，所以默认关闭；
    # 部署到 HTTPS 后设 APP_COOKIE_SECURE=true。
    cookie_secure: bool = False
    # 前后端跨站部署时设 APP_COOKIE_SAMESITE=none（此时必须同时 secure=true）。
    cookie_samesite: str = "lax"
    cookie_domain: str | None = None
    # 允许用 ?access_token= 传令牌（给不支持自定义请求头的 SSE 客户端用）。
    # 令牌会进入访问日志，因此默认关闭；浏览器不需要它，EventSource 会自动带 cookie。
    allow_token_in_query: bool = False

    # --- 首个管理员 -------------------------------------------------------
    admin_username: str = "admin"
    admin_display_name: str = "工作台管理员"
    # 未设置时用 admin123 播种并在启动日志里告警，登录后会被要求改密码。
    admin_password: SecretStr | None = None

    # --- 登录失败锁定 -----------------------------------------------------
    login_max_failures: int = 5
    login_lockout_seconds: int = 60

    # --- 注册 -------------------------------------------------------------
    # 开放注册会带来滥用面：上云建议关闭（APP_ALLOW_REGISTRATION=false），改由管理员建号。
    allow_registration: bool = True
    # 进程内按 IP 节流；多实例部署需要共享存储才能全局生效。
    registration_limit_per_hour: int = 20

    # --- MCP 探测 ---------------------------------------------------------
    # 本机 MCP 服务器基本都在 127.0.0.1，所以默认允许内网/回环；
    # 上云（探测接口对所有登录用户开放）建议设 false，避免被当成 SSRF 跳板。
    mcp_allow_private_endpoints: bool = True

    @property
    def cors_origin_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]


settings = Settings()
