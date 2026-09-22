# 项目长期记忆：Nexus General Agent

## ⚠️ 用户硬性约束（最高优先级 · 2026-09-18 起）
**禁止向 C 盘写入任何内容。** 日志、临时文件、构建产物一律放 **F 盘**。
- **坑 1**：Git Bash 的 `/tmp` = `C:/Users/ASUS/AppData/Local/Temp`，`> /tmp/xxx.log` 就是写 C 盘 → 用项目内 `F:/Codex Files/agent/.tmp/`。
- **坑 2**：`TEMP`/`TMP`/`TMPDIR` 默认指向 C 盘，是"临时文件跑 C 盘"的根源，必须改。
- **坑 3**：`corepack` 的 shell shim 在 Git Bash 下会把路径拼成 `F:\c\Users\...` → `MODULE_NOT_FOUND`；直接调 `node .../corepack/dist/corepack.js`。

### 缓存/临时目录落点（已落地，别重复配）
- uv：`pyproject.toml` 的 `[tool.uv] cache-dir = ".uv-cache"`；解释器 `UV_PYTHON_INSTALL_DIR` → `…/.uv-python`。
- npm/pnpm：项目根 `.npmrc` 的 `cache`/`store-dir` → `…/.cache/*`、`F:/.pnpm-store`（**这个 store 别动**，node_modules 依赖它）。
- 临时文件：env `TMPDIR`/`TEMP`/`TMP` → `F:/Codex Files/agent/.tmp`；`COREPACK_HOME`；`PIP_CACHE_DIR`。
- 一键设置：`source .workbuddy/env.local.sh`（含 TEMP/缓存 + `pnpm` 包装函数）。
- ⚠️ **`uv.toml` 与 `pyproject.toml` 的 `[tool.uv]` 二选一**，同时存在时 uv.toml 整体压掉后者（连 index 镜像一起丢）。现用 pyproject。
- ⚠️ **本会话环境的 `.workbuddy/` 会被周期性清空**（9-18、9-20 各一次）：MEMORY.md / 日志 / env.local.sh 消失。每次开工先检查 `.workbuddy/memory/MEMORY.md` 是否存在，没了就按记忆重建。

## 项目定位
Supervisor 驱动的通用多 Agent 工作台：先理解任务与风险，再动态选择研究/数据/软件工程/文档/审查 Agent；高风险动作必须人工审批。

## 技术栈
- 后端：Python 3.12+，FastAPI + uvicorn，LangGraph StateGraph，Pydantic/pydantic-settings，PyJWT
- 前端：Next.js 15 + React 19 + TS，@phosphor-icons/react
- 包管理：Python 用 `uv`，Node 用 pnpm（monorepo）
- 存储：SQLite（`data/nexus.db`）：tasks / events / workspace_config / users / refresh_tokens / app_secrets

## 核心设计约定（不要破坏）
- Planner 只能从 `CapabilityRegistry` 已声明能力里组队（capabilities.py：research/data/code/document/review 五类 + 高风险追加 approval_gate/execution/verification）；Supervisor 只做交接/完成判断/停止条件
- 工具绑定 `allowed_agents`，越权抛 `ToolPermissionError`；所有调用写 `tool_trace`
- Execution 是**模拟回执**，不伪造真实外部写入；高风险任务用 LangGraph `interrupt` 等审批
- **后端 `phase` 是流水线真相**：`intake→planning→dispatching→researching/…/reviewing→approval→executing→verifying`，终态 `completed/planned/rejected/needs_human`
- 诚实边界：治理页只把真生效的项标为系统项；上下文管理只注入 `enabled/scope/content`（顺序是真功能）；Agent 候选必须来自 `/api/system`；不放假开关（双因素开关已删）

## 运行中心（对话式，2026-09-20 改版）
- **`/workbench/runtime` 是对话界面**：左对话列表（复用 `.sessions`）+ 右「控制条 + 对话流 + 输入条」；外层仍用 `.runtime-shell`（含 `sessions-open` 窄屏抽屉），别改这个类名。用户气泡靠右（品牌绿），Agent 回复靠左（白底 + 左侧状态色条），**审批内联成一张卡片**。
- **步骤搬到独立页 `/workbench/runtime/[taskId]`**（`运行步骤`）：复用 `TaskDetail`（阶段 tabs + 计划 + 协作 + 工具 + 交付物）+ 顶部 `steps-meta` 显示状态/模式/运行 Agent/知识库/风险。消息卡底部「查看步骤」进入；`workbench-bar.tsx` 已删除（死代码）。
- **三个运行控制项都是真的**（`StartTaskRequest`）：`agent`（auto=Supervisor 组队；给 id 则 `plan_for(only_agent=...)` 把计划收敛到该 Agent，绕过任务类型过滤但尊重禁用，禁用时回退并在 trace 说明）、`use_knowledge_base`、`conversation_id`（多轮共享，前端把最近几轮压成 `context` 带上 → 连续追问真生效）。
- **运行 Agent 候选必须来自 `/api/system` 的 capabilities**，禁用状态叠加 `/api/workspace` 的 agents。
- **RAG 真联动**：`WorkspaceService.managed_context(objective, use_knowledge_base)` 返回文本 + `knowledge` 明细（enabled/bases/available/documents），任务里落 `knowledge` 字段，界面据此区分「未开启 / 没有启用的知识库 / 知识库暂无文档 / 扫描 N 篇无命中 / 命中 N 篇」。
- ⚠️ **中文检索必须切二元组**：`retrieval_terms()` 里 ASCII 原样、中文 2-gram。原来用 `[\w\u4e00-\u9fff]{2,}` 抓连续中文串 → 整句成了一个词 → 中文知识库永远检索不到（真 bug）。
- 高风险任务不受 agent 收敛影响：审批门禁/执行/回查照旧追加。

