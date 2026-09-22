import asyncio
from dataclasses import dataclass
from typing import Literal

from packages.general_agent.capabilities import CapabilityRegistry
from packages.general_agent.reasoning import ReasoningProvider, ReasoningRequest
from packages.general_agent.state import GeneralAgentEvent, GeneralTaskState
from packages.general_agent.tools import ToolRegistry

TaskType = Literal["research", "data", "code", "document", "general"]


def event(
    agent: str,
    role: str,
    summary: str,
    *,
    status: str = "completed",
    handoff: str | None = None,
) -> GeneralAgentEvent:
    return {
        "agent": agent,
        "role": role,
        "status": status,
        "summary": summary,
        "handoff": handoff,
    }


@dataclass(slots=True)
class TaskIntakeAgent:
    name: str = "intake_agent"
    role: str = "任务理解"

    async def run(self, state: GeneralTaskState) -> dict[str, object]:
        objective = state["objective"].lower()
        task_type = self._classify(objective)
        risk_level = self._risk(objective)
        return {
            "task_type": task_type,
            "risk_level": risk_level,
            "phase": "planning",
            "completed_agents": [self.name],
            "agent_trace": [
                event(
                    self.name,
                    self.role,
                    f"识别为{self._type_label(task_type)}任务，风险等级 {risk_level}",
                )
            ],
        }

    @staticmethod
    def _classify(objective: str) -> TaskType:
        keyword_groups: list[tuple[TaskType, tuple[str, ...]]] = [
            ("research", ("研究", "调研", "比较", "竞品", "资料", "报告", "选型")),
            ("code", ("代码", "开发", "修复", "bug", "api", "程序", "仓库", "测试")),
            ("data", ("数据", "excel", "csv", "统计", "指标", "图表", "分析表")),
            ("document", ("文档", "方案书", "ppt", "演示", "总结", "撰写")),
        ]
        for task_type, keywords in keyword_groups:
            if any(keyword in objective for keyword in keywords):
                return task_type
        return "general"

    @staticmethod
    def _risk(objective: str) -> str:
        high_risk = ("发送", "发布", "部署", "删除", "支付", "退款", "提交", "写入生产")
        medium_risk = ("修改", "创建", "生成文件", "更新", "安装")
        if any(keyword in objective for keyword in high_risk):
            return "high"
        if any(keyword in objective for keyword in medium_risk):
            return "medium"
        return "low"

    @staticmethod
    def _type_label(task_type: TaskType) -> str:
        return {
            "research": "研究",
            "data": "数据",
            "code": "软件工程",
            "document": "文档",
            "general": "通用",
        }[task_type]


@dataclass(slots=True)
class PlannerAgent:
    registry: CapabilityRegistry
    name: str = "planner_agent"
    role: str = "任务规划"

    async def run(self, state: GeneralTaskState) -> dict[str, object]:
        task_type = state.get("task_type", "general")
        requested = state.get("requested_agent") or ""
        plan = self.registry.plan_for(
            task_type,
            state.get("risk_level", "low"),
            state["execution_mode"],
            only_agent=requested or None,
        )
        summary = f"生成包含 {len(plan)} 个步骤的执行计划"
        if requested and requested != "auto":
            # 说清这次是"按指定收敛"还是"指定没生效而回退"，别让用户以为选择被采纳了。
            if any(step["agent"] == requested for step in plan):
                summary = f"按指定 Agent（{requested}）收敛为 {len(plan)} 个步骤"
            else:
                summary = f"指定 Agent（{requested}）未启用，回退为自动组队：{len(plan)} 个步骤"
        return {
            "plan": plan,
            "phase": "dispatching",
            "completed_agents": [self.name],
            "agent_trace": [event(self.name, self.role, summary)],
        }


