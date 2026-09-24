import json
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse

from apps.api.auth import (
    Account,
    auth_router,
    current_user,
    ensure_seed_admin,
    guest_write_guard,
)
from apps.api.browse import bind_root as bind_workspace_root
from apps.api.browse import router as fs_router
from apps.api.insights import router as insights_router
from apps.api.mcp import get_mcp_store, mcp_router
from apps.api.mcp_runtime import McpToolProvider
from apps.api.schedules import runner as schedule_runner
from apps.api.schedules import schedule_router
from apps.api.settings import settings
from apps.api.skills import SkillStore, get_skill_store, skill_router
from apps.api.task_service import (
    InvalidTaskStateError,
    TaskNotFoundError,
    TaskService,
    Viewer,
)
from apps.api.task_store import TaskStore
from apps.api.workspace import WorkspaceService, default_workspace
from packages.contracts.models import (
    ApprovalDecision,
    StartTaskRequest,
    TaskView,
    WorkspaceConfig,
)
from packages.general_agent.capabilities import CapabilityRegistry
from packages.general_agent.execution import WriteExecutor
from packages.general_agent.reasoning import (
    FallbackReasoner,
    LocalStructuredReasoner,
    OpenAIResponsesReasoner,
)
from packages.general_agent.retrieval import (
    ApiEmbedding,
    FallbackEmbedding,
    HashingEmbedding,
)
from packages.general_agent.tools import ToolRegistry


def build_embedder():
    """默认本地确定性向量；配了 embedding 服务就走真向量，失败回退本地。"""
    local = HashingEmbedding()
    if settings.embedding_provider != "api" or settings.embedding_api_key is None:
        return local
    return FallbackEmbedding(
        ApiEmbedding(
            settings.embedding_api_key.get_secret_value(),
            settings.embedding_model,
            settings.embedding_base_url,
        ),
        local,
    )


def build_reasoner():
    local = LocalStructuredReasoner()
    if settings.reasoning_provider != "openai" or settings.openai_api_key is None:
        return local
    remote = OpenAIResponsesReasoner(
        settings.openai_api_key.get_secret_value(), settings.openai_model
    )
    return FallbackReasoner(remote, local)


reasoner = build_reasoner()
store = TaskStore(Path(settings.database_path))
registry = CapabilityRegistry.default()
project_root = Path(__file__).resolve().parents[2]
# 真实写入的执行适配器：文件写有 jail、HTTP 写有主机白名单、数据库写落本库。
executor = WriteExecutor(
    project_root=(
        Path(settings.write_root).resolve() if settings.write_root else project_root
    ),
    database_path=Path(settings.database_path).resolve(),
    allowed_hosts=tuple(
        host.strip() for host in settings.write_allowed_hosts.split(",") if host.strip()
    ),
    allow_private_hosts=settings.write_allow_private_hosts,
    timeout_seconds=settings.write_timeout_seconds,
)
tools = ToolRegistry(project_root, executor)
# 目录浏览与写入必须共用同一棵树，所以把执行器的根注册给浏览接口。
bind_workspace_root(executor.project_root)
# MCP 工具接入运行时：启用的 http 服务器里探测到的工具会成为可调工具。
tools.set_external_provider(McpToolProvider(get_mcp_store()))
# 技能存库 + 原始文件落 data/skills/；启用的技能会通过 managed_context 进提示词。
skill_store: SkillStore = get_skill_store()
workspace = WorkspaceService(
    store,
    default_workspace(registry, tools),
    registry,
    skill_store,
    build_embedder(),
)
workspace.get()
service = TaskService(
    reasoner,
    store,
    registry,
    workspace.managed_context,
    workspace.runtime_policies,
    tools,
)
@asynccontextmanager
async def lifespan(_: FastAPI):
    # 调度器需要 TaskService 才能真正跑任务，装配完再启动后台循环。
    schedule_runner.bind(service)
    schedule_runner.start()
    yield
    schedule_runner.stop()


app = FastAPI(
    title="Neptune General Agent API",
    version="0.1.0",
    description="Supervisor-driven general multi-agent workbench",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)

