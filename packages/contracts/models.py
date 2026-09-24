from typing import Literal

from pydantic import BaseModel, Field


class StartTaskRequest(BaseModel):
    objective: str = Field(min_length=3, max_length=8_000)
    context: str = Field(default="", max_length=20_000)
    execution_mode: Literal["auto", "plan_only"] = "auto"
    max_steps: int = Field(default=12, ge=3, le=30)
    timeout_seconds: int = Field(default=45, ge=5, le=180)
    # 运行 Agent："auto" = Supervisor 按任务类型自动组队；给具体 id 则把计划收敛到该 Agent。
    agent: str = Field(default="auto", max_length=64)
    # 调用方式：是否检索知识库。关掉就只注入工作区上下文，不碰知识库文档。
    use_knowledge_base: bool = True
    # 对话分组：一次对话里的多轮运行共享同一个 id，便于按对话聚合消息。
    conversation_id: str | None = Field(default=None, max_length=64)
    # 真实写入目标：{"kind": "http|file|database", ...}。给出后会追加审批门禁，
    # 批准即真写；不给则执行 Agent 只出执行计划，不做任何写入。
    execution_target: dict[str, object] | None = None
    # dry_run：走完整流程但不落任何副作用，回执里 mode 会标 simulate。
    dry_run: bool = False
    # 运行模式：graph = 固定图编排（默认）；react = 自由 ReAct 循环。
    run_mode: Literal["graph", "react"] = "graph"


class ApprovalDecision(BaseModel):
    decision: Literal["approve", "reject"]
    approver_id: str = Field(min_length=2, max_length=100)
    note: str = Field(default="", max_length=1_000)


class WorkspaceConfig(BaseModel):
    agents: list[dict[str, object]] = Field(default_factory=list)
    knowledge_bases: list[dict[str, object]] = Field(default_factory=list)
    contexts: list[dict[str, object]] = Field(default_factory=list)
    model_routes: list[dict[str, object]] = Field(default_factory=list)
    policies: dict[str, object] = Field(default_factory=dict)
    tools: list[dict[str, object]] = Field(default_factory=list)


class AgentTraceItem(BaseModel):
    agent: str
    role: str
    status: str
    summary: str
    handoff: str | None = None


class TaskPlanStep(BaseModel):
    id: str
    agent: str
    title: str


class ToolTraceItem(BaseModel):
    tool: str
    agent: str
    access: str
    status: str
    summary: str


class SkillView(BaseModel):
    """Skill 中心的一条技能。列表接口只回正文前 400 字，详情接口回全文。"""

    skill_id: str
    name: str
    description: str = ""
    category: str = "本地导入"
    version: str = "1.0.0"
    author: str = "本地导入"
    source: str = "local"
    triggers: list[str] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    filename: str = ""
    size_kb: int = 0
    enabled: bool = False
    created_at: str = ""
    updated_at: str = ""
    content: str = ""


class McpServerDraft(BaseModel):
    """MCP 服务器配置。探测只在 http 传输上做（stdio/sse 见 apps/api/mcp.py 的说明）。"""

    name: str = Field(min_length=1, max_length=64)
    transport: Literal["http", "stdio", "sse"] = "http"
    endpoint: str = Field(min_length=1, max_length=500)
    auth_token: str = Field(default="", max_length=2000)
    allowed_agents: list[str] = Field(default_factory=list)
    note: str = Field(default="", max_length=500)
    enabled: bool = True


class McpServerView(McpServerDraft):
    server_id: str
    # 探测结果：never / ok / failed / unsupported
    last_probe_status: str = "never"
    last_probe_detail: str = ""
    last_probe_at: str = ""
    server_name: str = ""
    server_version: str = ""
    tools: list[dict[str, object]] = Field(default_factory=list)
    latency_ms: int = 0
    has_auth: bool = False
    created_at: str = ""
    updated_at: str = ""


class ScheduleDraft(BaseModel):
    """定时任务。cron 为五段表达式：分 时 日 月 周。"""

    name: str = Field(min_length=1, max_length=64)
    objective: str = Field(min_length=3, max_length=8_000)
    cron: str = Field(min_length=1, max_length=64)
    enabled: bool = True
    agent: str = Field(default="auto", max_length=64)
    use_knowledge_base: bool = True
    execution_mode: Literal["auto", "plan_only"] = "auto"
    run_mode: Literal["graph", "react"] = "graph"
    execution_target: dict[str, object] | None = None


