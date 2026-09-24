export type Trace = { agent: string; role: string; status: string; summary: string; handoff?: string | null };
export type Step = { id: string; agent: string; title: string };
export type Knowledge = {
  enabled?: boolean;
  bases?: string[];
  available?: number;
  // 向量检索会回传扫描篇数与检索方式，用于如实说明"这次用了什么"
  scanned?: number;
  mode?: string;
  embedding?: string;
  documents?: Array<{ base: string; name: string; score?: number }>;
};
export type Task = {
  task_id: string;
  objective: string;
  context: string;
  execution_mode: string;
  status: string;
  phase: string;
  conversation_id?: string | null;
  requested_agent?: string | null;
  // 真实写入目标 / 演练开关 / 编排方式（固定图 or 自由 ReAct）
  execution_target?: Record<string, unknown> | null;
  dry_run?: boolean;
  run_mode?: string;
  knowledge?: Knowledge;
  task_type?: string | null;
  risk_level?: string | null;
  plan: Step[];
  completed_agents: string[];
  artifacts: Record<string, Record<string, unknown>>;
  agent_trace: Trace[];
  tool_trace: Array<{ tool: string; agent: string; access: string; status: string; summary: string }>;
  final_response?: string | null;
  updated_at?: string | null;
};

/* 「运行 Agent」下拉里的 auto 之外都是能力注册表里的 agent id。 */
export const AUTO_AGENT = "auto";

/* 把后端回报的检索结果翻成一句人话：既要说清命中，也要能区分
   "没开启" / "知识库是空的" / "有文档但没命中" 三种不同情况。 */
export function knowledgeSummary(knowledge?: Knowledge): string {
  if (!knowledge?.enabled) return "未开启知识库检索";
  if (!(knowledge.bases?.length ?? 0)) return "没有启用的知识库";
  const documents = knowledge.documents ?? [];
  if (documents.length) {
    const names = documents.map((item) => item.name).join("、");
    return `命中 ${documents.length} 篇：${names}（${retrievalModeText(knowledge)}）`;
  }
  return (knowledge.available ?? 0) > 0
    ? `已扫描 ${knowledge.available} 篇，本次无命中（${retrievalModeText(knowledge)}）`
    : "知识库暂无文档";
}

/* 检索方式必须说清楚：向量检索和"向量没命中后回退关键词"是两回事。 */
export function retrievalModeText(knowledge?: Knowledge): string {
  if (!knowledge) return "";
  if (knowledge.mode === "vector") {
    return `向量检索 · ${knowledge.embedding || "本地向量"}`;
  }
  if (knowledge.mode === "keyword") {
    return knowledge.embedding || "关键词检索";
  }
  return "";
}

/* Labels mirror the role strings the backend writes into agent_trace, so the
   plan, the collaboration trace and the deliverables all read consistently. */
export const agentLabels: Record<string, string> = {
  intake_agent: "任务理解",
  planner_agent: "任务规划",
  supervisor_agent: "任务监督",
  research_agent: "研究与证据",
  data_agent: "数据分析",
  code_agent: "软件工程",
  document_agent: "交付物编排",
  review_agent: "独立质量审查",
  approval_gate: "人工审批",
  execution_agent: "受控执行",
  verification_agent: "结果核验",
};

export const terminal = new Set(["completed", "planned", "rejected", "needs_human"]);

export const statusMeta: Record<string, { label: string; tone: string }> = {
  running: { label: "运行中", tone: "running" },
  completed: { label: "已完成", tone: "done" },
  planned: { label: "计划就绪", tone: "planned" },
  awaiting_approval: { label: "待审批", tone: "approval" },
  rejected: { label: "已拒绝", tone: "blocked" },
  needs_human: { label: "需人工", tone: "blocked" },
};

export type TaskStatus = "all" | "running" | "awaiting_approval" | "completed" | "blocked";

export const statusFilters: Array<{ id: TaskStatus; label: string }> = [
  { id: "all", label: "全部" },
  { id: "running", label: "运行中" },
  { id: "awaiting_approval", label: "待审批" },
  { id: "completed", label: "已完成" },
  { id: "blocked", label: "已阻塞" },
];

export function statusText(status: string) {
  return statusMeta[status]?.label ?? status;
}

export function statusTone(status: string) {
  return statusMeta[status]?.tone ?? "planned";
}

export function typeText(type?: string | null) {
  return ({ chat: "闲聊直答", research: "研究任务", data: "数据任务", code: "软件工程", document: "文档任务", general: "通用任务" } as Record<string, string>)[type ?? ""] ?? "识别中";
}

export function riskText(risk?: string | null) {
  return ({ low: "低风险", medium: "中风险", high: "高风险" } as Record<string, string>)[risk ?? ""] ?? "待评估";
}

export function matchesStatusFilter(task: Task, filter: TaskStatus) {
  if (filter === "all") return true;
  if (filter === "blocked") return task.status === "rejected" || task.status === "needs_human";
  return task.status === filter;
}

export function taskProgress(task: Task) {
  const total = task.plan.length;
  if (!total) return { done: 0, total: 0, percent: 0 };
  const done = task.plan.filter((step) => task.completed_agents.includes(step.agent)).length;
  return { done, total, percent: Math.min(100, Math.round((done / total) * 100)) };
}

/* ---------------------------------------------------------------------------
   Flow model: the five stages a task travels through, derived from real backend
   data (phase + status + plan / agent_trace / artifacts). The whole runtime page
   is built on this so "where are we, what is done, what is left" is always
   answerable at a glance, with no fabricated progress. */

