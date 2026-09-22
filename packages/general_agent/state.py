import operator
from typing import Annotated, NotRequired, TypedDict


class GeneralAgentEvent(TypedDict):
    agent: str
    role: str
    status: str
    summary: str
    handoff: str | None


class ToolEvent(TypedDict):
    tool: str
    agent: str
    access: str
    status: str
    summary: str


class GeneralTaskState(TypedDict):
    task_id: str
    thread_id: str
    objective: str
    context: str
    execution_mode: str
    max_steps: int
    timeout_seconds: int
    dispatch_count: int
    status: str
    phase: str
    conversation_id: NotRequired[str | None]
    requested_agent: NotRequired[str | None]
    knowledge: NotRequired[dict[str, object]]
    applied_skills: NotRequired[list[str]]
    task_type: NotRequired[str]
    risk_level: NotRequired[str]
    plan: NotRequired[list[dict[str, object]]]
    completed_agents: Annotated[list[str], operator.add]
    artifacts: Annotated[dict[str, object], operator.or_]
    agent_trace: Annotated[list[GeneralAgentEvent], operator.add]
    tool_trace: Annotated[list[ToolEvent], operator.add]
    next_agent: NotRequired[str]
    approval: NotRequired[dict[str, object]]
    final_response: NotRequired[str | None]
    updated_at: NotRequired[str]
