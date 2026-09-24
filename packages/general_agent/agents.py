import re
from dataclasses import dataclass
from typing import Literal

from packages.general_agent.capabilities import CapabilityRegistry
from packages.general_agent.mcp_client import build_arguments
from packages.general_agent.reasoning import ReasoningProvider, ReasoningRequest
from packages.general_agent.state import GeneralAgentEvent, GeneralTaskState
from packages.general_agent.tools import ToolRegistry

TaskType = Literal["chat", "research", "data", "code", "document", "general"]


# 汇总最终回复时，一个步骤的产出里哪些字段算"可读结论"：按信息量从高到低取第一个命中的。
DIGEST_TEXT_KEYS = ("summary", "note", "conclusion")
MAX_DIGEST_CHARS = 160


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

    # 寒暄、致谢、应答、能力询问这类输入：直接回答就够了，没必要组队跑一遍流水线。
    # 这份表不可能穷尽（"不客气""thank you"都曾漏在外面，于是被当成 general 任务，
    # 套上研究流程后吐出"研究框架/质量门禁"这种空壳结论 —— 就是用户说的"答非所问"），
    # 所以 _is_chat 里还有一条"很短且没有任务动词"的兜底规则。
    CHAT_PATTERNS = (
        "你好", "您好", "嗨", "hi", "hello", "在吗", "早上好", "下午好", "晚上好", "晚安",
        "谢谢", "感谢", "辛苦了", "多谢", "不客气", "别客气", "客气", "没事", "没关系",
        "再见", "拜拜", "bye", "感谢你",
        "你是谁", "你能做什么", "你会什么", "能做什么", "自我介绍", "你是什么",
        "好的", "好嘞", "收到", "明白", "了解", "嗯", "行", "ok", "okay",
        "thanks", "thank", "yes", "no", "哈哈", "嗯嗯",
    )
    # 出现这些词就说明真有活儿要干，不能当闲聊（例如"你好，帮我分析这份数据"）。
    TASK_VERBS = (
        "分析", "研究", "调研", "比较", "对比", "生成", "写", "整理", "查", "找", "翻译",
        "总结", "计算", "统计", "转换", "修复", "开发", "设计", "评估", "审查", "报告",
        "报表", "表格", "清单", "汇总", "方案", "计划", "文档", "代码", "数据", "csv",
        "excel", "文件", "接口", "部署", "发布", "删除", "写入", "帮我", "请帮", "给我",
        "发送", "邮件", "创建", "新建", "提交", "上传", "下载", "抓取", "爬",
    )
    CHAT_MAX_CHARS = 24
    # 去掉标点后只剩很短几个字、又没有任务动词时，按闲聊处理而不是硬套流程。
    CHAT_REPLY_MAX_CHARS = 6

    @classmethod
    def _is_chat(cls, objective: str) -> bool:
        """只在"确实没什么可做"时才判为闲聊：太长、或带任务动词的一律照常处理。"""
        text = objective.strip().lower()
        # 先去掉空白与标点，"好的！""嗯……" 也要认出来
        bare = re.sub(r"[\s\W_]+", "", text)
        if not bare or len(text) > cls.CHAT_MAX_CHARS:
            return False
        if any(verb in text for verb in cls.TASK_VERBS):
            return False
        if any(pattern in text for pattern in cls.CHAT_PATTERNS):
            return True
        # 兜底：很短又没有任务动词（"好嘞""嗯嗯""3q"），当闲聊直接回，比空跑一遍流水线好
        return len(bare) <= cls.CHAT_REPLY_MAX_CHARS

    @classmethod
    def _classify(cls, objective: str) -> TaskType:
        if cls._is_chat(objective):
            return "chat"
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
            "chat": "闲聊",
        }[task_type]


