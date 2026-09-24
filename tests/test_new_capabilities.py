"""新增能力的验证：真写、MCP 参数构造、ReAct、向量检索、cron。

这些测试盯的是"真的发生了"，而不是"字段存在"：
文件要真的落盘、回滚要真的恢复旧内容、ReAct 要真的调了工具、
向量检索要真的把不相关的挡在外面。
"""

from datetime import datetime
from pathlib import Path

import pytest

from apps.api.schedules import ScheduleError, next_run_after, parse_field
from apps.api.task_service import TaskService
from apps.api.task_store import TaskStore
from packages.contracts.models import ApprovalDecision, StartTaskRequest
from packages.general_agent.capabilities import CapabilityRegistry
from packages.general_agent.execution import WriteExecutor, WriteRequest
from packages.general_agent.mcp_client import build_arguments
from packages.general_agent.react import ReactAgent
from packages.general_agent.retrieval import HashingEmbedding, VectorIndex
from packages.general_agent.tools import ToolRegistry


def test_file_write_really_writes_and_can_roll_back(tmp_path: Path) -> None:
    executor = WriteExecutor(project_root=tmp_path)

    first = executor.execute(WriteRequest(kind="file", path="notes/a.txt", content="first"))
    assert first.ok, first.error
    assert (tmp_path / "notes" / "a.txt").read_text(encoding="utf-8") == "first"

    second = executor.execute(WriteRequest(kind="file", path="notes/a.txt", content="second"))
    assert second.ok
    assert (tmp_path / "notes" / "a.txt").read_text(encoding="utf-8") == "second"

    executor.restore(str(second.detail["snapshot_id"]))
    assert (tmp_path / "notes" / "a.txt").read_text(encoding="utf-8") == "first"


def test_file_write_blocks_escape_and_sensitive_targets(tmp_path: Path) -> None:
    executor = WriteExecutor(project_root=tmp_path)
    assert not executor.execute(
        WriteRequest(kind="file", path="../outside.txt", content="x")
    ).ok
    assert not executor.execute(WriteRequest(kind="file", path=".env", content="x")).ok


def test_http_write_enforces_host_and_method_rules() -> None:
    executor = WriteExecutor(project_root=Path("."), allowed_hosts=("example.com",))
    assert not executor.execute(
        WriteRequest(kind="http", url="http://127.0.0.1/private")
    ).ok
    assert not executor.execute(WriteRequest(kind="http", url="http://other.com/x")).ok
    assert not executor.execute(
        WriteRequest(kind="http", url="http://example.com/x", method="GET")
    ).ok


def test_database_write_is_idempotent(tmp_path: Path) -> None:
    executor = WriteExecutor(project_root=tmp_path, database_path=tmp_path / "w.db")
    first = executor.execute(
        WriteRequest(kind="database", row={"a": 1}, idempotency_key="k1")
    )
    second = executor.execute(
        WriteRequest(kind="database", row={"a": 1}, idempotency_key="k1")
    )
    assert first.ok and second.ok
    assert second.detail["replayed"] is True


def test_dry_run_writes_nothing(tmp_path: Path) -> None:
    executor = WriteExecutor(project_root=tmp_path)
    receipt = executor.execute(
        WriteRequest(kind="file", path="x.txt", content="y"), dry_run=True
    )
    assert receipt.mode == "simulate"
    assert not (tmp_path / "x.txt").exists()


@pytest.mark.asyncio
async def test_execution_target_forces_approval_then_writes_for_real(
    tmp_path: Path,
) -> None:
    executor = WriteExecutor(project_root=tmp_path, database_path=tmp_path / "w.db")
    service = TaskService(
        store=TaskStore(tmp_path / "tasks.db"),
        registry=CapabilityRegistry.default(),
        tools=ToolRegistry(tmp_path, executor),
    )
    task = await service.create_task(
        StartTaskRequest(
            objective="整理客户清单",
            execution_target={
                "kind": "file",
                "path": "out/list.txt",
                "content": "hello",
            },
        )
    )
    # 只要带写入目标，无论风险等级如何都必须经过审批门禁
    assert task.status == "awaiting_approval"
    assert any(step.agent == "approval_gate" for step in task.plan)

    approved = await service.decide(
        task.task_id, ApprovalDecision(decision="approve", approver_id="tester")
    )
    assert (tmp_path / "out" / "list.txt").read_text(encoding="utf-8") == "hello"
    assert approved.artifacts["execution_agent"]["mode"] == "execute"
    assert approved.artifacts["verification_agent"]["verified"] is True


