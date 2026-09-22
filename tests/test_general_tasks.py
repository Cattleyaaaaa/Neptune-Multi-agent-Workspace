from pathlib import Path

import pytest

from apps.api.task_service import InvalidTaskStateError, TaskService
from apps.api.task_store import TaskStore
from apps.api.workspace import WorkspaceService, default_workspace
from packages.contracts.models import ApprovalDecision, StartTaskRequest, WorkspaceConfig
from packages.general_agent.capabilities import CapabilityRegistry
from packages.general_agent.reasoning import OpenAIResponsesReasoner
from packages.general_agent.tools import ToolPermissionError, ToolRegistry


@pytest.mark.asyncio
async def test_research_task_uses_specialists_and_completes() -> None:
    service = TaskService()

    task = await service.create_task(
        StartTaskRequest(objective="比较三个数据库方案并生成研究报告")
    )

    assert task.status == "completed"
    assert task.task_type == "research"
    assert task.risk_level == "low"
    assert [step.agent for step in task.plan] == [
        "research_agent",
        "document_agent",
        "review_agent",
    ]
    assert set(task.artifacts) == {"research_agent", "document_agent", "review_agent"}
    assert task.agent_trace[-1].agent == "supervisor_agent"
    assert task.agent_trace[-1].handoff == "end"


@pytest.mark.asyncio
async def test_high_risk_task_requires_approval_and_verification() -> None:
    service = TaskService()
    task = await service.create_task(StartTaskRequest(objective="生成报告并发送给客户"))

    assert task.status == "awaiting_approval"
    assert task.phase == "approval"
    assert task.plan[-3].agent == "approval_gate"

    completed = await service.decide(
        task.task_id,
        ApprovalDecision(decision="approve", approver_id="owner-1", note="允许模拟执行"),
    )

    assert completed.status == "completed"
    assert completed.artifacts["verification_agent"]["verified"] is True
    assert completed.approval["approval_id"] == f"APR-{task.task_id}"


@pytest.mark.asyncio
async def test_rejected_task_stops_before_execution() -> None:
    service = TaskService()
    task = await service.create_task(StartTaskRequest(objective="删除旧报告并发布新版"))

    rejected = await service.decide(
        task.task_id,
        ApprovalDecision(decision="reject", approver_id="owner-1", note="风险过高"),
    )

    assert rejected.status == "rejected"
    assert "execution_agent" not in rejected.artifacts
    with pytest.raises(InvalidTaskStateError):
        await service.decide(
            task.task_id,
            ApprovalDecision(decision="approve", approver_id="owner-1"),
        )


@pytest.mark.asyncio
async def test_plan_only_stops_after_planning() -> None:
    service = TaskService()

    task = await service.create_task(
        StartTaskRequest(objective="分析 CSV 数据", execution_mode="plan_only")
    )

    assert task.status == "planned"
    assert task.task_type == "data"
    assert task.artifacts == {}
    assert task.completed_agents == ["intake_agent", "planner_agent"]


@pytest.mark.asyncio
async def test_code_task_routes_to_code_agent() -> None:
    service = TaskService()

    task = await service.create_task(StartTaskRequest(objective="修复 API 的登录 bug"))

    assert task.status == "completed"
    assert task.task_type == "code"
    assert "code_agent" in task.artifacts
    assert task.artifacts["review_agent"]["passed"] is True
    inventory = task.artifacts["code_agent"]["workspace_inventory"]
    assert inventory["file_count"] > 0
    assert task.tool_trace[0].tool == "inspect_workspace"


@pytest.mark.asyncio
async def test_data_agent_calculates_real_csv_summary() -> None:
    service = TaskService()
    csv_context = "region,revenue\nNorth,100\nSouth,200\nWest,300"

    task = await service.create_task(
        StartTaskRequest(objective="分析 CSV 销售数据", context=csv_context)
    )

    analysis = task.artifacts["data_agent"]["analysis"]
    assert analysis["detected"] is True
    assert analysis["row_count"] == 3
    assert analysis["numeric_summary"]["revenue"]["mean"] == 200.0
    assert task.tool_trace[0].summary == "解析 3 行、2 列 CSV 数据"


def test_tool_registry_enforces_agent_permissions(tmp_path: Path) -> None:
    tools = ToolRegistry(tmp_path)

    with pytest.raises(ToolPermissionError):
        tools.invoke("inspect_workspace", "research_agent", {})


def test_web_tool_blocks_local_network(tmp_path: Path) -> None:
    tools = ToolRegistry(tmp_path)

    result, audit = tools.invoke(
        "fetch_public_url", "research_agent", {"url": "http://127.0.0.1/private"}
    )

    assert audit["status"] == "failed"
    assert result["error_type"] == "ValueError"


@pytest.mark.asyncio
async def test_pending_approval_resumes_after_service_restart(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.db")
    first_service = TaskService(store=store)
    pending = await first_service.create_task(
        StartTaskRequest(objective="生成报告并发送给客户")
    )

    restarted_service = TaskService(store=TaskStore(tmp_path / "tasks.db"))
    completed = await restarted_service.decide(
        pending.task_id,
        ApprovalDecision(decision="approve", approver_id="owner-1", note="重启恢复测试"),
    )

    assert completed.status == "completed"
    assert completed.artifacts["verification_agent"]["verified"] is True


@pytest.mark.asyncio
async def test_step_budget_stops_large_plan() -> None:
    service = TaskService()

    task = await service.create_task(
        StartTaskRequest(objective="生成研究报告并发送给客户", max_steps=3)
    )

    assert task.status == "needs_human"
    assert task.dispatch_count == 3
    assert task.final_response == "任务达到最大步骤数，已停止自动执行。"


def test_openai_response_text_extraction() -> None:
    body = {
        "output": [
            {
                "type": "message",
                "content": [{"type": "output_text", "text": '{"summary":"ok"}'}],
            }
        ]
    }

    assert OpenAIResponsesReasoner._extract_output_text(body) == '{"summary":"ok"}'


@pytest.mark.asyncio
async def test_workspace_configuration_affects_new_tasks(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "workspace.db")
    registry = CapabilityRegistry.default()
    workspace = WorkspaceService(
        store,
        default_workspace(registry, ToolRegistry(tmp_path)),
        registry,
    )
    payload = workspace.get().model_dump()
    for agent in payload["agents"]:
        if agent["id"] == "document_agent":
            agent["enabled"] = False
    payload["contexts"][0]["content"] = "所有结论必须给出置信度。"
    workspace.save(WorkspaceConfig.model_validate(payload))

    service = TaskService(
        store=store,
        registry=registry,
        context_provider=workspace.managed_context,
    )
    task = await service.create_task(StartTaskRequest(objective="比较数据库方案"))

    assert "document_agent" not in [step.agent for step in task.plan]
    assert "所有结论必须给出置信度" in task.context
    assert TaskStore(tmp_path / "workspace.db").load_workspace() is not None
