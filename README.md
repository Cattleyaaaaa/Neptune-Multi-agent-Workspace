# Nexus General Agent

一个由 Supervisor 驱动的通用多 Agent 工作台。系统先理解任务和风险，再动态选择研究、数据、软件工程、文档、审查、执行与核验 Agent。高风险动作必须经过人工审批。

当前版本默认使用本地规则模式，能够运行完整的多 Agent 编排、计划、交接、审批和审计链，不需要模型密钥。也可通过环境变量启用 OpenAI Responses API；远程推理失败时会回退到本地推理。

## 本地运行

要求：Python 3.12+、`uv`、Node.js 20+ 和 `pnpm`。

```powershell
uv sync --dev
pnpm install
uv run uvicorn apps.api.main:app --reload --reload-dir apps --reload-dir packages
pnpm dev:web
```

打开 <http://localhost:3000/workbench> 进入编排管理；其中的运行中心位于 <http://localhost:3000/workbench/runtime>。旧根地址会自动跳转到运行中心。API 文档位于 <http://localhost:8000/docs>。

## 登录

首次启动会自动创建管理员账号：用户名 `admin`，密码来自 `APP_ADMIN_PASSWORD`，未配置时为内置默认值（见 `.env.example`），登录后会被要求立即修改。会话采用双令牌：30 分钟的访问令牌 + 可吊销、自动轮换的刷新令牌，前端在过期前 90 秒静默续期。细节与上云配置见 `docs/architecture.md` 的「认证（双令牌）」一节。

## 验证

```powershell
uv run pytest
uv run ruff check .
pnpm typecheck:web
pnpm lint:web
pnpm build:web
```

## 当前能力

- 自动识别研究、数据、代码、文档和通用任务
- 根据任务类型动态生成 Agent 计划
- 通过能力注册表扩展专业 Agent
- CSV 数据真实解析与数值统计
- 代码工作区只读盘点
- 研究来源和约束提取
- 受控抓取公开 HTTP/HTTPS 文本，拦截本地和私有网络地址
- 工具级角色权限与调用审计
- 本地与 OpenAI 两种结构化推理 Provider
- Supervisor 逐步调度并记录交接
- 独立质量审查 Agent
- 高风险任务人工审批
- 执行后结果核验
- REST API 与 SSE 事件流
- SQLite 任务、审批状态和事件持久化
- 客户端文件导入与任务 JSON 导出
- 任务步数、超时与循环停止条件
- 规则模式与计划模式
- 独立的编排管理页面，统一管理 Agent、RAG、上下文、模型、工具与治理策略
- Agent 启停实时影响 Planner 的能力选择
- 工作台共享上下文和匹配的知识文档自动注入新任务
- 工作台配置保存在 SQLite，并支持导出和恢复默认值

## 工作台页面

侧边栏分四组，共 18 个入口。运行中心、运行审计、运行环境与六个 hash section 直接读写后端接口；标注为「示例数据」的页面使用本地种子数据并写入浏览器 `localStorage`，页面上有明确提示条。

| 分组 | 页面 |
|---|---|
| 运行工作台 | 运行中心、运行审计、定时任务（示例数据） |
| 能力构建 | 编排总览、Agent 管理、工作流编排（示例数据）、RAG 知识库、MCP 中心（示例数据）、Skill 中心（示例数据）、附件资产（示例数据）、上下文管理、模型与工具 |
| 治理与观测 | 治理策略、可观测性（示例数据）、Token 用量（示例数据）、运行环境 |
| 工作区设置 | 租户与成员（示例数据）、账号设置（示例数据） |

页面与数据来源的完整对照见 [`docs/architecture.md`](docs/architecture.md#工作台信息架构)。

## 可选的 OpenAI 推理

```powershell
$env:APP_REASONING_PROVIDER="openai"
$env:APP_OPENAI_API_KEY="你的密钥"
$env:APP_OPENAI_MODEL="gpt-5.4-mini"
uv run uvicorn apps.api.main:app --reload
```

未配置密钥时应用会拒绝以 OpenAI 模式启动，避免静默误配置。外部执行仍采用审批后的模拟回执；接入真实业务系统时，应在执行工具中配置目标系统凭据和幂等策略。

设计与扩展说明见 [`docs/architecture.md`](docs/architecture.md)。
