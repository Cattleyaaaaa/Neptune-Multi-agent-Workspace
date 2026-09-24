# Neptune General Agent

一个由 Supervisor 驱动的通用多 Agent 工作台。系统先理解任务和风险，再动态选择研究、数据、软件工程、文档、审查、执行与核验 Agent，高风险动作必须经过人工审批。

默认使用**本地规则模式**，不需要任何模型密钥即可运行完整的多 Agent 编排、计划、交接、审批和审计链；也可通过环境变量启用 OpenAI Responses API，远程推理失败时自动回退到本地推理。

网站入口：http://myneptune.tech/

## 功能亮点

**编排与推理**

- 自动识别研究、数据、代码、文档和通用任务，动态生成 Agent 计划
- 通过能力注册表扩展专业 Agent；Agent 启停实时影响 Planner 的能力选择
- 自由 ReAct 运行模式（thought → 工具 → observation 循环）
- 本地与 OpenAI 两种结构化推理 Provider
- Supervisor 逐步调度并记录交接，独立的质量审查 Agent 与执行后结果核验
- 闲聊与简单问题直接回答，不组建团队、不跑流水线

**工具与执行**

- CSV 数据真实解析与数值统计；代码工作区只读盘点；研究来源和约束提取
- 受控抓取公开 HTTP/HTTPS 文本，拦截本地和私有网络地址（SSRF 防护）
- 真实写入外部系统（HTTP / 文件 / 数据库），带审批门禁、主机白名单、路径 jail 与快照回滚
- MCP 工具接入运行时，Agent 可真正调用
- 向量检索（默认本地零依赖向量，配置 embedding 服务后切换真向量）
- 工具级角色权限与调用审计

**治理与可观测**

- 高风险任务人工审批；规则模式与计划模式
- 任务步数、超时与循环停止条件
- 可观测性、Token 用量、成员与定时任务的真实数据接口
- 运行中心的实时事件流（SSE）：进度、审批与工具调用无需刷新即可更新
- 访客入口：不必注册即可只读浏览，写操作由服务端一律拒绝

**数据与界面**

- SQLite 持久化任务、审批状态和事件；工作台配置支持导出和恢复默认
- 客户端文件导入与任务 JSON 导出
- 工作区目录浏览：写入路径可以像资源管理器一样在界面里选择，选中的路径保证可写
- 工作台共享上下文和匹配的知识文档自动注入新任务
- REST API 与 SSE 事件流

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Python 3.12+ · FastAPI · LangGraph · SSE · SQLite · PyJWT |
| 前端 | Next.js 15 (App Router) · React 19 · TypeScript |
| 包管理 | `uv`（Python）· `pnpm`（monorepo） |

## 本地运行

要求：Python 3.12+、[uv](https://docs.astral.sh/uv/)、Node.js 20+ 和 pnpm。

```powershell
uv sync --dev
pnpm install
uv run uvicorn apps.api.main:app --reload --reload-dir apps --reload-dir packages
pnpm dev:web
```

打开 <http://localhost:3000/workbench> 进入编排管理；其中的运行中心位于 <http://localhost:3000/workbench/runtime>，旧根地址会自动跳转到运行中心。API 文档位于 <http://localhost:8000/docs>。

环境变量说明见 [`.env.example`](.env.example)（所有配置项都有中文注释，均有默认值，本地开发可以零配置启动）。

## 登录

首次启动会自动创建管理员账号：用户名 `admin`，密码来自 `APP_ADMIN_PASSWORD`，未配置时为内置默认值（见 `.env.example`），登录后会被要求立即修改。

会话采用双令牌：30 分钟的访问令牌 + 可吊销、自动轮换的刷新令牌，前端在过期前 90 秒静默续期。细节与上云配置见 [`docs/architecture.md`](docs/architecture.md) 的「认证（双令牌）」一节。

## 验证

```powershell
uv run pytest
uv run ruff check .
pnpm typecheck:web
pnpm lint:web
pnpm build:web
```

## 可选的 OpenAI 推理

```powershell
$env:APP_REASONING_PROVIDER="openai"
$env:APP_OPENAI_API_KEY="你的密钥"
$env:APP_OPENAI_MODEL="gpt-5.4-mini"
uv run uvicorn apps.api.main:app --reload
```

未配置密钥时应用会拒绝以 OpenAI 模式启动，避免静默误配置。

## 工作台页面

侧边栏分四组，共 18 个入口。运行中心、运行审计、运行环境与六个 hash section 直接读写后端接口；标注为「示例数据」的页面使用本地种子数据并写入浏览器 `localStorage`，页面上有明确提示条。

| 分组 | 页面 |
|---|---|
| 运行工作台 | 运行中心、运行审计、定时任务（真调度器，落库并自动触发） |
| 能力构建 | 编排总览、Agent 管理、工作流编排（示例数据）、RAG 知识库（向量检索）、MCP 中心（真实握手 + 运行时接入）、Skill 中心、附件资产（示例数据）、上下文管理、模型与工具 |
| 治理与观测 | 治理策略、可观测性（真实运行统计）、Token 用量（真实运行量；无用量上报时如实说明）、运行环境 |
| 工作区设置 | 成员与角色（真实账号表）、账号设置 |

