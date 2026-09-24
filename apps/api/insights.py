"""真实运行数据的统计接口：可观测性、用量、成员。

这些页面以前是示例数据，现在全部来自 SQLite 里的真实任务、事件与账号记录。
采集不到的东西（比如本地推理不上报 token 用量）如实标注 `collected: false`，
不拿假数据把图表填满。
"""

from __future__ import annotations

from collections import Counter
from datetime import date, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends

from apps.api.auth import Account, current_user
from apps.api.auth_store import AuthStore
from apps.api.settings import settings
from apps.api.task_store import TaskStore

router = APIRouter(prefix="/api", tags=["insights"])

WINDOW_DAYS = 7


def _task_store() -> TaskStore:
    return TaskStore(Path(settings.database_path))


def _day(value: object) -> str:
    return str(value or "")[:10]


def _window() -> list[str]:
    today = date.today()
    return [
        (today - timedelta(days=offset)).isoformat()
        for offset in range(WINDOW_DAYS - 1, -1, -1)
    ]


def _counter_rows(counter: Counter[str]) -> list[dict[str, object]]:
    return [{"label": key, "value": value} for key, value in counter.most_common()]


@router.get("/observability")
async def observability(_: Account = Depends(current_user)) -> dict[str, object]:
    store = _task_store()
    tasks = store.load_tasks()
    events = store.load_events()

    status: Counter[str] = Counter()
    phases: Counter[str] = Counter()
    tool_calls: Counter[str] = Counter()
    tool_failed: Counter[str] = Counter()
    tool_access: dict[str, str] = {}
    agents: Counter[str] = Counter()
    for task in tasks.values():
        status[str(task.get("status"))] += 1
        phases[str(task.get("phase"))] += 1
        for item in task.get("tool_trace", []) or []:
            name = str(item.get("tool") or "")
            tool_calls[name] += 1
            tool_access[name] = str(item.get("access") or "")
            if item.get("status") != "succeeded":
                tool_failed[name] += 1
        for item in task.get("agent_trace", []) or []:
            agents[str(item.get("agent") or "")] += 1

    task_days: Counter[str] = Counter()
    for task in tasks.values():
        task_days[_day(task.get("updated_at"))] += 1
    event_days: Counter[str] = Counter()
    for items in events.values():
        for item in items:
            event_days[_day(item.get("created_at"))] += 1
    window = _window()
    daily = [
        {
            "label": day[5:],
            "tasks": task_days.get(day, 0),
            "events": event_days.get(day, 0),
        }
        for day in window
    ]

    total = len(tasks)
    succeeded = status.get("completed", 0)
    recent = sorted(
        tasks.values(),
        key=lambda item: str(item.get("updated_at") or ""),
        reverse=True,
    )[:8]
    return {
        "collected": total > 0,
        "totals": {
            "tasks": total,
            "completed": succeeded,
            "failed": status.get("failed", 0),
            "needs_human": status.get("needs_human", 0),
            "awaiting_approval": status.get("awaiting_approval", 0),
            "rejected": status.get("rejected", 0),
            "tool_calls": sum(tool_calls.values()),
            "tool_failures": sum(tool_failed.values()),
            "events": sum(len(items) for items in events.values()),
        },
        "success_rate": round(succeeded / total, 3) if total else 0.0,
        "status_breakdown": _counter_rows(status),
        "phase_breakdown": _counter_rows(phases),
        "tool_calls": [
            {
                "tool": name,
                "calls": calls,
                "failed": tool_failed.get(name, 0),
                "access": tool_access.get(name, ""),
            }
            for name, calls in tool_calls.most_common()
        ],
        "agent_activity": _counter_rows(agents),
        "daily": daily,
        "recent": [
            {
                "task_id": str(item.get("task_id")),
                "objective": str(item.get("objective"))[:80],
                "status": str(item.get("status")),
                "phase": str(item.get("phase")),
                "updated_at": str(item.get("updated_at") or ""),
            }
            for item in recent
        ],
        "note": "" if total else "还没有任何运行记录，图表会在首次运行后自动填充。",
    }


@router.get("/usage")
async def usage(_: Account = Depends(current_user)) -> dict[str, object]:
    """Token 用量只在推理服务真的上报 usage 时才统计得到。

    本地规则推理（`local-structured`）不上报用量，此时 `collected` 为 false，
    但运行量指标（任务数 / 步骤数 / 工具调用数）依然是真实的。
    """
    tasks = _task_store().load_tasks()
    prompt = completion = total_tokens = 0
    by_role: Counter[str] = Counter()
    by_day: Counter[str] = Counter()
    provider = ""
    collected = False

    for task in tasks.values():
        artifacts = task.get("artifacts") or {}
        if not isinstance(artifacts, dict):
            continue
        for artifact in artifacts.values():
            if not isinstance(artifact, dict):
                continue
            reasoning = artifact.get("reasoning")
            if not isinstance(reasoning, dict):
                continue
            provider = provider or str(reasoning.get("provider") or "")
            record = reasoning.get("usage")
            if not isinstance(record, dict) or not record:
                continue
            part_in = int(record.get("input_tokens") or record.get("prompt_tokens") or 0)
            part_out = int(record.get("output_tokens") or record.get("completion_tokens") or 0)
            part_total = int(record.get("total_tokens") or part_in + part_out)
            if part_total <= 0:
                continue
            collected = True
            prompt += part_in
            completion += part_out
            total_tokens += part_total
            by_role[str(reasoning.get("role") or "推理")] += part_total
            by_day[_day(task.get("updated_at"))] += part_total

    steps = sum(len(task.get("plan") or []) for task in tasks.values())
    calls = sum(len(task.get("tool_trace") or []) for task in tasks.values())
    window = _window()
    return {
        "collected": collected,
        "provider": provider or "local-structured",
        "totals": {
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "total_tokens": total_tokens,
        },
        "by_role": _counter_rows(by_role),
        "by_day": [{"label": day[5:], "tokens": by_day.get(day, 0)} for day in window],
        "runs": {"tasks": len(tasks), "steps": steps, "tool_calls": calls},
        "note": (
            ""
            if collected
            else "当前推理 Provider 不上报 token 用量，图表为空；"
            "运行量指标来自真实运行记录。"
        ),
    }


@router.get("/members")
async def members(_: Account = Depends(current_user)) -> dict[str, object]:
    """成员来自真实 users 表。密码哈希等敏感字段绝不外泄。"""
    store = AuthStore(Path(settings.database_path))
    rows = store.list_users()
    return {
        "members": [
            {
                "user_id": str(row.get("user_id") or ""),
                "username": str(row.get("username") or ""),
                "display_name": str(row.get("display_name") or ""),
                "role": str(row.get("role") or "member"),
                "must_change_password": bool(row.get("must_change_password")),
                "disabled": bool(row.get("disabled")),
                "last_login_at": str(row.get("last_login_at") or ""),
                "created_at": str(row.get("created_at") or ""),
            }
            for row in rows
        ],
        "roles": [
            {
                "role": "admin",
                "label": "管理员",
                "scopes": ["workspace", "agents", "governance"],
            },
            {"role": "member", "label": "成员", "scopes": ["runtime"]},
        ],
        "note": "角色字段已入库，但尚未用于页面级授权。",
    }
