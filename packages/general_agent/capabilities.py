from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Capability:
    agent: str
    title: str
    task_types: tuple[str, ...]
    order: int


class CapabilityRegistry:
    def __init__(self, capabilities: tuple[Capability, ...]) -> None:
        self._capabilities = capabilities
        self._enabled_agents = {item.agent for item in capabilities}

    def set_enabled(self, agents: set[str]) -> None:
        self._enabled_agents = agents

    def plan_for(
        self,
        task_type: str,
        risk_level: str,
        execution_mode: str,
        only_agent: str | None = None,
        write_target: bool = False,
        dry_run: bool = False,
    ) -> list[dict[str, object]]:
        """`only_agent` 是"运行 Agent"开关：给具体 id 时把计划收敛到这一个 Agent。

        收敛会绕过任务类型过滤（否则"指定 X"在它不适配的任务上会静默失效），
        但仍然尊重工作台里被禁用的 Agent —— 被禁用的会退回自动组队，由调用方
        在 trace 里说明，而不是悄悄忽略用户的指定。

        `write_target` 表示这次运行带写入目标：真写要追加审批门禁（要控制的不是任务
        意图，而是外部副作用）；演练（`dry_run`）也走执行与核验，好让用户看见"会写
        什么"，但不落副作用，因此不设门禁。
        """
        selected = [
            capability
            for capability in self._capabilities
            if capability.agent in self._enabled_agents
            and (task_type in capability.task_types or "all" in capability.task_types)
        ]
        if only_agent and only_agent != "auto":
            pinned = [
                capability
                for capability in self._capabilities
                if capability.agent == only_agent and capability.agent in self._enabled_agents
            ]
            if pinned:
                selected = pinned
        selected.sort(key=lambda capability: capability.order)
        # 写入链的组成：真写与高风险任务必须过审批；演练带目标但没有副作用，
        # 所以照常走执行与核验（否则"演练"什么都没演练），只是不设门禁。
        writes_for_real = write_target and not dry_run
        if execution_mode != "plan_only" and (
            writes_for_real or dry_run or risk_level == "high"
        ):
            if writes_for_real or risk_level == "high":
                selected.append(Capability("approval_gate", "等待人工审批", ("all",), 90))
            selected.extend(
                [
                    Capability("execution_agent", "执行已批准动作", ("all",), 91),
                    Capability("verification_agent", "回查执行结果", ("all",), 92),
                ]
            )
        return [
            {
                "id": f"step-{index + 1}",
                "agent": capability.agent,
                "title": capability.title,
            }
            for index, capability in enumerate(selected)
        ]

    def definitions(self) -> list[dict[str, object]]:
        return [
            {
                "agent": capability.agent,
                "title": capability.title,
                "task_types": list(capability.task_types),
                "order": capability.order,
            }
            for capability in self._capabilities
        ]

    @classmethod
    def default(cls) -> "CapabilityRegistry":
        return cls(
            (
                Capability("direct_agent", "直接回答", ("chat",), 5),
                Capability("research_agent", "收集并组织证据", ("research", "general"), 10),
                Capability("data_agent", "定义指标并分析数据", ("data",), 10),
                Capability("code_agent", "分析代码任务与实现路径", ("code",), 10),
                Capability(
                    "document_agent",
                    "整理交付文档",
                    ("research", "data", "code", "document", "general"),
                    50,
                ),
                # 显式列出而不是 "all"：闲聊直接回答不需要再走一遍独立审查。
                Capability(
                    "review_agent",
                    "独立检查完整性",
                    ("research", "data", "code", "document", "general"),
                    80,
                ),
            )
        )