# 首次启动没有任何账号时，谁都登不进来，所以先播种一个管理员。
ensure_seed_admin()
# 访客会话只读：写操作在进入路由前就被拒（默认拒绝，不会漏掉新增的写接口）。
@app.middleware("http")
async def _guest_write_guard(request, call_next):  # type: ignore[no-untyped-def]
    return await guest_write_guard(request, call_next)


app.include_router(auth_router)
app.include_router(skill_router)
app.include_router(mcp_router)
app.include_router(schedule_router)
app.include_router(insights_router)
app.include_router(fs_router)


@app.get("/health")
async def health() -> dict[str, str]:
    """保持公开：负载均衡与容器探针不该需要登录。"""
    return {"status": "ok"}


@app.get("/api/system")
async def system_info(_: Account = Depends(current_user)) -> dict[str, object]:
    return {
        "reasoning_provider": reasoner.name,
        "persistence": "sqlite",
        "capabilities": registry.definitions(),
        "tools": service.tool_definitions(),
        # 真实写入的边界要在界面上如实可见，而不是藏在配置里。
        "write_policy": {
            "kinds": ["http", "file", "database"],
            "file_root": str(executor.project_root),
            "allowed_hosts": list(executor.allowed_hosts),
            "allow_private_hosts": executor.allow_private_hosts,
        },
    }


@app.get("/api/workspace", response_model=WorkspaceConfig)
async def get_workspace(_: Account = Depends(current_user)) -> WorkspaceConfig:
    return workspace.get()


@app.put("/api/workspace", response_model=WorkspaceConfig)
async def save_workspace(
    config: WorkspaceConfig, _: Account = Depends(current_user)
) -> WorkspaceConfig:
    return workspace.save(config)


@app.post("/api/workspace/reset", response_model=WorkspaceConfig)
async def reset_workspace(_: Account = Depends(current_user)) -> WorkspaceConfig:
    return workspace.reset()


def viewer_of(account: Account) -> Viewer:
    """把登录账号翻成「谁在看」：管理员看全部任务，其他人只看自己创建的。"""
    return Viewer(user_id=account.user_id, is_admin=account.role == "admin")


@app.post("/api/tasks", response_model=TaskView, status_code=201)
async def create_task(
    request: StartTaskRequest, account: Account = Depends(current_user)
) -> TaskView:
    return await service.create_task(request, owner_id=account.user_id)


@app.get("/api/tasks", response_model=list[TaskView])
async def list_tasks(account: Account = Depends(current_user)) -> list[TaskView]:
    return service.list_tasks(viewer_of(account))


@app.get("/api/tasks/{task_id}", response_model=TaskView)
async def get_task(task_id: str, account: Account = Depends(current_user)) -> TaskView:
    try:
        return service.get_task(task_id, viewer_of(account))
    except TaskNotFoundError as exc:
        raise HTTPException(status_code=404, detail="task not found") from exc


@app.get("/api/tasks/{task_id}/export")
async def export_task(task_id: str, account: Account = Depends(current_user)) -> Response:
    try:
        task = service.get_task(task_id, viewer_of(account))
    except TaskNotFoundError as exc:
        raise HTTPException(status_code=404, detail="task not found") from exc
    payload = task.model_dump_json(indent=2)
    return Response(
        content=payload,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="task-{task_id}.json"'},
    )


@app.post("/api/tasks/{task_id}/approval", response_model=TaskView)
async def decide(
    task_id: str, decision: ApprovalDecision, account: Account = Depends(current_user)
) -> TaskView:
    try:
        return await service.decide(task_id, decision, viewer_of(account))
    except TaskNotFoundError as exc:
        raise HTTPException(status_code=404, detail="task not found") from exc
    except InvalidTaskStateError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/tasks/{task_id}/events")
async def task_events(
    task_id: str, request: Request, account: Account = Depends(current_user)
) -> EventSourceResponse:
    viewer = viewer_of(account)
    try:
        service.get_task(task_id, viewer)
    except TaskNotFoundError as exc:
        raise HTTPException(status_code=404, detail="task not found") from exc

    try:
        after = int(request.headers.get("last-event-id", "0"))
    except ValueError:
        after = 0

    async def stream():
        async for item in service.events(task_id, after, viewer):
            if await request.is_disconnected():
                break
            yield {
                "id": str(item["id"]),
                "event": str(item["event"]),
                "data": json.dumps(item["data"], ensure_ascii=False),
            }

    return EventSourceResponse(stream())
