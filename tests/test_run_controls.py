"""运行控制项：运行 Agent 收敛、知识库检索开关与回报、对话分组。

这三项都是"界面上有个开关，就必须真的改变运行时行为"的功能，
所以每个断言都落在计划内容 / 注入上下文 / 持久化字段上，而不是界面文案。
"""

from pathlib import Path

import pytest

from apps.api.task_service import TaskService
from apps.api.task_store import TaskStore
from apps.api.workspace import WorkspaceService, default_workspace
from packages.contracts.models import StartTaskRequest, WorkspaceConfig
from packages.general_agent.capabilities import CapabilityRegistry
from packages.general_agent.tools import ToolRegistry


def build(tmp_path: Path) -> tuple[TaskService, WorkspaceService]:
    store = TaskStore(tmp_path / "run-controls.db")
    registry = CapabilityRegistry.default()
    workspace = WorkspaceService(
        store, default_workspace(registry, ToolRegistry(tmp_path)), registry
    )
    service = TaskService(
        store=store,
        registry=registry,
        context_provider=workspace.managed_context,
        policy_provider=workspace.runtime_policies,
    )
    return service, workspace


def agents_of(task) -> list[str]:
    return [str(step.agent) for step in task.plan]


# ------------------------------------------------------------ 运行 Agent 收敛


@pytest.mark.asyncio
async def test_auto_agent_still_composes_a_team(tmp_path: Path) -> None:
    service, _ = build(tmp_path)

    task = await service.create_task(
        StartTaskRequest(objective="比较三个数据库方案并生成研究报告", agent="auto")
    )

    assert agents_of(task) == ["research_agent", "document_agent", "review_agent"]


@pytest.mark.asyncio
async def test_pinned_agent_narrows_the_plan(tmp_path: Path) -> None:
    service, _ = build(tmp_path)

    task = await service.create_task(
        StartTaskRequest(objective="比较三个数据库方案并生成研究报告", agent="research_agent")
    )

    assert agents_of(task) == ["research_agent"]
    assert task.requested_agent == "research_agent"
    assert "按指定 Agent（research_agent）收敛" in task.agent_trace[1].summary


@pytest.mark.asyncio
async def test_pinned_agent_overrides_the_task_type_filter(tmp_path: Path) -> None:
    """指定代码 Agent 去跑研究类任务也要生效，否则"指定"会静默失效。"""
    service, _ = build(tmp_path)

    task = await service.create_task(
        StartTaskRequest(objective="比较三个数据库方案并生成研究报告", agent="code_agent")
    )

    assert agents_of(task) == ["code_agent"]


@pytest.mark.asyncio
async def test_pinned_agent_that_is_disabled_falls_back_and_says_so(tmp_path: Path) -> None:
    service, workspace = build(tmp_path)
    payload = workspace.get().model_dump()
    for agent in payload["agents"]:
        if agent["id"] == "code_agent":
            agent["enabled"] = False
    workspace.save(WorkspaceConfig.model_validate(payload))

    task = await service.create_task(
        StartTaskRequest(objective="修复 API 的登录 bug", agent="code_agent")
    )

    assert "code_agent" not in agents_of(task)
    assert "未启用，回退为自动组队" in task.agent_trace[1].summary


@pytest.mark.asyncio
async def test_high_risk_still_appends_the_approval_chain_when_pinned(tmp_path: Path) -> None:
    """收敛不绕过风控：高风险任务的审批门禁不能因为"指定了 Agent"就消失。"""
    service, _ = build(tmp_path)

    task = await service.create_task(
        StartTaskRequest(objective="生成报告并发送给客户", agent="document_agent")
    )

    assert task.status == "awaiting_approval"
    assert "approval_gate" in agents_of(task)


# ------------------------------------------------------------ 知识库检索开关


def seed_document(workspace: WorkspaceService, content: str, name: str = "规范.md") -> None:
    payload = workspace.get().model_dump()
    payload["knowledge_bases"][0]["documents"] = [{"name": name, "content": content}]
    workspace.save(WorkspaceConfig.model_validate(payload))