@pytest.mark.asyncio
async def test_without_target_the_execution_writes_nothing(tmp_path: Path) -> None:
    service = TaskService(
        store=TaskStore(tmp_path / "tasks.db"),
        registry=CapabilityRegistry.default(),
        tools=ToolRegistry(tmp_path, WriteExecutor(project_root=tmp_path)),
    )
    task = await service.create_task(StartTaskRequest(objective="整理客户清单"))
    assert task.status != "awaiting_approval"
    assert not (tmp_path / "out").exists()


@pytest.mark.asyncio
async def test_react_loop_calls_tools_and_records_the_trace(tmp_path: Path) -> None:
    agent = ReactAgent(ToolRegistry(tmp_path))
    result = await agent.run(
        {
            "task_id": "t1",
            "objective": "分析这份 CSV 的销售数据",
            "context": "month,sales\n1,10\n2,20",
            "max_steps": 3,
        }
    )
    assert result["phase"] == "reacting"
    steps = result["artifacts"]["react_agent"]["steps"]
    assert [step["tool"] for step in steps].count("analyze_csv") == 1
    assert result["tool_trace"], "ReAct 必须留下工具调用审计"


@pytest.mark.asyncio
async def test_react_refuses_to_call_write_tools(tmp_path: Path) -> None:
    agent = ReactAgent(ToolRegistry(tmp_path, WriteExecutor(project_root=tmp_path)))
    result = await agent.run(
        {"task_id": "t2", "objective": "写入文件", "context": "", "max_steps": 3}
    )
    names = {step.get("tool") for step in result["artifacts"]["react_agent"]["steps"]}
    assert "execute_external_write" not in names


def test_vector_retrieval_ranks_related_above_unrelated() -> None:
    index = VectorIndex(HashingEmbedding())
    docs = [("通用知识库", "规范.md", "数据库选型必须先给出读写比与一致性要求。")]
    related = index.search("比较三个数据库方案的读写比", docs)
    unrelated = index.search("把这张产品图压缩到 200KB 以内", docs)

    assert related and related[0].name == "规范.md"
    assert related[0].score > 0
    assert unrelated == [], "完全不相关的目标不该被算成命中"


def test_mcp_arguments_are_built_from_schema_or_skipped() -> None:
    schema = {
        "type": "object",
        "properties": {"query": {"type": "string"}, "limit": {"type": "integer"}},
        "required": ["query"],
    }
    arguments, reason = build_arguments(schema, "查一下 3 月的销售额")
    # 数字型参数会从目标里提取数值，字符串型直接用目标文本
    assert arguments["query"] == "查一下 3 月的销售额"
    assert arguments["limit"] == 3
    assert reason == ""

    missing, reason = build_arguments(
        {
            "type": "object",
            "properties": {"id": {"type": "integer"}},
            "required": ["id"],
        },
        "没有数字的查询",
    )
    assert missing is None and reason


def test_cron_next_run_and_validation() -> None:
    now = datetime(2026, 1, 1, 10, 0)
    assert next_run_after("*/15 * * * *", now) == datetime(2026, 1, 1, 10, 15)
    assert next_run_after("0 12 * * *", now) == datetime(2026, 1, 1, 12, 0)
    assert next_run_after("0 12 * * *", datetime(2026, 1, 1, 13, 0)) == datetime(
        2026, 1, 2, 12, 0
    )
    assert parse_field("*/10", 0, 59) == {0, 10, 20, 30, 40, 50}
    with pytest.raises(ScheduleError):
        next_run_after("不是 cron", now)