@dataclass(slots=True)
class ResearchAgent:
    tools: ToolRegistry
    reasoner: ReasoningProvider
    name: str = "research_agent"
    role: str = "研究与证据"

    async def run(self, state: GeneralTaskState) -> dict[str, object]:
        inputs, tool_audit = self.tools.invoke(
            "extract_research_inputs",
            self.name,
            {"objective": state["objective"], "context": state["context"]},
        )
        source_documents: list[dict[str, object]] = []
        source_audits: list[dict[str, object]] = []
        for url in inputs["urls"][:3]:
            document, source_audit = await asyncio.to_thread(
                self.tools.invoke, "fetch_public_url", self.name, {"url": url}
            )
            source_documents.append(document)
            source_audits.append(source_audit)
        reasoning = await self.reasoner.reason(
            ReasoningRequest(
                self.role,
                state["objective"],
                state["context"],
                {"inputs": inputs, "source_documents": source_documents},
            )
        )
        artifact = {
            "title": "研究框架",
            "objective": state["objective"],
            "questions": [
                "需要哪些事实才能支持最终结论？",
                "有哪些替代方案或反面证据？",
                "哪些结论必须由外部来源核验？",
            ],
            "evidence_requirements": ["一手来源", "发布日期", "可追溯引用"],
            "research_inputs": inputs,
            "source_documents": source_documents,
            "reasoning": reasoning,
            "note": (
                "已读取用户提供的公开来源。"
                if inputs["has_sources"]
                else "未提供来源链接；系统不会生成无法核验的外部事实。"
            ),
        }
        return {
            "phase": "researching",
            "completed_agents": [self.name],
            "artifacts": {self.name: artifact},
            "tool_trace": [tool_audit, *source_audits],
            "agent_trace": [event(self.name, self.role, "完成研究问题和证据要求拆解")],
        }


@dataclass(slots=True)
class DataAgent:
    tools: ToolRegistry
    reasoner: ReasoningProvider
    name: str = "data_agent"
    role: str = "数据分析"

    async def run(self, state: GeneralTaskState) -> dict[str, object]:
        analysis, tool_audit = self.tools.invoke(
            "analyze_csv", self.name, {"content": state["context"]}
        )
        reasoning = await self.reasoner.reason(
            ReasoningRequest(self.role, state["objective"], state["context"], analysis)
        )
        artifact = {
            "title": "数据分析方案",
            "objective": state["objective"],
            "workflow": ["校验数据结构", "处理缺失与异常", "计算核心指标", "复算关键结果"],
            "quality_checks": ["行数守恒", "单位一致", "聚合结果复算"],
            "analysis": analysis,
            "reasoning": reasoning,
            "note": (
                "已解析上下文中的 CSV 数据并计算统计摘要。"
                if analysis.get("detected")
                else "将 CSV 内容粘贴到任务背景后可执行实际统计。"
            ),
        }
        return {
            "phase": "analyzing",
            "completed_agents": [self.name],
            "artifacts": {self.name: artifact},
            "tool_trace": [tool_audit],
            "agent_trace": [event(self.name, self.role, "生成数据处理、指标和质量检查方案")],
        }


@dataclass(slots=True)
class CodeAgent:
    tools: ToolRegistry
    reasoner: ReasoningProvider
    name: str = "code_agent"
    role: str = "软件工程"

    async def run(self, state: GeneralTaskState) -> dict[str, object]:
        inventory, tool_audit = self.tools.invoke(
            "inspect_workspace", self.name, {"objective": state["objective"]}
        )
        reasoning = await self.reasoner.reason(
            ReasoningRequest(self.role, state["objective"], state["context"], inventory)
        )
        artifact = {
            "title": "工程实施方案",
            "objective": state["objective"],
            "workflow": ["定位相关代码", "确认约束", "最小化修改", "运行针对性测试"],
            "acceptance": ["类型检查通过", "相关测试通过", "改动可审查"],
            "workspace_inventory": inventory,
            "reasoning": reasoning,
            "note": "已完成工作区只读盘点；代码写入需要独立沙箱执行能力。",
        }
        return {
            "phase": "engineering",
            "completed_agents": [self.name],
            "artifacts": {self.name: artifact},
            "tool_trace": [tool_audit],
            "agent_trace": [event(self.name, self.role, "生成工程步骤和验收条件")],
        }


@dataclass(slots=True)
class DocumentAgent:
    reasoner: ReasoningProvider
    name: str = "document_agent"
    role: str = "交付物编排"

    async def run(self, state: GeneralTaskState) -> dict[str, object]:
        source_agents = list(state.get("artifacts", {}).keys())
        reasoning = await self.reasoner.reason(
            ReasoningRequest(
                self.role, state["objective"], state["context"], state.get("artifacts", {})
            )
        )
        artifact = {
            "title": "任务交付摘要",
            "objective": state["objective"],
            "source_artifacts": source_agents,
            "summary": "已完成任务拆解和专业处理，等待质量审查。",
            "limitations": ["规则模式不会虚构外部事实", "实际工具执行需要能力连接器"],
            "reasoning": reasoning,
        }
        return {
            "phase": "drafting",
            "completed_agents": [self.name],
            "artifacts": {self.name: artifact},
            "agent_trace": [event(self.name, self.role, "汇总专业 Agent 产物并形成交付摘要")],
        }