@pytest.mark.asyncio
async def test_knowledge_base_hit_is_injected_and_reported(tmp_path: Path) -> None:
    service, workspace = build(tmp_path)
    seed_document(workspace, "数据库选型必须先给出读写比与一致性要求。")

    task = await service.create_task(
        StartTaskRequest(objective="比较三个数据库方案的读写比", use_knowledge_base=True)
    )

    assert "数据库选型必须先给出读写比与一致性要求" in task.context
    assert task.knowledge["enabled"] is True
    assert task.knowledge["bases"] == ["通用知识库"]
    assert task.knowledge["available"] == 1
    assert task.knowledge["documents"] == [{"base": "通用知识库", "name": "规范.md"}]


@pytest.mark.asyncio
async def test_knowledge_base_can_be_switched_off(tmp_path: Path) -> None:
    service, workspace = build(tmp_path)
    seed_document(workspace, "数据库选型必须先给出读写比与一致性要求。")

    task = await service.create_task(
        StartTaskRequest(objective="比较三个数据库方案的读写比", use_knowledge_base=False)
    )

    assert "数据库选型必须先给出读写比" not in task.context
    assert task.knowledge["enabled"] is False
    assert task.knowledge["documents"] == []
    # 关掉检索不影响工作区上下文注入
    assert "优先使用可核验信息" in task.context


@pytest.mark.asyncio
async def test_empty_knowledge_base_reports_zero_available(tmp_path: Path) -> None:
    """默认工作台的知识库是空的，界面要能区分"没开启"和"没有文档"。"""
    service, _ = build(tmp_path)

    task = await service.create_task(
        StartTaskRequest(objective="比较三个数据库方案", use_knowledge_base=True)
    )

    assert task.knowledge["enabled"] is True
    assert task.knowledge["available"] == 0
    assert task.knowledge["documents"] == []


@pytest.mark.asyncio
async def test_unrelated_objective_does_not_pull_in_the_document(tmp_path: Path) -> None:
    """关键词完全不重叠时不能硬塞文档——不然"命中明细"就没有意义了。"""
    service, workspace = build(tmp_path)
    seed_document(workspace, "数据库选型必须先给出读写比与一致性要求。")

    task = await service.create_task(
        StartTaskRequest(objective="把这张产品图压缩到 200KB 以内", use_knowledge_base=True)
    )

    assert "数据库选型" not in task.context
    assert task.knowledge["documents"] == []
    assert task.knowledge["available"] == 1


def test_retrieval_terms_split_chinese_into_bigrams() -> None:
    """中文整句不能当一个词，否则知识库永远检索不到（这是修过的真 bug）。"""
    from apps.api.workspace import retrieval_terms

    terms = retrieval_terms("比较数据库方案")

    assert "比较" in terms
    assert "数据" in terms
    assert "方案" in terms
    assert "比较数据库方案" not in terms
    # ASCII 词保持原样并转小写
    assert "csv" in retrieval_terms("分析 CSV 数据")


# ---------------------------------------------------------------- 对话分组


@pytest.mark.asyncio
async def test_conversation_id_is_persisted_for_grouping(tmp_path: Path) -> None:
    service, _ = build(tmp_path)

    first = await service.create_task(
        StartTaskRequest(objective="比较三个数据库方案", conversation_id="conv-1")
    )
    second = await service.create_task(
        StartTaskRequest(objective="再说说运维成本", conversation_id="conv-1")
    )
    loose = await service.create_task(StartTaskRequest(objective="顺手看看日志"))

    assert first.conversation_id == "conv-1"
    assert second.conversation_id == "conv-1"
    assert loose.conversation_id is None
    grouped = [task for task in service.list_tasks() if task.conversation_id == "conv-1"]
    assert len(grouped) == 2


@pytest.mark.asyncio
async def test_conversation_id_survives_a_restart(tmp_path: Path) -> None:
    store_path = tmp_path / "restart.db"
    store = TaskStore(store_path)
    registry = CapabilityRegistry.default()
    workspace = WorkspaceService(
        store, default_workspace(registry, ToolRegistry(tmp_path)), registry
    )
    service = TaskService(
        store=store, registry=registry, context_provider=workspace.managed_context
    )
    task = await service.create_task(
        StartTaskRequest(objective="比较三个数据库方案", conversation_id="conv-9")
    )

    restarted = TaskService(store=TaskStore(store_path))
    reloaded = restarted.get_task(task.task_id)

    assert reloaded.conversation_id == "conv-9"
    assert reloaded.knowledge["enabled"] is True
