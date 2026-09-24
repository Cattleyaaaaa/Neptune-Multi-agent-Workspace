"""自由 ReAct 循环：thought → action → observation → … → finish。

与固定图编排的区别：固定图是"先排好谁上场"，ReAct 是"每一步看观察结果再决定下一步"。

策略可插拔（同一个接口）：

* `RulePolicy` —— 默认。按目标与工具描述的重合度给工具打分，工具只调一次，
  调完即收敛。没有模型也能跑通完整循环。
* `ModelPolicy` —— 由 `ReasoningProvider` 决策下一步；本地规则推理给不出有效
  工具名时自动回落 `RulePolicy`，并在 trace 里写明回落原因。

安全边界：ReAct **只调用只读工具**（read / network_read）。写入类工具不在候选里 ——
真实写入必须走固定图的执行 Agent + 审批门禁，这条不能因为"自由"而绕过。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Protocol

from packages.general_agent.mcp_client import build_arguments
from packages.general_agent.reasoning import ReasoningProvider, ReasoningRequest
from packages.general_agent.retrieval import terms
from packages.general_agent.state import GeneralTaskState
from packages.general_agent.tools import ToolRegistry

# ReAct 一次运行最多调几个工具（受任务 max_steps 与自身上限双重约束）。
MAX_ITERATIONS = 4
OBSERVATION_LIMIT = 1_200


@dataclass(frozen=True)
class ReactDecision:
    tool: str
    arguments: dict[str, object] = field(default_factory=dict)
    thought: str = ""
    finish: bool = False


class ReactPolicy(Protocol):
    async def choose(
        self,
        objective: str,
        context: str,
        steps: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> ReactDecision: ...


def tool_arguments(
    tool: dict[str, object], objective: str, context: str
) -> tuple[dict[str, object] | None, str]:
    """为候选工具构造入参。构造不出来返回 (None, 原因)，调用方跳过即可。"""
    name = str(tool.get("name") or "")
    if name == "fetch_public_url":
        urls = re.findall(r"https?://[^\s<>)\]]+", f"{objective}\n{context}")
        return ({"url": urls[0]}, "") if urls else (None, "目标里没有可抓取的链接")
    if name == "extract_research_inputs":
        return {"objective": objective, "context": context}, ""
    if name == "analyze_csv":
        return (
            ({"content": context}, "")
            if "\n" in context and "," in context
            else (None, "上下文里没有可解析的 CSV 数据")
        )
    if name == "inspect_workspace":
        return {"objective": objective}, ""
    if name.startswith("mcp:"):
        schema = tool.get("input_schema")
        return build_arguments(schema if isinstance(schema, dict) else {}, objective)
    return {}, ""


def _score(tool: dict[str, object], objective: str) -> int:
    wanted = terms(objective)
    if not wanted:
        return 0
    haystack = " ".join(
        str(tool.get(key, "")) for key in ("name", "description")
    ).lower()
    return sum(1 for term in wanted if term in haystack)


class RulePolicy:
    """规则版策略：重合度打分，每个工具最多调一次，调完或无可调即收敛。"""

    name = "rule"

    async def choose(
        self,
        objective: str,
        context: str,
        steps: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> ReactDecision:
        used = {str(step.get("tool") or "") for step in steps}
        candidates = [
            tool
            for tool in tools
            if str(tool.get("name") or "") not in used
            and str(tool.get("access") or "") in {"read", "network_read"}
        ]
        if not candidates:
            return ReactDecision(tool="", finish=True, thought="没有更多可调的只读工具，停止循环。")
        ranked = sorted(
            candidates, key=lambda tool: _score(tool, objective), reverse=True
        )
        best = ranked[0]
        arguments, reason = tool_arguments(best, objective, context)
        if arguments is None:
            return ReactDecision(
                tool="",
                finish=True,
                thought=f"跳过 {best.get('name')}：{reason}；其余工具也无法构造入参，停止循环。",
            )
        return ReactDecision(
            tool=str(best.get("name") or ""),
            arguments=arguments,
            thought=f"按关键词重合度选择 {best.get('name')}（第 {len(steps) + 1} 步）。",
        )


class ModelPolicy:
    """模型版策略：让推理 Provider 决定下一步。本地规则推理给不出工具名时回落规则策略。"""

    name = "model"

    def __init__(self, reasoner: ReasoningProvider, fallback: RulePolicy) -> None:
        self._reasoner = reasoner
        self._fallback = fallback

    async def choose(
        self,
        objective: str,
        context: str,
        steps: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> ReactDecision:
        request = ReasoningRequest(
            "ReAct 决策",
            objective,
            context,
            {
                "tools": [
                    {"name": tool.get("name"), "description": tool.get("description")}
                    for tool in tools
                ],
                "steps": steps,
                "instruction": (
                    "从 tools 里选一个最有助于推进目标的工具，"
                    "只输出形如 {\"tool\": \"名称\", \"thought\": \"一句话理由\"} 的 JSON；"
                    "认为可以收尾则输出 {\"finish\": true}。"
                ),
            },
        )
        try:
            result = await self._reasoner.reason(request)
        except Exception:  # noqa: BLE001 - 模型不可用必须回落，不能让循环卡死
            self.name = "model→rule（推理不可用，已回落）"
            return await self._fallback.choose(objective, context, steps, tools)
        chosen = self._parse(result, tools)
        if chosen is None:
            self.name = "model→rule（推理未给出可用工具，已回落）"
            return await self._fallback.choose(objective, context, steps, tools)
        arguments, reason = tool_arguments(chosen, objective, context)
        if arguments is None:
            return ReactDecision(tool="", finish=True, thought=f"跳过：{reason}")
        return ReactDecision(
            tool=str(chosen.get("name") or ""),
            arguments=arguments,
            thought="模型选择下一步工具。",
        )

    @staticmethod
    def _parse(
        result: dict[str, object], tools: list[dict[str, object]]
    ) -> dict[str, object] | None:
        if result.get("finish") is True:
            return None
        raw = result.get("tool")
        if not isinstance(raw, str) or not raw:
            return None
        for tool in tools:
            if str(tool.get("name")) == raw:
                return tool
        return None


def _observation(result: dict[str, object]) -> tuple[str, bool]:
    if not isinstance(result, dict):
        return str(result)[:OBSERVATION_LIMIT], True
    if "error" in result:
        return f"调用失败：{result.get('error')}", False
    text = json.dumps(result, ensure_ascii=False, default=str)
    return text[:OBSERVATION_LIMIT], True


@dataclass(slots=True)
class ReactAgent:
    """执行自由 ReAct 循环的节点。"""

    tools: ToolRegistry
    reasoner: ReasoningProvider | None = None
    name: str = "react_agent"
    role: str = "自由推理与工具调用"

    async def run(self, state: GeneralTaskState) -> dict[str, object]:
        objective = state["objective"]
        context = str(state.get("context") or "")
        available = [
            tool
            for tool in self.tools.definitions()
            if self.name in {str(item) for item in tool.get("allowed_agents", [])}
            and str(tool.get("access") or "") in {"read", "network_read"}
        ]
        policy: ReactPolicy = (
            ModelPolicy(self.reasoner, RulePolicy())
            if self.reasoner is not None
            else RulePolicy()
        )
        budget = min(int(state.get("max_steps", MAX_ITERATIONS)), MAX_ITERATIONS)
        steps: list[dict[str, object]] = []
        audits: list[dict[str, object]] = []
        for _ in range(max(budget, 1)):
            decision = await policy.choose(objective, context, steps, available)
            if decision.finish or not decision.tool:
                if decision.thought:
                    steps.append(
                        {
                            "step": len(steps) + 1,
                            "thought": decision.thought,
                            "tool": "",
                            "observation": "",
                            "ok": True,
                        }
                    )
                break
            result, audit = await self.tools.ainvoke(
                decision.tool, self.name, decision.arguments
            )
            observation, ok = _observation(result)
            steps.append(
                {
                    "step": len(steps) + 1,
                    "thought": decision.thought,
                    "tool": decision.tool,
                    "arguments": decision.arguments,
                    "observation": observation,
                    "ok": ok,
                }
            )
            audits.append(audit)
            if not ok:
                # 观察失败就换工具；继续尝试由下一轮 choose 决定（已用过的会被排除）。
                continue

        artifact = {
            "title": "ReAct 推理轨迹",
            "objective": objective,
            "policy": getattr(policy, "name", "rule"),
            "iterations": len([step for step in steps if step.get("tool")]),
            "steps": steps,
            "note": (
                "自由循环只调用只读工具；真实写入仍走执行 Agent 与审批门禁。"
            ),
        }
        summary = (
            f"ReAct 循环完成 {artifact['iterations']} 次工具调用"
            if artifact["iterations"]
            else "ReAct 循环未找到可调的只读工具，直接收尾"
        )
        return {
            "phase": "reacting",
            "completed_agents": [self.name],
            "artifacts": {self.name: artifact},
            "tool_trace": audits,
            "agent_trace": [
                {
                    "agent": self.name,
                    "role": self.role,
                    "status": "completed",
                    "summary": summary,
                    "handoff": None,
                }
            ],
        }