@dataclass(slots=True)
class ReviewAgent:
    reasoner: ReasoningProvider
    name: str = "review_agent"
    role: str = "独立质量审查"

    async def run(self, state: GeneralTaskState) -> dict[str, object]:
        artifacts = state.get("artifacts", {})
        has_document = "document_agent" in artifacts
        report = {
            "title": "质量门禁报告",
            "passed": has_document,
            "checks": {
                "objective_present": bool(state["objective"].strip()),
                "plan_present": bool(state.get("plan")),
                "deliverable_present": has_document,
            },
            "reasoning": await self.reasoner.reason(
                ReasoningRequest(self.role, state["objective"], state["context"], artifacts)
            ),
        }
        return {
            "phase": "reviewing",
            "completed_agents": [self.name],
            "artifacts": {self.name: report},
            "agent_trace": [
                event(
                    self.name,
                    self.role,
                    "质量门禁通过" if has_document else "质量门禁未通过",
                    status="completed" if has_document else "failed",
                )
            ],
        }


@dataclass(slots=True)
class ExecutionAgent:
    tools: ToolRegistry
    name: str = "execution_agent"
    role: str = "受控执行"

    async def run(self, state: GeneralTaskState) -> dict[str, object]:
        approval = state.get("approval", {})
        receipt, tool_audit = self.tools.invoke(
            "prepare_external_action",
            self.name,
            {
                "objective": state["objective"],
                "approval_id": approval.get("approval_id", ""),
                "approver_id": approval.get("approver_id", ""),
            },
        )
        artifact = {
            "title": "执行记录",
            **receipt,
            "approved_by": approval.get("approver_id"),
            "note": "尚未绑定外部写工具，因此仅记录已批准的模拟执行。",
        }
        return {
            "phase": "executing",
            "completed_agents": [self.name],
            "artifacts": {self.name: artifact},
            "tool_trace": [tool_audit],
            "agent_trace": [event(self.name, self.role, "完成已批准动作的模拟执行")],
        }


@dataclass(slots=True)
class VerificationAgent:
    name: str = "verification_agent"
    role: str = "结果核验"

    async def run(self, state: GeneralTaskState) -> dict[str, object]:
        execution = state.get("artifacts", {}).get("execution_agent", {})
        verified = isinstance(execution, dict) and execution.get("status") == "simulated"
        artifact = {
            "title": "执行核验",
            "verified": verified,
            "method": "读取执行记录并检查审批主体",
        }
        return {
            "phase": "verifying",
            "completed_agents": [self.name],
            "artifacts": {self.name: artifact},
            "agent_trace": [event(self.name, self.role, "执行记录核验通过")],
        }


@dataclass(slots=True)
class GeneralSupervisorAgent:
    name: str = "supervisor_agent"
    role: str = "任务监督"

    def dispatch(self, state: GeneralTaskState) -> dict[str, object]:
        if state.get("status") == "rejected":
            return {"next_agent": "end"}
        if state["execution_mode"] == "plan_only" and "planner_agent" in state["completed_agents"]:
            return self._finish(state, "planned", "计划已生成，未执行专业步骤。")
        completed = set(state.get("completed_agents", []))
        for step in state.get("plan", []):
            agent = str(step["agent"])
            if agent not in completed:
                if state["dispatch_count"] >= state["max_steps"]:
                    return self._finish(
                        state, "needs_human", "任务达到最大步骤数，已停止自动执行。"
                    )
                return {
                    "next_agent": agent,
                    "dispatch_count": state["dispatch_count"] + 1,
                    "agent_trace": [
                        event(
                            self.name,
                            self.role,
                            f"选择下一步骤：{step['title']}",
                            handoff=agent,
                        )
                    ],
                }
        return self._finish(state, "completed", "任务计划已完成并通过质量门禁。")

    def _finish(
        self, state: GeneralTaskState, status: str, message: str
    ) -> dict[str, object]:
        return {
            "next_agent": "end",
            "status": status,
            "phase": status,
            "final_response": message,
            "agent_trace": [event(self.name, self.role, message, handoff="end")],
        }
