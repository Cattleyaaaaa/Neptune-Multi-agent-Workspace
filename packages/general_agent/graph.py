from pathlib import Path

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from packages.general_agent.agents import (
    CodeAgent,
    DataAgent,
    DirectReplyAgent,
    DocumentAgent,
    ExecutionAgent,
    GeneralSupervisorAgent,
    PlannerAgent,
    ResearchAgent,
    ReviewAgent,
    TaskIntakeAgent,
    VerificationAgent,
    event,
)
from packages.general_agent.capabilities import CapabilityRegistry
from packages.general_agent.react import ReactAgent
from packages.general_agent.reasoning import LocalStructuredReasoner, ReasoningProvider
from packages.general_agent.state import GeneralTaskState
from packages.general_agent.tools import ToolRegistry


def build_general_graph(  # type: ignore[type-arg]
    checkpointer: BaseCheckpointSaver[object],
    reasoner: ReasoningProvider | None = None,
    registry: CapabilityRegistry | None = None,
    tools: ToolRegistry | None = None,
    react_agent: object | None = None,
):
    # 外部传入的 tools 已经绑好了执行适配器和 MCP provider；不传就用纯内置只读工具。
    tools = tools or ToolRegistry(Path(__file__).resolve().parents[2])
    reasoner = reasoner or LocalStructuredReasoner()
    intake = TaskIntakeAgent()
    planner = PlannerAgent(registry or CapabilityRegistry.default())
    supervisor = GeneralSupervisorAgent()
    workers = {
        "direct_agent": DirectReplyAgent(),
        "research_agent": ResearchAgent(tools, reasoner),
        "data_agent": DataAgent(tools, reasoner),
        "code_agent": CodeAgent(tools, reasoner),
        "document_agent": DocumentAgent(reasoner),
        "review_agent": ReviewAgent(reasoner),
        "execution_agent": ExecutionAgent(tools),
        "verification_agent": VerificationAgent(),
    }

    def approval_gate(state: GeneralTaskState) -> dict[str, object]:
        decision = interrupt(
            {
                "kind": "general_task_approval",
                "task_id": state["task_id"],
                "objective": state["objective"],
                "risk_level": state.get("risk_level"),
                "artifacts": state.get("artifacts", {}),
            }
        )
        if not isinstance(decision, dict):
            raise TypeError("Approval decision must be an object")
        approved = decision.get("decision") == "approve"
        return {
            "approval": decision,
            "completed_agents": ["approval_gate"],
            "status": "running" if approved else "rejected",
            "phase": "dispatching" if approved else "rejected",
            "final_response": None if approved else "任务执行未获批准，流程已结束。",
            "agent_trace": [
                event(
                    "approval_gate",
                    "人工审批",
                    "高风险执行已获批准" if approved else "高风险执行被拒绝",
                )
            ],
        }

    def route(state: GeneralTaskState) -> str:
        return state.get("next_agent", "end")

    destinations = {name: name for name in workers}
    destinations.update(
        {"react_agent": "react_agent", "approval_gate": "approval_gate", "end": END}
    )

    graph = StateGraph(GeneralTaskState)
    graph.add_node("intake_agent", intake.run)
    graph.add_node("planner_agent", planner.run)
    graph.add_node("supervisor_agent", supervisor.dispatch)
    # ReAct 节点常驻：run_mode=react 时 Planner 会把计划收敛到它。
    graph.add_node("react_agent", (react_agent or ReactAgent(tools, reasoner)).run)
    graph.add_edge("react_agent", "supervisor_agent")
    for name, worker in workers.items():
        graph.add_node(name, worker.run)
        graph.add_edge(name, "supervisor_agent")
    graph.add_node("approval_gate", approval_gate)
    graph.add_edge("approval_gate", "supervisor_agent")
    graph.add_edge(START, "intake_agent")
    graph.add_edge("intake_agent", "planner_agent")
    graph.add_edge("planner_agent", "supervisor_agent")
    graph.add_conditional_edges("supervisor_agent", route, destinations)
    return graph.compile(checkpointer=checkpointer)