@dataclass(slots=True)
class PlannerAgent:
    registry: CapabilityRegistry
    name: str = "planner_agent"
    role: str = "任务规划"

    async def run(self, state: GeneralTaskState) -> dict[str, object]:
        # ReAct 模式：不预先排好团队，把整轮交给自由循环节点。
        if state.get("run_mode") == "react":
            return {
                "plan": [
                    {"id": "step-1", "agent": "react_agent", "title": "自由推理与工具调用"}
                ],
                "phase": "dispatching",
                "completed_agents": [self.name],
                "agent_trace": [
                    event(self.name, self.role, "按 ReAct 模式生成单步自由循环计划")
                ],
            }
        task_type = state.get("task_type", "general")
        requested = state.get("requested_agent") or ""
        # 带写入目标就走执行链：真写要过审批门禁，演练只走执行与核验。
        has_target = bool(state.get("execution_target"))
        dry_run = bool(state.get("dry_run", False))
        plan = self.registry.plan_for(
            task_type,
            state.get("risk_level", "low"),
            state["execution_mode"],
            only_agent=requested or None,
            write_target=has_target,
            dry_run=dry_run,
        )
        summary = f"生成包含 {len(plan)} 个步骤的执行计划"
        if task_type == "chat":
            summary = "识别为闲聊/简单问题，直接回答，不组建团队"
        elif has_target and not dry_run:
            summary += "（含真实写入，已追加审批门禁）"
        elif has_target and dry_run:
            summary += "（演练：走执行与核验，不产生副作用）"
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
        inputs, tool_audit = await self.tools.ainvoke(
            "extract_research_inputs",
            self.name,
            {"objective": state["objective"], "context": state["context"]},
        )
        source_documents: list[dict[str, object]] = []
        source_audits: list[dict[str, object]] = []
        for url in inputs["urls"][:3]:
            document, source_audit = await self.tools.ainvoke(
                "fetch_public_url", self.name, {"url": url}
            )
            source_documents.append(document)
            source_audits.append(source_audit)
        # 已接入的 MCP 只读工具也是证据来源：接了就要真的用，不能只躺在列表里。
        mcp_results, mcp_audits = await self._call_mcp_tools(state["objective"])
        reasoning = await self.reasoner.reason(
            ReasoningRequest(
                self.role,
                state["objective"],
                state["context"],
                {
                    "inputs": inputs,
                    "source_documents": source_documents,
                    "mcp_results": mcp_results,
                },
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
            "mcp_results": mcp_results,
            "reasoning": reasoning,
            "note": (
                "已读取用户提供的公开来源。"
                if inputs["has_sources"]
                else "未提供来源链接；系统不会生成无法核验的外部事实。"
            ),
        }
        if mcp_results:
            suffix = f"已调用 {len(mcp_results)} 个 MCP 只读工具获取证据。"
            artifact["note"] = f"{artifact['note']}{suffix}"
        return {
            "phase": "researching",
            "completed_agents": [self.name],
            "artifacts": {self.name: artifact},
            "tool_trace": [tool_audit, *source_audits, *mcp_audits],
            "agent_trace": [
                event(
                    self.name,
                    self.role,
                    "完成研究问题和证据要求拆解"
                    + (f"，并调用 {len(mcp_results)} 个 MCP 工具" if mcp_results else ""),
                )
            ],
        }

    async def _call_mcp_tools(
        self, objective: str
    ) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
        """调用授权给本 Agent 的 MCP 只读工具。

        入参按 inputSchema 构造；构造不出来就跳过，不做"瞎猜参数去调用"这种事。
        调用失败也照常记录审计，由上层决定是否影响结论。
        """
        candidates = [
            item
            for item in self.tools.definitions()
            if item.get("source") == "mcp" and item.get("access") == "read"
        ]
        results: list[dict[str, object]] = []
        audits: list[dict[str, object]] = []
        for tool in candidates[:3]:
            schema = tool.get("input_schema")
            arguments, reason = build_arguments(
                schema if isinstance(schema, dict) else {}, objective
            )
            if arguments is None:
                continue
            result, audit = await self.tools.ainvoke(str(tool["name"]), self.name, arguments)
            if isinstance(result, dict) and "error" not in result:
                results.append({**result, "tool": str(tool["name"]), "note": reason})
            audits.append(audit)
        return results, audits


@dataclass(slots=True)
class DataAgent:
    tools: ToolRegistry
    reasoner: ReasoningProvider
    name: str = "data_agent"
    role: str = "数据分析"

    async def run(self, state: GeneralTaskState) -> dict[str, object]:
        analysis, tool_audit = await self.tools.ainvoke(
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
        inventory, tool_audit = await self.tools.ainvoke(
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
class DirectReplyAgent:
    """闲聊与简单到不需要协作的问题，直接给一句有用的回答。

    这类输入以前也会被组队跑一遍（研究 → 文档 → 审查），最后收到"计划已完成"这种状态
    播报 —— 慢，而且答非所问。现在识别为 chat 后只走这一步。

    规则模式下回复是模板化的，但至少对得上输入；接上大模型后这里换成真正的生成即可。
    """

    name: str = "direct_agent"
    role: str = "直接回答"

    GREETING = ("你好", "您好", "嗨", "hi", "hello", "在吗", "早上好", "下午好", "晚上好")
    THANKS = ("谢谢", "感谢", "辛苦了", "多谢")
    FAREWELL = ("再见", "拜拜", "88")
    CAPABILITY = ("你是谁", "你能做什么", "你会什么", "能做什么", "自我介绍", "你是什么")

    async def run(self, state: GeneralTaskState) -> dict[str, object]:
        objective = state["objective"].strip()
        kind = self._kind(objective)
        reply = self._reply(kind)
        artifact = {
            "title": "直接回答",
            "objective": objective,
            "kind": kind,
            "summary": reply,
            "note": reply,
        }
        return {
            "phase": "responding",
            "completed_agents": [self.name],
            "artifacts": {self.name: artifact},
            "agent_trace": [event(self.name, self.role, "直接回答，未组建团队")],
        }

    @classmethod
    def _kind(cls, objective: str) -> str:
        text = objective.lower()
        if any(word in text for word in cls.CAPABILITY):
            return "capability"
        if any(word in text for word in cls.THANKS):
            return "thanks"
        if any(word in text for word in cls.FAREWELL):
            return "farewell"
        return "greeting"

    @staticmethod
    def _reply(kind: str) -> str:
        if kind == "capability":
            return (
                "我是 Neptune 工作台。把目标说清楚就行，我会先判断任务类型和风险，再从能力注册表里"
                "挑出合适的 Agent 组队 —— 研究取证、数据分析、软件工程、文档交付、质量审查。"
                "涉及真实写入的任务会先停下来等你审批，批准后才执行并回查结果。"
            )
        if kind == "thanks":
            return "不客气。还有别的目标就继续说吧，我会按同样的方式处理。"
        if kind == "farewell":
            return "好的，随时回来。运行记录和每个步骤都留在工作台里，需要时直接翻。"
        return (
            "你好。直接说目标就行 —— 比如「分析这份 CSV 的销售数据」"
            "「比较三个技术选型并给建议」。我会先理解任务和风险，再挑合适的 Agent 组队；"
            "涉及真实写入的会先让你确认。"
        )


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
        target = state.get("execution_target") or {}
        dry_run = bool(state.get("dry_run", False))
        # 只有"给了写入目标且不是 dry_run"才真写；其余情况如实给执行计划。
        will_write = bool(target) and not dry_run
        if will_write:
            receipt, tool_audit = await self.tools.ainvoke(
                "execute_external_write",
                self.name,
                {**target, "dry_run": False},
            )
            mode = "execute"
        else:
            receipt, tool_audit = await self.tools.ainvoke(
                "prepare_external_action",
                self.name,
                {
                    "objective": state["objective"],
                    "approval_id": approval.get("approval_id", ""),
                    "approver_id": approval.get("approver_id", ""),
                },
            )
            mode = "simulate"
        succeeded = bool(receipt.get("ok"))
        # 演练也要说清"会写到哪里"，否则用户看不出自己在演练什么。
        target_hint = str(
            target.get("path") or target.get("url") or target.get("table") or ""
        )
        if will_write and succeeded:
            note = "已按批准结果执行真实写入。"
        elif will_write:
            note = "真实写入失败，回执中保留了错误原因。"
        elif dry_run and target:
            note = "演练：已生成写入计划并模拟执行，未产生任何副作用。"
        else:
            note = "本次没有真实写入目标，仅生成已审批动作的执行计划。"
        artifact = {
            "title": "执行记录",
            "mode": mode,
            "target": receipt.get("target") or target_hint,
            "ok": succeeded,
            "receipt": receipt,
            "approved_by": approval.get("approver_id"),
            "note": note,
        }
        summary = (
            f"完成真实写入：{receipt.get('target', '')}"
            if will_write and succeeded
            else f"真实写入失败：{receipt.get('error', '未知原因')}"
            if will_write
            else "生成已审批动作的执行计划（无写入目标，未产生副作用）"
        )
        return {
            "phase": "executing",
            "completed_agents": [self.name],
            "artifacts": {self.name: artifact},
            "tool_trace": [tool_audit],
            "agent_trace": [
                event(
                    self.name,
                    self.role,
                    summary,
                    status="completed" if (not will_write or succeeded) else "failed",
                )
            ],
        }


@dataclass(slots=True)
class VerificationAgent:
    name: str = "verification_agent"
    role: str = "结果核验"

    async def run(self, state: GeneralTaskState) -> dict[str, object]:
        execution = state.get("artifacts", {}).get("execution_agent", {})
        record = execution if isinstance(execution, dict) else {}
        expected = (
            "execute"
            if state.get("execution_target") and not state.get("dry_run", False)
            else "simulate"
        )
        mode_ok = record.get("mode") == expected
        write_ok = expected == "simulate" or record.get("ok") is True
        verified = mode_ok and write_ok
        artifact = {
            "title": "执行核验",
            "verified": verified,
            "expected_mode": expected,
            "actual_mode": record.get("mode", ""),
            "method": "读取执行回执，核对写入模式与写入结果",
            "error": "" if write_ok else str(record.get("error", "执行回执缺少成功标记")),
        }
        return {
            "phase": "verifying",
            "completed_agents": [self.name],
            "artifacts": {self.name: artifact},
            "agent_trace": [
                event(
                    self.name,
                    self.role,
                    "执行记录核验通过" if verified else "执行记录核验未通过",
                    status="completed" if verified else "failed",
                )
            ],
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
        return self._finish(state, "completed", self._summarize(state))

    @staticmethod
    def _clip(text: str) -> str:
        flat = " ".join(text.split())
        if len(flat) <= MAX_DIGEST_CHARS:
            return flat
        return f"{flat[: MAX_DIGEST_CHARS - 1]}…"

    def _digest(self, artifact: dict[str, object]) -> str:
        """把一份产物压成一句话：先看结构化判定（模式/核验/门禁），再看人话摘要。

        顺序是有意的：执行步骤的 `mode` 比它的措辞更可靠 —— 演练和执行都会被写成
        "已完成"，但两者对用户的意义完全不同。
        """
        mode = str(artifact.get("mode") or "")
        if mode == "execute":
            return "已按写入目标真实执行"
        if mode == "simulate":
            return "演练模式：未产生任何副作用"
        if "verified" in artifact:
            if artifact.get("verified"):
                return "核验通过"
            reason = str(artifact.get("error") or "").strip()
            return f"核验未通过：{reason}" if reason else "核验未通过"
        if "passed" in artifact:
            return "质量门禁通过" if artifact.get("passed") else "质量门禁未通过"
        for key in DIGEST_TEXT_KEYS:
            value = artifact.get(key)
            if isinstance(value, str) and value.strip():
                return self._clip(value.strip())
        reasoning = artifact.get("reasoning")
        if isinstance(reasoning, str) and reasoning.strip():
            return self._clip(reasoning.strip())
        return ""

    def _summarize(self, state: GeneralTaskState) -> str:
        """把各步骤的真实产出汇总成一段结论。

        以前这里写死一句「任务计划已完成并通过质量门禁」—— 它对任何输入都一模一样，
        等于没有回答（输入"你好啊"也会收到这句）。现在按计划顺序收集每个步骤的产出摘要，
        让回复说出"做完了什么"，而不只是"做完了"。
        """
        artifacts = state.get("artifacts", {})
        completed = set(state.get("completed_agents", []))
        entries: list[tuple[str, str]] = []
        covered: set[str] = set()

        def collect(agent: str, label: str, artifact: object) -> None:
            if not isinstance(artifact, dict):
                return
            digest = self._digest(artifact)
            if digest:
                entries.append((str(artifact.get("title") or label), digest))

        for step in state.get("plan", []):
            agent = str(step.get("agent", ""))
            if not agent or agent in covered or agent not in completed:
                continue
            covered.add(agent)
            collect(agent, str(step.get("title") or agent), artifacts.get(agent))
        # ReAct 这类不在计划里的产出也要露面，否则"跑过了但没提"同样让人困惑。
        for agent, artifact in artifacts.items():
            if agent in covered or agent not in completed:
                continue
            collect(agent, agent, artifact)

        if not entries:
            return "任务已完成。各步骤没有产出可总结的文字结论，完整记录见步骤页。"
        if len(entries) == 1:
            # 只做了一件事（例如闲聊直接回答）就别套"· 标题："的壳，直接说话。
            return entries[0][1]
        header = "任务已完成。"
        return f"{header}\n" + "\n".join(f"· {label}：{digest}" for label, digest in entries)

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