export type StageState = "pending" | "active" | "done";

export type Stage = {
  key: "objective" | "planning" | "schedule" | "collaboration" | "deliverables";
  index: number;
  name: string;
  owner: string;
  state: StageState;
  summary: string;
};

export type StageKey = Stage["key"];

/* Tab filter for the stage switcher: "all" or a single stage key. */
export type StageFilter = "all" | StageKey;

export const stageFilters: StageFilter[] = [
  "all",
  "objective",
  "planning",
  "schedule",
  "collaboration",
  "deliverables",
];

export const stageStateText: Record<StageState, string> = {
  pending: "待开始",
  active: "进行中",
  done: "已完成",
};

/* Backend phase → stage index. Every worker phase lives inside "Agent 协作". */
const phaseStage: Record<string, number> = {
  intake: 0,
  planning: 1,
  dispatching: 2,
  researching: 3,
  analyzing: 3,
  engineering: 3,
  drafting: 3,
  reviewing: 3,
  approval: 3,
  executing: 3,
  verifying: 3,
  reacting: 3,
  responding: 3,
};

/* 阶段的展示文案：直接对应后端 phase 取值，不另造词，
   这样"界面现在停在哪一步"与流水线真相是同一个东西。 */
const phaseLabels: Record<string, string> = {
  intake: "任务理解",
  planning: "任务规划",
  dispatching: "分派调度",
  researching: "研究取证",
  analyzing: "数据分析",
  engineering: "软件工程",
  drafting: "交付物编排",
  reviewing: "质量审查",
  approval: "等待人工审批",
  executing: "真实执行",
  verifying: "结果核验",
  reacting: "自由 ReAct 循环",
  responding: "直接回答",
  completed: "已完成",
  planned: "已生成计划",
  rejected: "已拒绝",
  needs_human: "需人工介入",
  timeout: "超时停止",
  failed: "执行失败",
};

export function phaseText(phase?: string | null): string {
  if (!phase) return "未知阶段";
  return phaseLabels[phase] ?? phase;
}

export function deriveStages(task: Task): Stage[] {
  const progress = taskProgress(task);
  const teamSize = new Set(task.plan.map((step) => step.agent)).size;
  const artifactCount = Object.keys(task.artifacts).length;

  const defs: Array<Omit<Stage, "state">> = [
    {
      key: "objective",
      index: 1,
      name: "任务目标",
      owner: "任务理解",
      summary: `${typeText(task.task_type)} · ${riskText(task.risk_level)}`,
    },
    {
      key: "planning",
      index: 2,
      name: "任务规划",
      owner: "任务规划",
      summary: task.plan.length ? `${teamSize} 个 Agent 参与` : "等待 Planner 组建团队",
    },
    {
      key: "schedule",
      index: 3,
      name: "执行计划",
      owner: "任务监督",
      summary: task.plan.length ? `${task.plan.length} 个步骤已编排` : "等待计划生成",
    },
    {
      key: "collaboration",
      index: 4,
      name: "Agent 协作",
      owner: "专业 Agent",
      summary: task.agent_trace.length
        ? `${progress.total ? `${progress.done}/${progress.total} 步 · ` : ""}${task.agent_trace.length} 条协作`
        : "等待 Agent 开始协作",
    },
    {
      key: "deliverables",
      index: 5,
      name: "交付物",
      owner: "交付物编排",
      summary: artifactCount ? `${artifactCount} 份结构化交付物` : "等待产物生成",
    },
  ];

  // Terminal statuses end the flow early; otherwise the live phase decides.
  let doneThrough = -1;
  let activeIndex = -1;
  if (task.status === "completed") {
    doneThrough = defs.length - 1;
  } else if (task.status === "planned") {
    doneThrough = 2; // objective + planning + schedule (plan generated, not executed)
  } else if (task.status === "rejected") {
    doneThrough = 3; // stopped at the approval gate inside collaboration
  } else {
    const index = phaseStage[task.phase] ?? 3;
    doneThrough = index - 1;
    activeIndex = index;
  }

  const stages: Stage[] = defs.map((def, i) => ({
    ...def,
    state: (i <= doneThrough ? "done" : i === activeIndex ? "active" : "pending") as StageState,
  }));

  // Deliverables reflect the artifacts themselves, so an artifact produced mid-run
  // reads as in-progress instead of contradicting a "waiting" badge.
  const deliverables = stages[stages.length - 1];
  if (task.status === "completed") {
    deliverables.state = "done";
  } else if ((task.status === "running" || task.status === "awaiting_approval") && artifactCount > 0) {
    deliverables.state = "active";
  }

  return stages;
}

export function currentStage(stages: Stage[]): Stage | undefined {
  return stages.find((stage) => stage.state === "active");
}

export function formatUpdatedAt(value?: string | null) {
  if (!value) return "刚刚";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const diff = Date.now() - date.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

export function artifactSummary(value: Record<string, unknown>) {
  if (typeof value.summary === "string") return value.summary;
  if (typeof value.note === "string") return value.note;
  if (typeof value.passed === "boolean") return value.passed ? "所有质量检查均已通过。" : "存在未通过的质量检查。";
  if (typeof value.verified === "boolean") return value.verified ? "执行结果已经核验。" : "执行结果尚未确认。";
  return "结构化产物已生成，可通过 API 查看完整内容。";
}
