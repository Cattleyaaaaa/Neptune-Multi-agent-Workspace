import asyncio
import logging
import uuid
from collections import defaultdict
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from apps.api.task_store import TaskStore
from apps.api.workspace import ManagedContext
from packages.contracts.models import ApprovalDecision, StartTaskRequest, TaskView
from packages.general_agent.capabilities import CapabilityRegistry
from packages.general_agent.graph import build_general_graph
from packages.general_agent.reasoning import ReasoningProvider
from packages.general_agent.state import GeneralTaskState
from packages.general_agent.tools import ToolRegistry


class TaskNotFoundError(KeyError):
    pass


class InvalidTaskStateError(RuntimeError):
    pass


@dataclass(frozen=True)
class Viewer:
    """谁在看这份任务列表。管理员看全部，其他人只看自己创建的。"""

    user_id: str
    is_admin: bool = False


class TaskService:
    def __init__(
        self,
        reasoner: ReasoningProvider | None = None,
        store: TaskStore | None = None,
        registry: CapabilityRegistry | None = None,
        context_provider: Callable[[str, bool], ManagedContext] | None = None,
        policy_provider: Callable[[], dict[str, object]] | None = None,
        tools: ToolRegistry | None = None,
    ) -> None:
        self._tools = tools or ToolRegistry(Path(__file__).resolve().parents[2])
        self._graph = build_general_graph(InMemorySaver(), reasoner, registry, self._tools)
        self._store = store
        self._context_provider = context_provider
        self._policy_provider = policy_provider
        self._tasks = store.load_tasks() if store else {}
        self._owners: dict[str, str | None] = store.load_task_owners() if store else {}
        saved_events = store.load_events() if store else {}
        self._events: dict[str, list[dict[str, object]]] = defaultdict(list, saved_events)
        self._conditions: dict[str, asyncio.Condition] = defaultdict(asyncio.Condition)
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    async def create_task(
        self, request: StartTaskRequest, owner_id: str | None = None
    ) -> TaskView:
        task_id = uuid.uuid4().hex[:12]
        thread_id = str(uuid.uuid4())
        if self._context_provider is None:
            managed = ManagedContext("")
        else:
            # 检索可能调用远程 embedding 服务，放进线程避免阻塞事件循环。
            managed = await asyncio.to_thread(
                self._context_provider, request.objective, request.use_knowledge_base
            )
        policies = self._policy_provider() if self._policy_provider else {}
        max_steps = min(request.max_steps, int(policies.get("max_steps", request.max_steps)))
        timeout_seconds = min(
            request.timeout_seconds,
            int(policies.get("timeout_seconds", request.timeout_seconds)),
        )
        context = "\n\n".join(item for item in (request.context, managed.text) if item)
        initial: GeneralTaskState = {
            "task_id": task_id,
            "thread_id": thread_id,
            "objective": request.objective,
            "context": context,
            "execution_mode": request.execution_mode,
            "max_steps": max_steps,
            "timeout_seconds": timeout_seconds,
            "dispatch_count": 0,
            "status": "running",
            "phase": "intake",
            "conversation_id": request.conversation_id,
            "requested_agent": request.agent,
            "execution_target": request.execution_target,
            "dry_run": request.dry_run,
            "run_mode": request.run_mode,
            "knowledge": managed.knowledge,
            "applied_skills": managed.skills,
            "completed_agents": [],
            "artifacts": {},
            "agent_trace": [],
            "tool_trace": [],
        }
        self._tasks[task_id] = initial
        self._owners[task_id] = owner_id
        self._persist(initial, owner_id)
        await self._publish(task_id, "task.started", {"phase": "intake"})
        await self._run(task_id, thread_id, initial)
        return self.get_task(task_id)

    async def decide(
        self, task_id: str, decision: ApprovalDecision, viewer: Viewer | None = None
    ) -> TaskView:
        self._require_visible(task_id, viewer)
        async with self._locks[task_id]:
            task = self._require(task_id)
            if task["status"] != "awaiting_approval":
                raise InvalidTaskStateError("task is not awaiting approval")
            await self._ensure_checkpoint(task)
            payload = decision.model_dump()
            payload["approval_id"] = f"APR-{task_id}"
            await self._publish(task_id, "approval.received", payload)
            await self._run(task_id, task["thread_id"], Command(resume=payload))
            return self.get_task(task_id)

    def can_view(self, task_id: str, viewer: Viewer | None) -> bool:
        if viewer is None or viewer.is_admin:
            return True
        owner = self._owners.get(task_id)
        return owner is not None and owner == viewer.user_id

    def get_task(self, task_id: str, viewer: Viewer | None = None) -> TaskView:
        return TaskView.model_validate(self._require_visible(task_id, viewer))

    def list_tasks(self, viewer: Viewer | None = None) -> list[TaskView]:
        return [
            TaskView.model_validate(task)
            for task in reversed(list(self._tasks.values()))
            if self.can_view(str(task["task_id"]), viewer)
        ]

    def tool_definitions(self) -> list[dict[str, object]]:
        """内置工具 + 已接入的 MCP 工具，供运行环境页与前端展示。"""
        return self._tools.definitions()

    async def events(
        self, task_id: str, after: int = 0, viewer: Viewer | None = None
    ) -> AsyncIterator[dict[str, object]]:
        self._require_visible(task_id, viewer)
        cursor = max(after, 0)
        while True:
            events = self._events[task_id]
            while cursor < len(events):
                event_item = events[cursor]
                cursor += 1
                yield {**event_item, "id": cursor}
            condition = self._conditions[task_id]
            try:
                async with condition:
                    await asyncio.wait_for(condition.wait(), timeout=15)
            except TimeoutError:
                yield {"id": cursor, "event": "heartbeat", "data": {}}

    async def _run(self, task_id: str, thread_id: str, graph_input: object) -> None:
        try:
            timeout_seconds = self._tasks[task_id].get("timeout_seconds", 45)
            async with asyncio.timeout(timeout_seconds):
                async for state in self._graph.astream(
                    graph_input, self._config(thread_id), stream_mode="values"
                ):
                    current = self._public_state(state)
                    self._tasks[task_id] = current  # type: ignore[assignment]
                    self._persist(self._tasks[task_id])
                    await self._publish(
                        task_id,
                        "task.updated",
                        {"phase": state.get("phase"), "status": state.get("status")},
                    )
            await self._store_graph_state(task_id, thread_id)
        except TimeoutError:
            await self._fail(task_id, "timeout", "任务超过时间限制，已停止自动执行。")
        except Exception:
            logging.getLogger(__name__).exception("Task %s failed", task_id)
            await self._fail(task_id, "failed", "任务执行出现异常，已停止自动处理。")

    async def _store_graph_state(self, task_id: str, thread_id: str) -> None:
        snapshot = await self._graph.aget_state(self._config(thread_id))
        state = self._public_state(snapshot.values)
        if snapshot.next:
            state["status"] = "awaiting_approval"
            state["phase"] = "approval"
        self._tasks[task_id] = state  # type: ignore[assignment]
        self._persist(self._tasks[task_id])
        await self._publish(
            task_id,
            "task.updated",
            {"phase": state.get("phase"), "status": state.get("status")},
        )

    @staticmethod
    def _public_state(state: dict[str, Any]) -> dict[str, Any]:
        """Remove LangGraph runtime metadata before serialization."""
        return {key: value for key, value in dict(state).items() if not key.startswith("__")}

    def _require(self, task_id: str) -> GeneralTaskState:
        try:
            return self._tasks[task_id]
        except KeyError as exc:
            raise TaskNotFoundError(task_id) from exc

    def _require_visible(self, task_id: str, viewer: Viewer | None) -> GeneralTaskState:
        # 看不到的任务按「不存在」处理：不告诉调用方这个 id 是否真的存在
        if not self.can_view(task_id, viewer):
            raise TaskNotFoundError(task_id)
        return self._require(task_id)

    @staticmethod
    def _config(thread_id: str) -> dict[str, dict[str, str]]:
        return {"configurable": {"thread_id": thread_id}}

    async def _publish(self, task_id: str, name: str, data: dict[str, object]) -> None:
        self._events[task_id].append({"event": name, "data": data})
        if self._store:
            self._store.append_event(task_id, name, data)
        async with self._conditions[task_id]:
            self._conditions[task_id].notify_all()

    async def _ensure_checkpoint(self, task: GeneralTaskState) -> None:
        snapshot = await self._graph.aget_state(self._config(task["thread_id"]))
        if snapshot.values:
            return
        replay: GeneralTaskState = {
            "task_id": task["task_id"],
            "thread_id": task["thread_id"],
            "objective": task["objective"],
            "context": task["context"],
            "execution_mode": task["execution_mode"],
            "max_steps": task.get("max_steps", 12),
            "timeout_seconds": task.get("timeout_seconds", 45),
            "dispatch_count": 0,
            "status": "running",
            "phase": "intake",
            "conversation_id": task.get("conversation_id"),
            "requested_agent": task.get("requested_agent"),
            "execution_target": task.get("execution_target"),
            "dry_run": task.get("dry_run", False),
            "run_mode": task.get("run_mode", "graph"),
            "knowledge": task.get("knowledge", {}),
            "applied_skills": task.get("applied_skills", []),
            "completed_agents": [],
            "artifacts": {},
            "agent_trace": [],
            "tool_trace": [],
        }
        await self._run(task["task_id"], task["thread_id"], replay)

    async def _fail(self, task_id: str, phase: str, message: str) -> None:
        self._tasks[task_id].update(
            status="needs_human", phase=phase, final_response=message
        )
        self._persist(self._tasks[task_id])
        await self._publish(
            task_id, "task.updated", {"phase": phase, "status": "needs_human"}
        )

    def _persist(self, state: GeneralTaskState, owner_id: str | None = None) -> None:
        if self._store:
            # Keep the in-memory timestamp moving so a running task shows a
            # fresh "updated" time instead of the value read at startup.
            # 更新时不传 owner_id，存储层用 COALESCE 保留原归属。
            state["updated_at"] = self._store.save_task(state, owner_id)
