"""定时任务：真落库 + 真调度。

以前这个页面是 localStorage 里的示例数据，点了"启用"什么都不会发生。
现在：配置存 SQLite，后台循环每 30 秒检查到期任务，到期就用 TaskService
真跑一次（跑出来的 task_id 会回写到这条定时记录上，能直接跳到运行步骤）。

cron 支持标准五段（分 时 日 月 周），字段允许 `*`、`*/n`、数字与逗号列表。
"""

from __future__ import annotations

import asyncio
import json
import secrets
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Response, status

from apps.api.auth import Account, current_user
from apps.api.settings import settings
from packages.contracts.models import ScheduleDraft, ScheduleView

POLL_SECONDS = 30
MAX_LOOKAHEAD_MINUTES = 45 * 24 * 60


class ScheduleError(ValueError):
    pass


def parse_field(field: str, minimum: int, maximum: int) -> set[int]:
    values: set[int] = set()
    for part in field.split(","):
        part = part.strip()
        if not part:
            continue
        if part == "*":
            values.update(range(minimum, maximum + 1))
            continue
        if part.startswith("*/"):
            step = int(part[2:])
            if step <= 0:
                raise ScheduleError(f"步长必须为正数：{part}")
            values.update(range(minimum, maximum + 1, step))
            continue
        if "-" in part:
            start, _, end = part.partition("-")
            values.update(range(int(start), int(end) + 1))
            continue
        values.add(int(part))
    if not values or any(value < minimum or value > maximum for value in values):
        raise ScheduleError(f"cron 字段超出取值范围：{field}")
    return values


def next_run_after(cron: str, after: datetime) -> datetime:
    """返回 cron 在 after 之后的下一个触发时刻。找不到就在有限窗口内放弃。"""
    parts = cron.split()
    if len(parts) != 5:
        raise ScheduleError("cron 需要五段：分 时 日 月 周")
    minutes = parse_field(parts[0], 0, 59)
    hours = parse_field(parts[1], 0, 23)
    months = parse_field(parts[3], 1, 12)
    # 日与周同时给定时按"或"处理，与多数 cron 实现一致。
    days = parse_field(parts[2], 1, 31) if parts[2] != "*" else None
    weekdays = parse_field(parts[4], 0, 6) if parts[4] != "*" else None

    candidate = (after + timedelta(minutes=1)).replace(second=0, microsecond=0)
    for _ in range(MAX_LOOKAHEAD_MINUTES):
        if candidate.month not in months:
            candidate = (candidate.replace(day=1) + timedelta(days=32)).replace(
                day=1, hour=0, minute=0
            )
            continue
        day_ok = days is None or candidate.day in days
        weekday_ok = weekdays is None or candidate.weekday() in weekdays
        if not (day_ok and weekday_ok):
            candidate = (candidate + timedelta(days=1)).replace(hour=0, minute=0)
            continue
        if candidate.hour not in hours or candidate.minute not in minutes:
            candidate += timedelta(minutes=1)
            continue
        return candidate
    raise ScheduleError("在 45 天内找不到匹配的触发时刻")