## Skill 中心 / MCP 中心（2026-09-20 改成真功能）
- **Skill 中心**：`POST /api/skills` 收 multipart（新依赖 `python-multipart`），`apps/api/skills.py` 解析 .md(frontmatter，不引 YAML)/.json/.txt/.zip(找 SKILL.md) → 落库，原始文件存 `data/skills/`（已 gitignore）；≤2MB、UTF-8、导入默认停用。
- **启用的技能真的进提示词**：`WorkspaceService.managed_context` 把启用技能正文（各截 2000 字）拼成 `[技能：名称]` 进 context，并把名字写进 `TaskView.applied_skills`（`ManagedContext.skills`）。WorkspaceService 构造器多了可选的 `skill_store`，没接也不报错。
- **MCP 中心**：`apps/api/mcp.py` 配置 CRUD + **真实 MCP 流式 HTTP 握手**（initialize → notifications/initialized → tools/list，兼容 JSON 与 SSE 响应体），服务端自报的 serverInfo 与工具清单（readOnlyHint→只读/写入）落库展示。测连接**不是 ping**。
- MCP 边界（界面也要写明）：stdio/sse 不探测（stdio 需拉起子进程，安全边界不允许）；探测到的工具**尚未接入运行时工具注册表**。令牌永不回显（只回 `has_auth`）。`APP_MCP_ALLOW_PRIVATE_ENDPOINTS` 默认 true（本机 MCP 多在 127.0.0.1），上云设 false 防 SSRF。
- 随之删除的旧假实现：mcp 页原来的 connect/ping 是随机数造状态；`ui/data.ts` 里的 `mcpSeeds`/`skillSeeds`/`McpServer`/`Skill`/`McpTool`/`skillCategories` 共 275 行死数据已删（附件资产的 seeds 仍在用，别动）。

## 认证（双令牌 + 注册）
- 文件：`apps/api/auth.py`（服务+路由+依赖）、`auth_store.py`（users/refresh_tokens/app_secrets）、`security.py`（PBKDF2 24 万轮 + HS256，算法白名单硬编码）
- **访问令牌 30 min 无状态；刷新令牌 1 天（记住我 14 天）可吊销、每次刷新轮换**。`refresh_tokens` 只存哈希；`ttl_seconds` 让续期沿用原租约
- **泄露检测的关键区分**：`replaced_by` 有值的旧令牌重放 = 泄露 → 吊销该账号全部会话；主动登出/注销设备留下的令牌重放 = 正常 → 只回 401 **不连坐**（缺了它会"登出一台设备踢掉所有人"，测试逼出来的）
- 传输：响应体双令牌（脚本/原生客户端）+ httpOnly cookie（浏览器）。浏览器 JS 不碰令牌；EventSource/导出链接靠 cookie 自动携带
- 前端：`app/auth/provider.tsx`（到期前 90s 静默续期 + 回前台补续期）、`app/auth/api.ts`（`apiFetch`：401 → 续期 → 重放，并发去重；`toErrorMessage` 统一压平 422）、`apps/web/middleware.ts`（无有效刷新 cookie → 307 `/login?next=`）
- 所有前端请求走 `apiFetch`；登出必须 `clearCache()`（`resource-cache.ts`），否则上个账号的数据闪给下一个人
- **凡是把后端 `detail` 渲染出来的地方必须过 `toErrorMessage`**：业务错误是字符串，422 是对象数组 → 直接渲染会整页崩（踩过）
- 注册：`POST /api/auth/register` 只给 `member`、成功即登录；`APP_ALLOW_REGISTRATION`（默认开，上云建议关）+ 进程内按 IP 节流。**节流抛的 AuthError 必须落在 route 的 try 里**，否则 500
- 登录失败 5 次锁 60s；用户名不存在也做等价哈希防时序枚举；`APP_JWT_SECRET` <32 字符拒绝启动（未设置时生成随机密钥落库）
- 首次启动播种 `admin`（密码 `APP_ADMIN_PASSWORD`，默认 admin123）标 `must_change_password=1`；改密码吊销全部会话
- `users.role` 已入库但**尚未用于页面级授权**，别在界面宣称已生效
- 上云清单：`APP_JWT_SECRET`（≥32 字符、多实例一致）、`APP_COOKIE_SECURE=true`、跨站加 `APP_COOKIE_SAMESITE=none`、显式 `APP_ADMIN_PASSWORD`、改 `APP_CORS_ORIGINS`。详见 `.env.example` 与 `docs/architecture.md`
- **登录页是满屏双栏「深色控制台」风格**（`.login-shell`）：左深林绿渐变面板（品牌条 → 大留白 → 黄绿等宽 kicker → 大标题「让 Agent 自己组队，每一步都有据可查。」→ **运行链路面板** 受理/编排/执行/审批/交付 五节点 → 底部三栏要点），右纯白只放登录/注册；≤1080px 单栏、链路转纵向、隐藏连接件。
- 登录页配色变量（`--login-accent:#2f6b4f` / `--login-accent-dark:#275b43` / `--login-lime:#d8f36a` / `--login-line:rgba(255,255,255,.1)` / `--login-mono`）全部取自工作台自身（深侧边栏 #1d4a35、激活态 #263a31、强调黄绿 #d8f36a、主按钮绿 #2f6b4f）。**必须能一句话说清某个颜色来自项目哪里**，别引入孤立色值。改文案/配色保持"运行时真实发生的事"口径（链路上标「固定链路」，不摆 connected/standby 这类假状态灯，也不放不能点的假按钮）

