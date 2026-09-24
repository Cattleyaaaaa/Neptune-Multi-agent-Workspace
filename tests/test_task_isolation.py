"""任务归属与可见性。

背景：任务以前没有归属人，任何登录账号（包括访客）都能看到全部任务。
现在按归属过滤：管理员看全部，其他人只看自己创建的；无归属的历史任务只有管理员可见。

隔离必须是**服务端**成立，所以这里既测服务层，也测路由层确实把账号传了下去
（漏传等于全开放，那是最危险的回归）。
"""

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from apps.api.auth import Account, current_user
from apps.api.task_service import TaskNotFoundError, TaskService, Viewer
from apps.api.task_store import TaskStore
from packages.contracts.models import ApprovalDecision, StartTaskRequest

OBJECTIVE = "比较三个数据库方案并生成研究报告"


def viewer(user_id: str, *, is_admin: bool = False) -> Viewer:
    return Viewer(user_id=user_id, is_admin=is_admin)


def account(user_id: str, *, role: str = "member") -> Account:
    return Account(
        user_id=user_id,
        username=user_id,
        display_name=user_id,
        role=role,
        must_change_password=False,
    )


def build_service(tmp_path: Path) -> TaskService:
    """带持久化的服务：这样才能验证归属真的落库（重启后依然隔离）。"""
    return TaskService(store=TaskStore(tmp_path / "tasks.db"))


@pytest.mark.asyncio
async def test_owner_sees_own_task_only(tmp_path: Path) -> None:
    service = build_service(tmp_path)
    task = await service.create_task(StartTaskRequest(objective=OBJECTIVE), owner_id="u-a")

    assert [item.task_id for item in service.list_tasks(viewer("u-a"))] == [task.task_id]
    assert service.get_task(task.task_id, viewer("u-a")).task_id == task.task_id

    # 别人既不在列表里，也拿不到详情 —— 一律按「不存在」处理，不泄露 id 是否存在
    assert service.list_tasks(viewer("u-b")) == []
    with pytest.raises(TaskNotFoundError):
        service.get_task(task.task_id, viewer("u-b"))


@pytest.mark.asyncio
async def test_other_user_cannot_approve(tmp_path: Path) -> None:
    """审批是写操作，越权必须失败。"""
    service = build_service(tmp_path)
    task = await service.create_task(StartTaskRequest(objective=OBJECTIVE), owner_id="u-a")

    with pytest.raises(TaskNotFoundError):
        await service.decide(
            task.task_id,
            ApprovalDecision(decision="approve", approver_id="u-b", note="越权试试"),
            viewer("u-b"),
        )


@pytest.mark.asyncio
async def test_admin_sees_everything(tmp_path: Path) -> None:
    service = build_service(tmp_path)
    first = await service.create_task(StartTaskRequest(objective=OBJECTIVE), owner_id="u-a")
    second = await service.create_task(
        StartTaskRequest(objective="把这次调研整理成交付文档"), owner_id="u-b"
    )

    visible = {item.task_id for item in service.list_tasks(viewer("root", is_admin=True))}

    assert visible == {first.task_id, second.task_id}
    assert service.get_task(second.task_id, viewer("root", is_admin=True)).task_id == second.task_id


@pytest.mark.asyncio
async def test_guest_sees_nothing(tmp_path: Path) -> None:
    """访客看不到任何人的任务 —— 这正是之前"访客能看到全部任务"的修复点。"""
    service = build_service(tmp_path)
    await service.create_task(StartTaskRequest(objective=OBJECTIVE), owner_id="u-a")

    assert service.list_tasks(viewer("guest-user")) == []


@pytest.mark.asyncio
async def test_legacy_task_without_owner_is_admin_only(tmp_path: Path) -> None:
    """改造前创建的任务没有归属：宁可少给，也不默认暴露给所有人。"""
    service = build_service(tmp_path)
    legacy = await service.create_task(StartTaskRequest(objective=OBJECTIVE), owner_id=None)

    assert service.list_tasks(viewer("u-a")) == []
    assert [item.task_id for item in service.list_tasks(viewer("root", is_admin=True))] == [
        legacy.task_id
    ]


@pytest.mark.asyncio
async def test_isolation_survives_restart(tmp_path: Path) -> None:
    """归属要落库：重新构造服务（模拟重启）后，隔离依然成立。"""
    service = build_service(tmp_path)
    task = await service.create_task(StartTaskRequest(objective=OBJECTIVE), owner_id="u-a")

    restarted = build_service(tmp_path)

    assert [item.task_id for item in restarted.list_tasks(viewer("u-a"))] == [task.task_id]
    assert restarted.list_tasks(viewer("u-b")) == []


def test_routes_pass_the_account_through(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """路由层必须把真实账号传下去 —— 漏传就等于全开放，这条守住这个回归。"""
    import apps.api.main as main_module

    service = build_service(tmp_path)
    monkeypatch.setattr(main_module, "service", service)
    created = asyncio.run(
        service.create_task(StartTaskRequest(objective=OBJECTIVE), owner_id="u-a")
    )

    app = main_module.app
    try:
        app.dependency_overrides[current_user] = lambda: account("u-b")
        client = TestClient(app)

        assert client.get("/api/tasks").json() == []
        assert client.get(f"/api/tasks/{created.task_id}").status_code == 404
        assert client.get(f"/api/tasks/{created.task_id}/export").status_code == 404
        assert client.get(f"/api/tasks/{created.task_id}/events").status_code == 404
        assert client.post(
            f"/api/tasks/{created.task_id}/approval",
            json={"decision": "approve", "approver_id": "u-b"},
        ).status_code == 404

        # 本人依旧拿得到
        app.dependency_overrides[current_user] = lambda: account("u-a")
        assert [item["task_id"] for item in client.get("/api/tasks").json()] == [created.task_id]
        assert client.get(f"/api/tasks/{created.task_id}").status_code == 200
    finally:
        app.dependency_overrides.pop(current_user, None)