class ScheduleStore:
    def __init__(self, database_path: Path) -> None:
        self.path = database_path.resolve()
        # 和 TaskStore / AuthStore 保持一致：自己把父目录建出来。缺了这行，
        # 在**全新目录**（比如刚解包出来的部署目录）里启动会在导入阶段直接
        # `sqlite3.OperationalError: unable to open database file` —— 而谁先被实例化
        # 取决于导入顺序，所以不能指望别的 store 先替它把 data/ 建好。
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def list(self) -> list[dict[str, object]]:
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT * FROM schedules ORDER BY created_at"
            ).fetchall()
        return [dict(row) for row in rows]

    def get(self, schedule_id: str) -> dict[str, object] | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT * FROM schedules WHERE schedule_id = ?", (schedule_id,)
            ).fetchone()
        return dict(row) if row else None

    def create(self, draft: ScheduleDraft, next_run: datetime) -> dict[str, object]:
        schedule_id = f"sch-{secrets.token_hex(6)}"
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """
                INSERT INTO schedules (
                    schedule_id, name, objective, cron, enabled, agent,
                    use_knowledge_base, execution_mode, run_mode, execution_target, next_run_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    schedule_id,
                    draft.name,
                    draft.objective,
                    draft.cron,
                    1 if draft.enabled else 0,
                    draft.agent,
                    1 if draft.use_knowledge_base else 0,
                    draft.execution_mode,
                    draft.run_mode,
                    json.dumps(draft.execution_target or {}, ensure_ascii=False),
                    next_run.isoformat(timespec="minutes"),
                ),
            )
        created = self.get(schedule_id)
        assert created is not None
        return created

    def update(
        self, schedule_id: str, changes: dict[str, object]
    ) -> dict[str, object] | None:
        if self.get(schedule_id) is None:
            return None
        fields: list[str] = []
        values: list[object] = []
        for key in ("name", "objective", "cron", "agent", "execution_mode", "run_mode"):
            if isinstance(changes.get(key), str):
                fields.append(f"{key} = ?")
                values.append(str(changes[key]))
        for key in ("enabled", "use_knowledge_base"):
            if isinstance(changes.get(key), bool):
                fields.append(f"{key} = ?")
                values.append(1 if changes[key] else 0)
        if isinstance(changes.get("execution_target"), (dict, type(None))):
            target = changes.get("execution_target") or {}
            fields.append("execution_target = ?")
            values.append(json.dumps(target, ensure_ascii=False))
        if isinstance(changes.get("next_run_at"), str):
            fields.append("next_run_at = ?")
            values.append(str(changes["next_run_at"]))
        if not fields:
            return self.get(schedule_id)
        fields.append("updated_at = CURRENT_TIMESTAMP")
        values.append(schedule_id)
        with closing(self._connect()) as connection, connection:
            connection.execute(
                f"UPDATE schedules SET {', '.join(fields)} WHERE schedule_id = ?",  # noqa: S608 - 字段名来自白名单
                tuple(values),
            )
        return self.get(schedule_id)

    def delete(self, schedule_id: str) -> bool:
        if self.get(schedule_id) is None:
            return False
        with closing(self._connect()) as connection, connection:
            connection.execute("DELETE FROM schedules WHERE schedule_id = ?", (schedule_id,))
        return True

    def due(self, now: datetime) -> list[dict[str, object]]:
        stamp = now.isoformat(timespec="minutes")
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ?", (stamp,)
            ).fetchall()
        return [dict(row) for row in rows]

    def record_run(self, schedule_id: str, task_id: str, next_run: datetime) -> None:
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """
                UPDATE schedules
                   SET last_run_at = CURRENT_TIMESTAMP, last_task_id = ?, next_run_at = ?,
                       updated_at = CURRENT_TIMESTAMP
                 WHERE schedule_id = ?
                """,
                (task_id, next_run.isoformat(timespec="minutes"), schedule_id),
            )

    def _initialize(self) -> None:
        with closing(self._connect()) as connection, connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS schedules (
                    schedule_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    objective TEXT NOT NULL,
                    cron TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    agent TEXT NOT NULL DEFAULT 'auto',
                    use_knowledge_base INTEGER NOT NULL DEFAULT 1,
                    execution_mode TEXT NOT NULL DEFAULT 'auto',
                    run_mode TEXT NOT NULL DEFAULT 'graph',
                    execution_target TEXT NOT NULL DEFAULT '{}',
                    last_run_at TEXT,
                    last_task_id TEXT,
                    next_run_at TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection


def to_view(row: dict[str, object]) -> ScheduleView:
    try:
        target = json.loads(str(row.get("execution_target") or "{}"))
    except json.JSONDecodeError:
        target = {}
    return ScheduleView(
        schedule_id=str(row["schedule_id"]),
        name=str(row["name"]),
        objective=str(row["objective"]),
        cron=str(row["cron"]),
        enabled=bool(row.get("enabled")),
        agent=str(row.get("agent") or "auto"),
        use_knowledge_base=bool(row.get("use_knowledge_base")),
        execution_mode=str(row.get("execution_mode") or "auto"),
        run_mode=str(row.get("run_mode") or "graph"),
        execution_target=target if isinstance(target, dict) else {},
        last_run_at=str(row.get("last_run_at") or ""),
        last_task_id=str(row.get("last_task_id") or ""),
        next_run_at=str(row.get("next_run_at") or ""),
        created_at=str(row.get("created_at") or ""),
        updated_at=str(row.get("updated_at") or ""),
    )


_store: ScheduleStore | None = None


def get_schedule_store() -> ScheduleStore:
    global _store
    if _store is None:
        _store = ScheduleStore(Path(settings.database_path))
    return _store


class ScheduleRunner:
    """后台循环：到点就用 TaskService 真跑一次。"""

    def __init__(self, store: ScheduleStore) -> None:
        self._store = store
        self._service: object | None = None
        self._task: asyncio.Task[None] | None = None

    def bind(self, service: object) -> None:
        self._service = service

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop())

    def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            self._task = None

    async def _loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(POLL_SECONDS)
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - 调度循环不能因为一次异常就死掉
                continue

    async def tick(self) -> None:
        if self._service is None:
            return
        now = datetime.now()
        for row in self._store.due(now):
            try:
                next_run = next_run_after(str(row["cron"]), now)
            except ScheduleError:
                continue
            task = await self._service.create_task(  # type: ignore[attr-defined]
                _request_for(row, str(row["schedule_id"]))
            )
            self._store.record_run(str(row["schedule_id"]), str(task.task_id), next_run)


def _request_for(row: dict[str, object], schedule_id: str):
    from packages.contracts.models import StartTaskRequest

    try:
        target = json.loads(str(row.get("execution_target") or "{}"))
    except json.JSONDecodeError:
        target = {}
    return StartTaskRequest(
        objective=str(row.get("objective") or ""),
        execution_mode=str(row.get("execution_mode") or "auto"),  # type: ignore[arg-type]
        agent=str(row.get("agent") or "auto"),
        use_knowledge_base=bool(row.get("use_knowledge_base")),
        run_mode=str(row.get("run_mode") or "graph"),  # type: ignore[arg-type]
        execution_target=target if isinstance(target, dict) else None,
        conversation_id=f"schedule-{schedule_id}",
    )


runner = ScheduleRunner(get_schedule_store())
schedule_router = APIRouter(prefix="/api/schedules", tags=["schedules"])


@schedule_router.get("", response_model=list[ScheduleView])
async def list_schedules(_: Account = Depends(current_user)) -> list[ScheduleView]:
    return [to_view(row) for row in get_schedule_store().list()]


@schedule_router.post("", response_model=ScheduleView, status_code=status.HTTP_201_CREATED)
async def create_schedule(
    draft: ScheduleDraft, _: Account = Depends(current_user)
) -> ScheduleView:
    try:
        next_run = next_run_after(draft.cron, datetime.now())
    except (ScheduleError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return to_view(get_schedule_store().create(draft, next_run))


@schedule_router.put("/{schedule_id}", response_model=ScheduleView)
async def update_schedule(
    schedule_id: str, changes: dict[str, object], _: Account = Depends(current_user)
) -> ScheduleView:
    store = get_schedule_store()
    row = store.get(schedule_id)
    if row is None:
        raise HTTPException(status_code=404, detail="定时任务不存在")
    if isinstance(changes.get("cron"), str):
        try:
            changes["next_run_at"] = next_run_after(
                str(changes["cron"]), datetime.now()
            ).isoformat(timespec="minutes")
        except (ScheduleError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    updated = store.update(schedule_id, changes)
    if updated is None:
        raise HTTPException(status_code=404, detail="定时任务不存在")
    return to_view(updated)


@schedule_router.delete("/{schedule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_schedule(
    schedule_id: str, _: Account = Depends(current_user)
) -> Response:
    if not get_schedule_store().delete(schedule_id):
        raise HTTPException(status_code=404, detail="定时任务不存在")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@schedule_router.post("/{schedule_id}/run", response_model=ScheduleView)
async def run_now(
    schedule_id: str, _: Account = Depends(current_user)
) -> ScheduleView:
    """立即执行一次：不动 cron，也不改下次触发时间。"""
    store = get_schedule_store()
    row = store.get(schedule_id)
    if row is None:
        raise HTTPException(status_code=404, detail="定时任务不存在")
    if runner._service is None:  # noqa: SLF001 - 同一个模块内需要知道是否已完成装配
        raise HTTPException(status_code=503, detail="调度器尚未绑定任务服务")
    task = await runner._service.create_task(  # type: ignore[attr-defined]
        _request_for(row, schedule_id)
    )
    store.record_run(
        schedule_id, str(task.task_id), datetime.now() + timedelta(minutes=1)
    )
    updated = store.get(schedule_id)
    assert updated is not None
    return to_view(updated)
