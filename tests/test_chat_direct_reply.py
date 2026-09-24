"""闲聊与简单问题直接回答，不进组队流水线。

起因：输入"你好啊"也会被组队跑一遍（研究 → 文档 → 审查），最后收到一句状态播报。
现在识别为 chat 后只走"直接回答"一步。
"""

from pathlib import Path

import pytest

from apps.api.task_service import TaskService
from apps.api.task_store import TaskStore
from packages.contracts.models import StartTaskRequest
from packages.general_agent.agents import TaskIntakeAgent
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


@pytest.mark.parametrize(
    "text",
    ["你好啊", "您好", "hi", "hello", "谢谢", "你是谁", "你能做什么", "再见"],
)
def test_greetings_are_chat(text: str) -> None:
    assert TaskIntakeAgent._is_chat(text) is True


@pytest.mark.parametrize(
    "text",
    [
        "你好，帮我分析这份 CSV 的销售数据",
        "分析这份 CSV 的销售数据",
        "比较 LangGraph 和 CrewAI 的技术选型",
        "写给客户的交付说明文档",
        "查一下部署流程",
        "总结这次迭代的经验",
    ],
)
def test_real_tasks_are_not_chat(text: str) -> None:
    assert TaskIntakeAgent._is_chat(text) is False


@pytest.mark.asyncio
async def test_chat_plans_a_single_step(tmp_path: Path) -> None:
    service = build_service(tmp_path)
    task = await service.create_task(StartTaskRequest(objective="你好啊"))

    assert task.status == "completed"
    assert task.task_type == "chat"
    assert [step.agent for step in task.plan] == ["direct_agent"]


@pytest.mark.asyncio
async def test_chat_reply_is_the_answer_not_a_status_report(tmp_path: Path) -> None:
    service = build_service(tmp_path)
    task = await service.create_task(StartTaskRequest(objective="你好啊"))
    reply = task.final_response or ""

    # 只有一项产出时直接说话，不套"· 直接回答："的壳，也不是"计划已完成"那种状态播报
    assert "任务计划已完成" not in reply
    assert not reply.startswith("·")
    assert "直接说目标" in reply


@pytest.mark.asyncio
async def test_capability_question_gets_capability_answer(tmp_path: Path) -> None:
    service = build_service(tmp_path)
    task = await service.create_task(StartTaskRequest(objective="你能做什么"))

    assert len(task.plan) == 1
    assert "能力注册表" in (task.final_response or "")


@pytest.mark.asyncio
async def test_chat_skips_review_and_execution_chain(tmp_path: Path) -> None:
    service = build_service(tmp_path)
    task = await service.create_task(StartTaskRequest(objective="嗨，在吗"))
    agents = [step.agent for step in task.plan]

    assert agents == ["direct_agent"], "闲聊不该再拉上审查/执行/审批"


# ---------------------------------------------------------------- 分类兜底
# "不客气""thank you" 曾经漏在词表外，被识别成 general 任务：既组了队（研究 → 文档 → 审查），
# 又只能吐出"研究框架 / 质量门禁"这种空壳结论 —— 用户报的"答非所问"和"看不到交付产物"就是这么来的。


@pytest.mark.parametrize(
    "objective",
    ["不客气", "谢谢你呀", "thank you", "thanks", "好的！", "嗯嗯", "好嘞", "3q", "在吗", "再见"],
)
def test_courtesy_and_acknowledgement_are_chat(objective: str) -> None:
    assert TaskIntakeAgent._classify(objective) == "chat"


@pytest.mark.parametrize(
    "objective",
    [
        "帮我分析这份 CSV 的销售数据",
        "比较三种编排框架并形成选型报告",
        "把结果整理成文档",
        "发送邮件给客户",
        "写一个导出 CSV 的脚本",
    ],
)
def test_real_requests_are_never_swallowed_as_chat(objective: str) -> None:
    """兜底规则只管「很短且没有任务动词」，带活儿的输入不能被误吞。"""
    assert TaskIntakeAgent._classify(objective) != "chat"


@pytest.mark.asyncio
async def test_courtesy_reply_is_a_real_answer_not_a_pipeline_report(tmp_path: Path) -> None:
    """寒暄的回复必须是人话，不能是流水线状态播报。"""
    service = build_service(tmp_path)
    task = await service.create_task(StartTaskRequest(objective="不客气"))

    assert task.task_type == "chat"
    assert [step.agent for step in task.plan] == ["direct_agent"]
    answer = task.final_response or ""
    assert "质量门禁" not in answer
    assert "研究框架" not in answer
