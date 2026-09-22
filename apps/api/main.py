import json
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse

from apps.api.auth import Account, auth_router, current_user, ensure_seed_admin
from apps.api.mcp import mcp_router
from apps.api.settings import settings
from apps.api.skills import SkillStore, get_skill_store, skill_router
from apps.api.task_service import InvalidTaskStateError, TaskNotFoundError, TaskService
from apps.api.task_store import TaskStore
from apps.api.workspace import WorkspaceService, default_workspace
from packages.contracts.models import (
    ApprovalDecision,
    StartTaskRequest,
    TaskView,
    WorkspaceConfig,
)
from packages.general_agent.capabilities import CapabilityRegistry
from packages.general_agent.reasoning import (
    FallbackReasoner,
    LocalStructuredReasoner,
    OpenAIResponsesReasoner,
)
from packages.general_agent.tools import ToolRegistry


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
# 技能存库 + 原始文件落 data/skills/；启用的技能会通过 managed_context 进提示词。
skill_store: SkillStore = get_skill_store()
workspace = WorkspaceService(
    store,
    default_workspace(
        registry, ToolRegistry(Path(__file__).resolve().parents[2])
    ),
    registry,
    skill_store,
)
workspace.get()
service = TaskService(
    reasoner,
    store,
    registry,
    workspace.managed_context,
    workspace.runtime_policies,
)
app = FastAPI(
    title="Nexus General Agent API",
    version="0.1.0",
    description="Supervisor-driven general multi-agent workbench",
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
app.include_router(auth_router)
app.include_router(skill_router)
app.include_router(mcp_router)


@app.get("/health")
async def health() -> dict[str, str]:
    """保持公开：负载均衡与容器探针不该需要登录。"""
    return {"status": "ok"}


@app.get("/api/system")
async def system_info(_: Account = Depends(current_user)) -> dict[str, object]:
    root = Path(__file__).resolve().parents[2]
    return {
        "reasoning_provider": reasoner.name,
        "persistence": "sqlite",
        "capabilities": registry.definitions(),
        "tools": ToolRegistry(root).definitions(),
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


@app.post("/api/tasks", response_model=TaskView, status_code=201)
async def create_task(
    request: StartTaskRequest, _: Account = Depends(current_user)
) -> TaskView:
    return await service.create_task(request)


@app.get("/api/tasks", response_model=list[TaskView])
async def list_tasks(_: Account = Depends(current_user)) -> list[TaskView]:
    return service.list_tasks()


@app.get("/api/tasks/{task_id}", response_model=TaskView)
async def get_task(task_id: str, _: Account = Depends(current_user)) -> TaskView:
    try:
        return service.get_task(task_id)
    except TaskNotFoundError as exc:
        raise HTTPException(status_code=404, detail="task not found") from exc


@app.get("/api/tasks/{task_id}/export")
async def export_task(task_id: str, _: Account = Depends(current_user)) -> Response:
    try:
        task = service.get_task(task_id)
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
    task_id: str, decision: ApprovalDecision, _: Account = Depends(current_user)
) -> TaskView:
    try:
        return await service.decide(task_id, decision)
    except TaskNotFoundError as exc:
        raise HTTPException(status_code=404, detail="task not found") from exc
    except InvalidTaskStateError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/tasks/{task_id}/events")
async def task_events(
    task_id: str, request: Request, _: Account = Depends(current_user)
) -> EventSourceResponse:
    try:
        service.get_task(task_id)
    except TaskNotFoundError as exc:
        raise HTTPException(status_code=404, detail="task not found") from exc

    try:
        after = int(request.headers.get("last-event-id", "0"))
    except ValueError:
        after = 0

    async def stream():
        async for item in service.events(task_id, after):
            if await request.is_disconnected():
                break
            yield {
                "id": str(item["id"]),
                "event": str(item["event"]),
                "data": json.dumps(item["data"], ensure_ascii=False),
            }

    return EventSourceResponse(stream())
