"""任务完成时的回复必须说出"做完了什么"，而不是只报"已完成"。

这组测试针对的是一个真实体验问题：以前无论输入什么，收尾回复都是写死的一句
「任务计划已完成并通过质量门禁」，等于没有回答。
"""

from pathlib import Path

import pytest

from apps.api.task_service import TaskService
from apps.api.task_store import TaskStore
from packages.contracts.models import ApprovalDecision, StartTaskRequest
from packages.general_agent.capabilities import CapabilityRegistry
from packages.general_agent.execution import WriteExecutor
from packages.general_agent.tools import ToolRegistry


def build_service(tmp_path: Path) -> TaskService:
    return TaskService(
        store=TaskStore(tmp_path / "tasks.db"),
        registry=CapabilityRegistry.default(),
        tools=ToolRegistry(
            tmp_path,
            WriteExecutor(project_root=tmp_path, database_path=tmp_path / "writes.db"),
        ),
    )


@pytest.mark.asyncio
async def test_completed_task_summarizes_each_step(tmp_path: Path) -> None:
    service = build_service(tmp_path)
    task = await service.create_task(
        StartTaskRequest(
            objective="分析这份 CSV 的销售数据",
            context="month,sales\n1,10\n2,20",
        )
    )
    text = task.final_response or ""

    assert "任务计划已完成并通过质量门禁" not in text, "不该再退回那句模板收尾语"
    assert text.startswith("任务已完成")
    # 每一步的产出都要露面，并且带上该步自己的结论，而不是一句笼统的"已完成"
    assert "数据分析方案" in text
    assert "已解析上下文中的 CSV 数据并计算统计摘要" in text
    assert "质量门禁通过" in text


@pytest.mark.asyncio
async def test_write_task_reports_execution_and_verification(tmp_path: Path) -> None:
    service = build_service(tmp_path)
    task = await service.create_task(
        StartTaskRequest(
            objective="整理客户清单",
            execution_target={"kind": "file", "path": "out/a.txt", "content": "hi"},
        )
    )
    assert task.status == "awaiting_approval"

    done = await service.decide(
        task.task_id, ApprovalDecision(decision="approve", approver_id="tester")
    )
    text = done.final_response or ""

    assert "已按写入目标真实执行" in text
    assert "核验通过" in text


@pytest.mark.asyncio
async def test_dry_run_is_reported_as_simulation(tmp_path: Path) -> None:
    service = build_service(tmp_path)
    task = await service.create_task(
        StartTaskRequest(
            objective="整理客户清单",
            execution_target={"kind": "file", "path": "out/b.txt", "content": "hi"},
            dry_run=True,
        )
    )
    text = task.final_response or ""

    assert "演练模式" in text
    # 演练必须真的走一遍执行与核验，否则"演练"什么都没演练
    assert any(step.agent == "execution_agent" for step in task.plan)
    assert any(step.agent == "verification_agent" for step in task.plan)
    # 不落副作用，所以不该停下来等审批
    assert not any(step.agent == "approval_gate" for step in task.plan)
    # 演练必须真的走一遍执行与核验，否则"演练"什么都没演练
    assert any(step.agent == "execution_agent" for step in task.plan)
    assert any(step.agent == "verification_agent" for step in task.plan)
    # 不落副作用，所以不该停下来等审批
    assert not any(step.agent == "approval_gate" for step in task.plan)
    assert "已按写入目标真实执行" not in text
    assert not (tmp_path / "out" / "b.txt").exists()
    # 演练必须真的走一遍执行与核验，否则"演练"什么都没演练
    assert any(step.agent == "execution_agent" for step in task.plan)
    assert any(step.agent == "verification_agent" for step in task.plan)
    # 演练不落副作用，所以不该停下来等审批
    assert not any(step.agent == "approval_gate" for step in task.plan)


@pytest.mark.asyncio
async def test_react_output_is_included(tmp_path: Path) -> None:
    """ReAct 的产物不在计划步骤里，但它跑过就得出现，否则用户会以为什么都没发生。"""
    service = build_service(tmp_path)
    task = await service.create_task(
        StartTaskRequest(
            objective="分析这份 CSV 的销售数据",
            context="month,sales\n1,10\n2,20",
            run_mode="react",
        )
    )
    text = task.final_response or ""

    # ReAct 只有一步，所以直接给出该步的结论，不套"· 标题："的壳（也不该是"已完成"这
    # 种状态播报）——它必须说出这一轮实际做了什么、边界在哪。
    assert "只读工具" in text
    assert not text.startswith("·")
    assert "任务计划已完成" not in text
