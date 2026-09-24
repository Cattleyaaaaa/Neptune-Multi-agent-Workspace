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
    cookie_access_name: str = "neptune_access"
    cookie_refresh_name: str = "neptune_refresh"
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
    # 访客入口：不注册也能进工作台，但会话只读（写操作一律 403）。
    # 共享演示环境很方便，对外部署建议关闭（APP_ALLOW_GUEST=false）。
    allow_guest: bool = True
    # 进程内按 IP 节流；多实例部署需要共享存储才能全局生效。
    registration_limit_per_hour: int = 20

    # --- 反向代理 / CDN -----------------------------------------------------
    # 只在 Cloudflare 后面（隧道或橙云代理）才打开。打开后优先采信
    # CF-Connecting-IP —— 它由 CF 边缘写入，就是真实客户端 IP；而 X-Forwarded-For
    # 在 CF 后面并不完全可靠（客户端自带的会被拼在最前，末段可能是 CF 边缘地址）。
    # 反过来，不在 CF 后面却开着它，等于让任何人用一个请求头伪造来源、
    # 绕过按 IP 的注册节流，所以**默认关闭**。
    trust_cloudflare_ip: bool = False

    # --- 邮件（注册时的邮箱验证） -------------------------------------------
    # 留空 = 未配置：注册不再要求邮箱验证，/api/auth/email-code 会明确回复"未配置"，
    # 不会假装发过信。465 端口用隐式 SSL；587 端口把 smtp_starttls 打开。
    smtp_host: str = ""
    smtp_port: int = 465
    smtp_username: str = ""
    smtp_password: SecretStr | None = None
    smtp_from: str = ""
    smtp_starttls: bool = False
    smtp_timeout_seconds: float = 10.0

    # --- 注册防滥用 ---------------------------------------------------------
    # 表单从渲染到提交的最短/最长耗时：太快像机器，太久（或时间戳被伪造）也不收。
    registration_min_seconds: float = 3.0
    registration_max_seconds: float = 7200.0
    captcha_ttl_seconds: int = 300
    captcha_max_attempts: int = 5
    email_code_ttl_seconds: int = 600
    email_code_resend_seconds: int = 60
    email_code_hourly_limit: int = 5
    email_code_max_attempts: int = 5

    def smtp_configured(self) -> bool:
        """邮件是否可用 —— 决定注册是否强制验证邮箱，也决定前端是否显示那一栏。"""
        return bool(self.smtp_host and self.smtp_from and self.smtp_password)

    # --- 检索（向量） -------------------------------------------------------
    # local = 本地确定性向量（零依赖、离线可用）；api = 走 embedding 服务，需密钥。
    embedding_provider: str = "local"
    embedding_api_key: SecretStr | None = None
    embedding_model: str = "text-embedding-3-small"
    embedding_base_url: str = "https://api.openai.com/v1"

    # --- 真实写入（执行适配器） --------------------------------------------
    # 文件写入的根目录，也是路径 jail 的边界。留空 = 项目根目录。
    write_root: str = ""
    # HTTP 写入的主机白名单，逗号分隔。留空 = 不限制主机（但内网地址仍会被拦）。
    write_allowed_hosts: str = ""
    # 允许写入内网/回环地址。默认关闭：写接口比读接口更容易被当成 SSRF 跳板。
    write_allow_private_hosts: bool = False
    write_timeout_seconds: float = 15.0

    # --- MCP 探测 ---------------------------------------------------------
    # 本机 MCP 服务器基本都在 127.0.0.1，所以默认允许内网/回环；
    # 上云（探测接口对所有登录用户开放）建议设 false，避免被当成 SSRF 跳板。
    mcp_allow_private_endpoints: bool = True

    @property
    def cors_origin_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]


settings = Settings()