class ScheduleView(ScheduleDraft):
    schedule_id: str
    last_run_at: str = ""
    last_task_id: str = ""
    next_run_at: str = ""
    created_at: str = ""
    updated_at: str = ""


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)
    # 记住我：只影响刷新令牌的有效期，不改变访问令牌的短时效。
    remember: bool = False


# 邮箱不做 DNS 校验（那需要额外的解析库与网络往返），只挡明显不合格式的输入。
EMAIL_PATTERN = r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$"


class CaptchaView(BaseModel):
    """图形验证码：服务端出题，答案只存哈希，一次一用。

    这里顺带告诉前端"这个环境要不要验证邮箱" —— 注册页还没登录，拿不到 /api/system，
    但需要据此决定是否显示邮箱那一栏。
    """

    challenge_id: str
    question: str
    expires_in: int
    email_verification_required: bool = False


class EmailCodeRequest(BaseModel):
    email: str = Field(min_length=5, max_length=254, pattern=EMAIL_PATTERN)


class RegisterRequest(BaseModel):
    """用户名只收 ASCII 可见字符，避免路由与展示层的编码歧义；中文放显示名里。

    注册端有四道防滥用校验（见 docs/architecture.md「注册端防滥用」）：
    蜜罐字段、表单填写时长、图形验证码、邮箱验证码。
    """

    username: str = Field(min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_.-]+$")
    password: str = Field(min_length=8, max_length=256)
    display_name: str | None = Field(default=None, max_length=64)

    # 蜜罐：真实用户看不到这个字段（视觉隐藏 + 不参与 Tab 顺序），机器人往往照填。
    website: str | None = Field(default=None, max_length=200)
    # 表单从渲染到提交的耗时，太快说明是脚本直提。
    form_elapsed_ms: int = Field(default=0, ge=0, le=24 * 60 * 60 * 1000)
    # 图形验证码
    captcha_id: str = Field(default="", max_length=64)
    captcha_answer: str = Field(default="", max_length=12)
    # 邮箱与邮箱验证码（未配置 SMTP 时不强制）
    email: str | None = Field(default=None, max_length=254)
    email_code: str | None = Field(default=None, max_length=12)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=8, max_length=256)


class RefreshRequest(BaseModel):
    """浏览器走 httpOnly cookie，可以不传 body；脚本与原生客户端把刷新令牌放这里。"""

    refresh_token: str | None = Field(default=None, max_length=4096)


class UserView(BaseModel):
    user_id: str
    username: str
    display_name: str
    role: Literal["admin", "member", "guest"]
    must_change_password: bool = False


class TokenPairView(BaseModel):
    """双令牌：短期访问令牌（无状态校验）+ 长期刷新令牌（可吊销、会轮换）。"""

    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    refresh_expires_in: int
    access_expires_at: str
    refresh_expires_at: str
    user: UserView


class MeView(BaseModel):
    user: UserView
    access_expires_at: str
    refresh_expires_at: str


class SessionView(BaseModel):
    session_id: str
    user_agent: str
    client_ip: str
    issued_at: str
    expires_at: str
    current: bool = False


class SessionListView(BaseModel):
    sessions: list[SessionView]
    access_expires_at: str
    refresh_expires_at: str


class TaskView(BaseModel):
    task_id: str
    thread_id: str
    objective: str
    context: str = ""
    execution_mode: str
    max_steps: int
    timeout_seconds: int
    dispatch_count: int = 0
    status: str
    phase: str
    # 对话分组与"运行 Agent"：前端按 conversation_id 聚合消息，按 requested_agent 回显选择。
    conversation_id: str | None = None
    requested_agent: str | None = None
    # 本次知识库检索的结果：{enabled, bases, available, documents:[{base,name}]}
    knowledge: dict[str, object] = Field(default_factory=dict)
    # 注入本次任务的技能名（启用中的技能会拼进上下文）
    applied_skills: list[str] = Field(default_factory=list)
    task_type: str | None = None
    risk_level: str | None = None
    plan: list[TaskPlanStep] = Field(default_factory=list)
    completed_agents: list[str] = Field(default_factory=list)
    artifacts: dict[str, object] = Field(default_factory=dict)
    agent_trace: list[AgentTraceItem] = Field(default_factory=list)
    tool_trace: list[ToolTraceItem] = Field(default_factory=list)
    approval: dict[str, object] = Field(default_factory=dict)
    final_response: str | None = None
    updated_at: str | None = None