## 常用命令
```powershell
uv sync --dev && pnpm install
uv run uvicorn apps.api.main:app --reload --reload-dir apps --reload-dir packages   # :8000
pnpm dev:web        # :3000；p 不可用时 node apps/web/node_modules/next/dist/bin/next dev -p 3000
uv run pytest ; uv run ruff check . ; pnpm typecheck:web ; pnpm lint:web ; pnpm build:web
```
访问：`/` 307 → `/workbench/runtime`；登录 `/login`；API 文档 `:8000/docs`。

## 环境坑（每次都可能再踩）
- **safe-delete 守卫**：`next dev/build` 启动清理旧构建产物 >50 文件就崩退；`rm` 被拦（用户确认也没用）。**解法：先 `mv .next-build .tmp/next_stale_<日期>/` 再启动**（rename 不触发逐文件删除）。旧构建在 `.tmp` 堆积，提醒用户手动清理。`next.config.ts` 已设 `distDir=".next-build"`
- **uvicorn `--reload` 偶发漏检改动** → 验证行为前整体重启后端，别信"应该已重载"
- **JS 的 `%` 允许负结果**（Python 不会）：base64url 补位必须 `(4 - (len % 4)) % 4`，写成 `-len % 4` 抛 RangeError 且被 try/catch 吞掉 → 症状是"接口通、页面全 307 回登录页"（真踩过，登录页当时进不去的根因）
- Windows 控制台 curl 传中文 body 会 GBK 乱码 → 400 "error parsing the body"，是测试姿势问题；用 python/pytest 验
- 删掉路由后 `tsc` 报过期 `.next/types` 错 → 重新 build 即恢复
- 后台起的服务跨会话会死，开工先探测 :3000/:8000

## 前端约定
- 样式层叠：`globals.css` → `tools.css` → `workbench.css` → `sidebar.css` → **`workspace-layout.css`（最终权威）**；同一属性只在一个文件声明（后加载的无条件规则会压掉先加载的 `@media`）
- 侧边栏数据驱动（`workbench-sidebar.tsx` 的 `navGroups`，加页面=加一行）；四组：运行工作台/能力构建/治理与观测/工作区设置；底部 `.control-user` 账号区 + 退出
- 示例数据页必须渲染 `<SampleBanner>` 且文案精确到"哪部分是示例"；种子时间戳用固定 ISO 字符串（防 SSR/CSR 不一致）；每个 mutation 都要 `useNotice().push()` 反馈
- 图标按需从 `@phosphor-icons/react/dist/csr/<Name>` 引；SVG 图表配色必须内联 fill/stroke
- **动画不引第三方库**：示意图动画 = CSS keyframes + SVG 原生 `animateMotion`。整套动作**共用一个周期**（如 4.6s），靠元素上的 `animationDelay` 错开出场，`infinite` 循环才不会各自漂移；连线用 `stroke-dasharray + dashoffset` 画出；SVG 元素做 transform 要加 `transform-box: fill-box`。**每个动画都必须带 `prefers-reduced-motion: reduce` 分支退回静态**，SMIL 关不掉时用 `matchMedia` 决定是否渲染（初始值保持 SSR/首帧一致）
