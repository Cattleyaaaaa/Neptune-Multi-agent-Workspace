"use client";

/* Structured sample data for the workbench pages that have no backend table yet
   (定时任务 / 工作流 / MCP / Skill / 附件 / 租户 / 可观测性 / Token 用量).

   Timestamps are fixed ISO strings on purpose: these seeds render on the first
   paint, so anything derived from `Date.now()` would produce different markup
   on the server and the client and trip React's hydration check. Relative
   labels are only produced from user actions, never during render. */

/* ------------------------------------------------------------------ 定时任务 */

export type RunStatus = "success" | "failed" | "running" | "skipped" | "never";

export type Schedule = {
  id: string;
  name: string;
  objective: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  mode: "auto" | "plan_only";
  riskLevel: "low" | "medium" | "high";
  notify: "none" | "on_failure" | "always";
  lastRunAt: string | null;
  lastStatus: RunStatus;
  nextRunAt: string | null;
  runCount: number;
  failureCount: number;
  owner: string;
  createdAt: string;
};

export const scheduleSeeds: Schedule[] = [
  {
    id: "sch-daily-brief",
    name: "每日行业简报",
    objective: "汇总过去 24 小时行业动态，产出带来源的简报草稿并标注待核实项。",
    cron: "0 9 * * *",
    timezone: "Asia/Shanghai",
    enabled: true,
    mode: "auto",
    riskLevel: "low",
    notify: "on_failure",
    lastRunAt: "2026-09-18T09:00:00+08:00",
    lastStatus: "success",
    nextRunAt: "2026-09-19T09:00:00+08:00",
    runCount: 42,
    failureCount: 1,
    owner: "陈立",
    createdAt: "2026-07-02T10:20:00+08:00",
  },
  {
    id: "sch-weekly-quality",
    name: "周度交付质量巡检",
    objective: "抽查本周交付物，按质量门禁逐项打分并输出问题清单。",
    cron: "0 10 * * 1",
    timezone: "Asia/Shanghai",
    enabled: true,
    mode: "plan_only",
    riskLevel: "low",
    notify: "always",
    lastRunAt: "2026-09-14T10:00:00+08:00",
    lastStatus: "success",
    nextRunAt: "2026-09-21T10:00:00+08:00",
    runCount: 11,
    failureCount: 0,
    owner: "陈立",
    createdAt: "2026-07-05T14:05:00+08:00",
  },
  {
    id: "sch-csv-refresh",
    name: "经营数据入库",
    objective: "解析每日导出的经营 CSV，计算核心指标并回写汇总表。",
    cron: "30 2 * * *",
    timezone: "Asia/Shanghai",
    enabled: false,
    mode: "auto",
    riskLevel: "medium",
    notify: "on_failure",
    lastRunAt: "2026-09-17T02:30:00+08:00",
    lastStatus: "failed",
    nextRunAt: null,
    runCount: 68,
    failureCount: 4,
    owner: "李楠",
    createdAt: "2026-05-18T09:41:00+08:00",
  },
  {
    id: "sch-release-check",
    name: "发布前合规检查",
    objective: "检索发布说明与合规清单，逐条比对并给出阻断项。",
    cron: "0 */6 * * *",
    timezone: "Asia/Shanghai",
    enabled: true,
    mode: "auto",
    riskLevel: "high",
    notify: "always",
    lastRunAt: "2026-09-18T12:00:00+08:00",
    lastStatus: "running",
    nextRunAt: "2026-09-18T18:00:00+08:00",
    runCount: 25,
    failureCount: 2,
    owner: "王砚",
    createdAt: "2026-08-01T16:12:00+08:00",
  },
  {
    id: "sch-code-inventory",
    name: "代码库只读盘点",
    objective: "盘点仓库结构、依赖与待办，输出变更影响面清单。",
    cron: "0 20 * * 5",
    timezone: "Asia/Shanghai",
    enabled: false,
    mode: "plan_only",
    riskLevel: "low",
    notify: "none",
    lastRunAt: null,
    lastStatus: "never",
    nextRunAt: null,
    runCount: 0,
    failureCount: 0,
    owner: "李楠",
    createdAt: "2026-09-12T11:30:00+08:00",
  },
  {
    id: "sch-token-report",
    name: "月度用量结算",
    objective: "汇总当月 Token 消耗与成本，生成结算报表并附异常明细。",
    cron: "0 8 1 * *",
    timezone: "Asia/Shanghai",
    enabled: true,
    mode: "auto",
    riskLevel: "low",
    notify: "always",
    lastRunAt: "2026-09-01T08:00:00+08:00",
    lastStatus: "success",
    nextRunAt: "2026-10-01T08:00:00+08:00",
    runCount: 3,
    failureCount: 0,
    owner: "王砚",
    createdAt: "2026-06-28T15:00:00+08:00",
  },
];

export const cronOptions = [
  { value: "*/15 * * * *", label: "每 15 分钟" },
  { value: "0 * * * *", label: "每小时" },
  { value: "0 9 * * *", label: "每天 09:00" },
  { value: "30 2 * * *", label: "每天 02:30" },
  { value: "0 */6 * * *", label: "每 6 小时" },
  { value: "0 10 * * 1", label: "每周一 10:00" },
  { value: "0 20 * * 5", label: "每周五 20:00" },
  { value: "0 8 1 * *", label: "每月 1 日 08:00" },
];

export const cronLabels: Record<string, string> = Object.fromEntries(
  cronOptions.map((option) => [option.value, option.label]),
);

/* Minimal cron → next-run calculation for the presets above. Runs only from
   user actions, so Date.now() is safe here. */
export function nextRunFromCron(cron: string, from = new Date()): string | null {
  const next = new Date(from.getTime());
  next.setSeconds(0, 0);
  const [minute = "0", hour = "0", , , , weekday] = cron.split(" ");
  const step = minute.startsWith("*/") ? Number(minute.slice(2)) : null;

  if (step) {
    next.setMinutes(Math.ceil((next.getMinutes() + 1) / step) * step);
    if (next.getMinutes() >= 60) { next.setMinutes(0); next.setHours(next.getHours() + 1); }
    return next.toISOString();
  }
  if (cron === "0 */6 * * *") {
    const target = [0, 6, 12, 18].find((value) => value > next.getHours()) ?? 0;
    if (target <= next.getHours()) next.setDate(next.getDate() + 1);
    next.setHours(target, 0, 0, 0);
    return next.toISOString();
  }
  if (weekday) {
    const target = Number(weekday);
    const delta = (target - next.getDay() + 7) % 7 || 7;
    next.setDate(next.getDate() + delta);
    next.setHours(Number(hour), Number(minute), 0, 0);
    return next.toISOString();
  }
  next.setHours(Number(hour), Number(minute), 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

/* --------------------------------------------------------------- 工作流编排 */

export type WorkflowNodeKind = "trigger" | "agent" | "tool" | "gate" | "verify" | "output";

export type WorkflowNode = {
  id: string;
  kind: WorkflowNodeKind;
  title: string;
  agent?: string;
  note: string;
};

export type Workflow = {
  id: string;
  name: string;
  description: string;
  status: "draft" | "published" | "archived";
  trigger: "manual" | "schedule" | "api";
  nodes: WorkflowNode[];
  version: string;
  updatedAt: string;
  owner: string;
  runCount: number;
  successRate: number;
  tags: string[];
};

export const nodeKindLabels: Record<WorkflowNodeKind, string> = {
  trigger: "触发",
  agent: "Agent",
  tool: "工具",
  gate: "人工门禁",
  verify: "核验",
  output: "交付",
};

export const workflowSeeds: Workflow[] = [
  {
    id: "wf-research-brief",
    name: "研究简报流水线",
    description: "从公开来源检索证据，经独立审查后编排为带引用的简报。",
    status: "published",
    trigger: "schedule",
    version: "v1.4.0",
    updatedAt: "2026-09-16T15:42:00+08:00",
    owner: "陈立",
    runCount: 128,
    successRate: 96,
    tags: ["研究", "文档"],
    nodes: [
      { id: "n1", kind: "trigger", title: "定时触发", note: "每天 09:00 · Asia/Shanghai" },
      { id: "n2", kind: "agent", title: "任务理解", agent: "intake_agent", note: "分类任务并评估风险等级" },
      { id: "n3", kind: "tool", title: "公开来源抓取", note: "fetch_public_url · 禁用私网地址" },
      { id: "n4", kind: "agent", title: "研究与证据", agent: "research_agent", note: "整理来源、提取约束" },
      { id: "n5", kind: "agent", title: "独立质量审查", agent: "review_agent", note: "按门禁检查证据完整度" },
      { id: "n6", kind: "output", title: "交付物编排", agent: "document_agent", note: "输出简报草稿与待核实清单" },
    ],
  },
  {
    id: "wf-data-pipeline",
    name: "经营数据周报",
    description: "解析 CSV、计算指标、生成图表数据并输出周报。",
    status: "published",
    trigger: "manual",
    version: "v2.0.1",
    updatedAt: "2026-09-15T11:08:00+08:00",
    owner: "李楠",
    runCount: 64,
    successRate: 91,
    tags: ["数据", "报表"],
    nodes: [
      { id: "n1", kind: "trigger", title: "手动触发", note: "由运行中心或 API 发起" },
      { id: "n2", kind: "tool", title: "CSV 解析", note: "csv_profile · 真实解析与统计" },
      { id: "n3", kind: "agent", title: "数据分析", agent: "data_agent", note: "指标计算与数据质量检查" },
      { id: "n4", kind: "verify", title: "结果核验", agent: "verification_agent", note: "校验指标口径与量纲" },
      { id: "n5", kind: "output", title: "周报交付", agent: "document_agent", note: "输出周报与异常明细" },
    ],
  },
  {
    id: "wf-release-gate",
    name: "发布合规门禁",
    description: "发布前强制人工审批，审批通过后才允许受控执行。",
    status: "published",
    trigger: "api",
    version: "v1.1.0",
    updatedAt: "2026-09-13T09:25:00+08:00",
    owner: "王砚",
    runCount: 19,
    successRate: 100,
    tags: ["治理", "高风险"],
    nodes: [
      { id: "n1", kind: "trigger", title: "API 触发", note: "由 CI 在发布前调用" },
      { id: "n2", kind: "agent", title: "任务理解", agent: "intake_agent", note: "识别高风险动作" },
      { id: "n3", kind: "gate", title: "人工审批", note: "发布负责人必须显式放行" },
      { id: "n4", kind: "tool", title: "受控执行", note: "模拟回执，不产生真实外部写入" },
      { id: "n5", kind: "verify", title: "结果核验", agent: "verification_agent", note: "核对回执与预期一致" },
    ],
  },
  {
    id: "wf-repo-audit",
    name: "代码库盘点",
    description: "只读盘点仓库结构、依赖与待办，输出变更影响面。",
    status: "draft",
    trigger: "manual",
    version: "v0.3.0",
    updatedAt: "2026-09-17T18:03:00+08:00",
    owner: "李楠",
    runCount: 5,
    successRate: 80,
    tags: ["软件工程"],
    nodes: [
      { id: "n1", kind: "trigger", title: "手动触发", note: "选择仓库后发起" },
      { id: "n2", kind: "tool", title: "工作区盘点", note: "repo_inventory · 只读" },
      { id: "n3", kind: "agent", title: "软件工程", agent: "code_agent", note: "分析影响面与测试缺口" },
      { id: "n4", kind: "output", title: "盘点报告", agent: "document_agent", note: "输出结构清单与待办" },
    ],
  },
  {
    id: "wf-onboarding",
    name: "新成员知识问答",
    description: "基于工作区知识库回答入职问题，无法回答时标记待人工。",
    status: "archived",
    trigger: "manual",
    version: "v1.0.0",
    updatedAt: "2026-08-22T10:00:00+08:00",
    owner: "陈立",
    runCount: 47,
    successRate: 88,
    tags: ["RAG", "助手"],
    nodes: [
      { id: "n1", kind: "trigger", title: "手动触发", note: "成员在工作台提问" },
      { id: "n2", kind: "tool", title: "知识检索", note: "匹配工作区知识文档" },
      { id: "n3", kind: "agent", title: "研究与证据", agent: "research_agent", note: "组织答案与出处" },
      { id: "n4", kind: "output", title: "答案输出", note: "低置信度时转人工" },
    ],
  },
];

/* ---------------------------------------------------------------- MCP 中心 */

export type AssetKind = "document" | "image" | "table" | "archive" | "code";

export type Asset = {
  id: string;
  name: string;
  kind: AssetKind;
  mime: string;
  size: number;
  tags: string[];
  owner: string;
  uploadedAt: string;
  scope: "workspace" | "task";
  status: "ready" | "processing" | "failed";
  usedBy: string[];
};

export const assetKindLabels: Record<AssetKind, string> = {
  document: "文档",
  image: "图像",
  table: "表格",
  archive: "压缩包",
  code: "代码",
};

export const assetSeeds: Asset[] = [
  { id: "as-1", name: "2026Q3-经营数据.csv", kind: "table", mime: "text/csv", size: 1_842_114, tags: ["经营", "季度"], owner: "李楠", uploadedAt: "2026-09-18T09:12:00+08:00", scope: "workspace", status: "ready", usedBy: ["经营数据入库", "经营数据周报"] },
  { id: "as-2", name: "发布合规清单-2026-09.pdf", kind: "document", mime: "application/pdf", size: 742_400, tags: ["合规", "发布"], owner: "王砚", uploadedAt: "2026-09-17T16:30:00+08:00", scope: "workspace", status: "ready", usedBy: ["发布前合规检查"] },
  { id: "as-3", name: "架构示意图.png", kind: "image", mime: "image/png", size: 288_512, tags: ["架构", "配图"], owner: "陈立", uploadedAt: "2026-09-16T11:04:00+08:00", scope: "workspace", status: "ready", usedBy: ["研究简报流水线"] },
  { id: "as-4", name: "行业资料合集.zip", kind: "archive", mime: "application/zip", size: 12_884_901, tags: ["研究", "归档"], owner: "陈立", uploadedAt: "2026-09-15T14:48:00+08:00", scope: "workspace", status: "processing", usedBy: [] },
  { id: "as-5", name: "指标口径说明.md", kind: "document", mime: "text/markdown", size: 18_432, tags: ["口径", "指标"], owner: "李楠", uploadedAt: "2026-09-14T10:22:00+08:00", scope: "workspace", status: "ready", usedBy: ["经营数据周报"] },
  { id: "as-6", name: "pipeline_sample.py", kind: "code", mime: "text/x-python", size: 6_144, tags: ["样例", "数据"], owner: "李楠", uploadedAt: "2026-09-13T19:02:00+08:00", scope: "task", status: "ready", usedBy: ["代码库盘点"] },
  { id: "as-7", name: "客户访谈纪要.docx", kind: "document", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 96_256, tags: ["访谈", "需求"], owner: "陈立", uploadedAt: "2026-09-12T15:37:00+08:00", scope: "workspace", status: "ready", usedBy: ["新成员知识问答"] },
  { id: "as-8", name: "旧版数据备份.csv", kind: "table", mime: "text/csv", size: 24_117_248, tags: ["备份", "历史"], owner: "李楠", uploadedAt: "2026-09-10T08:15:00+08:00", scope: "workspace", status: "failed", usedBy: [] },
  { id: "as-9", name: "品牌视觉规范.pdf", kind: "document", mime: "application/pdf", size: 3_204_096, tags: ["品牌", "规范"], owner: "王砚", uploadedAt: "2026-09-08T13:55:00+08:00", scope: "workspace", status: "ready", usedBy: ["演示文稿"] },
  { id: "as-10", name: "渠道投放明细.xlsx", kind: "table", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 524_288, tags: ["投放", "渠道"], owner: "王砚", uploadedAt: "2026-09-05T09:41:00+08:00", scope: "task", status: "ready", usedBy: ["经营数据周报"] },
];

/* ------------------------------------------------------------- 租户与成员 */

export type MemberRole = "owner" | "admin" | "builder" | "operator" | "viewer";

export type Member = {
  id: string;
  name: string;
  email: string;
  role: MemberRole;
  status: "active" | "invited" | "suspended";
  tenantId: string;
  lastActiveAt: string | null;
  joinedAt: string;
  approvals: number;
  tasks: number;
};

export type Tenant = {
  id: string;
  name: string;
  plan: "free" | "team" | "enterprise" | "trial";
  region: string;
  seats: number;
  createdAt: string;
  status: "active" | "trial";
};

export const roleLabels: Record<MemberRole, string> = {
  owner: "所有者",
  admin: "管理员",
  builder: "构建者",
  operator: "执行者",
  viewer: "只读",
};

export const tenantSeeds: Tenant[] = [
  { id: "tn-main", name: "Nexus 主工作区", plan: "enterprise", region: "cn-east", seats: 30, createdAt: "2026-03-01T09:00:00+08:00", status: "active" },
  { id: "tn-lab", name: "算法实验室", plan: "team", region: "cn-east", seats: 8, createdAt: "2026-06-12T10:30:00+08:00", status: "active" },
  { id: "tn-pilot", name: "客户试点空间", plan: "trial", region: "cn-south", seats: 5, createdAt: "2026-09-01T14:00:00+08:00", status: "trial" },
];

export const memberSeeds: Member[] = [
  { id: "mb-1", name: "陈立", email: "chenli@example.com", role: "owner", status: "active", tenantId: "tn-main", lastActiveAt: "2026-09-18T16:42:00+08:00", joinedAt: "2026-03-01T09:00:00+08:00", approvals: 18, tasks: 96 },
  { id: "mb-2", name: "李楠", email: "linan@example.com", role: "admin", status: "active", tenantId: "tn-main", lastActiveAt: "2026-09-18T15:20:00+08:00", joinedAt: "2026-03-04T11:12:00+08:00", approvals: 26, tasks: 143 },
  { id: "mb-3", name: "王砚", email: "wangyan@example.com", role: "operator", status: "active", tenantId: "tn-main", lastActiveAt: "2026-09-18T14:05:00+08:00", joinedAt: "2026-04-18T09:41:00+08:00", approvals: 41, tasks: 77 },
  { id: "mb-4", name: "周艾", email: "zhouai@example.com", role: "builder", status: "active", tenantId: "tn-lab", lastActiveAt: "2026-09-17T19:33:00+08:00", joinedAt: "2026-06-12T10:30:00+08:00", approvals: 3, tasks: 52 },
  { id: "mb-5", name: "徐汀", email: "xuting@example.com", role: "viewer", status: "invited", tenantId: "tn-main", lastActiveAt: null, joinedAt: "2026-09-16T17:00:00+08:00", approvals: 0, tasks: 0 },
  { id: "mb-6", name: "何岸", email: "hean@example.com", role: "builder", status: "active", tenantId: "tn-pilot", lastActiveAt: "2026-09-18T11:48:00+08:00", joinedAt: "2026-09-01T14:00:00+08:00", approvals: 0, tasks: 21 },
  { id: "mb-7", name: "服务账号 · CI", email: "ci@service.local", role: "operator", status: "active", tenantId: "tn-main", lastActiveAt: "2026-09-18T16:55:00+08:00", joinedAt: "2026-05-02T08:00:00+08:00", approvals: 0, tasks: 310 },
  { id: "mb-8", name: "苏禾", email: "suhe@example.com", role: "builder", status: "suspended", tenantId: "tn-lab", lastActiveAt: "2026-08-29T10:11:00+08:00", joinedAt: "2026-06-20T09:00:00+08:00", approvals: 0, tasks: 8 },
];

export const rolePermissions: Array<{ role: MemberRole; scopes: string[] }> = [
  { role: "owner", scopes: ["全部配置", "成员与租户", "审批所有高风险动作", "导出审计"] },
  { role: "admin", scopes: ["全部配置", "成员管理", "审批高风险动作"] },
  { role: "builder", scopes: ["Agent / 工作流 / RAG / Skill 配置", "发起任务"] },
  { role: "operator", scopes: ["发起任务", "审批授权范围内的动作"] },
  { role: "viewer", scopes: ["只读查看看板与审计"] },
];

/* ---------------------------------------------------------------- 观测数据 */

export const usageDaily = [
  { label: "09-12", input: 182_400, output: 96_300, cost: 4.82 },
  { label: "09-13", input: 154_100, output: 81_200, cost: 4.06 },
  { label: "09-14", input: 96_700, output: 52_800, cost: 2.64 },
  { label: "09-15", input: 231_800, output: 124_500, cost: 6.31 },
  { label: "09-16", input: 268_300, output: 141_900, cost: 7.18 },
  { label: "09-17", input: 244_900, output: 132_400, cost: 6.62 },
  { label: "09-18", input: 151_200, output: 88_600, cost: 4.24 },
];

export const usageByModel = [
  { label: "gpt-5.4-mini", tokens: 1_284_000, cost: 21.48, share: 58 },
  { label: "本地规则推理", tokens: 682_400, cost: 0, share: 31 },
  { label: "text-embedding-3-small", tokens: 243_600, cost: 2.44, share: 11 },
];

export const usageByAgent = [
  { label: "研究 Agent", value: 486_200 },
  { label: "数据分析 Agent", value: 372_900 },
  { label: "交付物 Agent", value: 298_400 },
  { label: "软件工程 Agent", value: 214_600 },
  { label: "质量审查 Agent", value: 168_300 },
  { label: "任务监督 Agent", value: 92_400 },
];

export const observabilityLatency = [
  { label: "任务总时延", color: "#2f6b4f", points: [42, 38, 51, 47, 63, 58, 44] },
  { label: "工具调用时延", color: "#a8cf7a", points: [12, 14, 11, 18, 22, 17, 13] },
  { label: "推理时延", color: "#6fa87f", points: [21, 24, 27, 25, 33, 29, 23] },
];

export const observabilityDays = usageDaily.map((item) => item.label);

export const observabilityHeatRows = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export const observabilityHeatColumns = ["00", "03", "06", "09", "12", "15", "18", "21"];

export const observabilityHeat: number[][] = [
  [4, 3, 12, 68, 54, 71, 42, 18],
  [5, 4, 14, 74, 61, 78, 46, 20],
  [3, 2, 11, 71, 58, 74, 44, 19],
  [6, 5, 16, 82, 66, 88, 51, 23],
  [7, 6, 18, 79, 63, 84, 58, 26],
  [2, 1, 6, 24, 18, 26, 15, 8],
  [1, 1, 4, 16, 12, 18, 11, 5],
];

export const incidentSeeds = [
  { id: "in-1", level: "P2", title: "数据库 MCP 凭据过期", scope: "MCP · 分析型数据库", at: "2026-09-18T14:20:00+08:00", status: "处理中", owner: "李楠" },
  { id: "in-2", level: "P3", title: "抓取工具出现 3 次超时", scope: "工具 · fetch_public_url", at: "2026-09-17T22:41:00+08:00", status: "已恢复", owner: "陈立" },
  { id: "in-3", level: "P3", title: "经营数据入库任务连续失败", scope: "定时任务 · 经营数据入库", at: "2026-09-17T02:30:00+08:00", status: "待跟进", owner: "李楠" },
  { id: "in-4", level: "P4", title: "审查 Agent 建议采纳率下降", scope: "Agent · 独立质量审查", at: "2026-09-15T18:02:00+08:00", status: "已关闭", owner: "王砚" },
];

export const toolCallSeeds = [
  { tool: "fetch_public_url", agent: "研究 Agent", calls: 905, failures: 12, avgMs: 340 },
  { tool: "csv_profile", agent: "数据分析 Agent", calls: 412, failures: 3, avgMs: 96 },
  { tool: "repo_inventory", agent: "软件工程 Agent", calls: 188, failures: 1, avgMs: 210 },
  { tool: "document_render", agent: "交付物 Agent", calls: 143, failures: 0, avgMs: 74 },
  { tool: "source_extract", agent: "研究 Agent", calls: 306, failures: 5, avgMs: 132 },
  { tool: "search_nodes", agent: "任务监督 Agent", calls: 306, failures: 0, avgMs: 8 },
];

/* ------------------------------------------------------------- 账号设置 */

export type AccountProfile = {
  displayName: string;
  email: string;
  jobTitle: string;
  department: string;
  timezone: string;
  language: "zh-CN" | "en-US";
  defaultExecutionMode: "auto" | "plan_only";
  defaultRiskNotice: boolean;
  notifyEmail: boolean;
  notifyInApp: boolean;
  notifyOnApproval: boolean;
  digest: "off" | "daily" | "weekly";
  twoFactor: boolean;
  sessionTimeout: number;
  theme: "system" | "light" | "dark";
};

export const defaultProfile: AccountProfile = {
  displayName: "陈立",
  email: "chenli@example.com",
  jobTitle: "工作台负责人",
  department: "智能应用组",
  timezone: "Asia/Shanghai",
  language: "zh-CN",
  defaultExecutionMode: "auto",
  defaultRiskNotice: true,
  notifyEmail: true,
  notifyInApp: true,
  notifyOnApproval: true,
  digest: "daily",
  twoFactor: false,
  sessionTimeout: 120,
  theme: "system",
};

export const apiKeySeeds = [
  { id: "ak-1", name: "CI 发布流水线", prefix: "nx_live_8f2a", scopes: ["tasks:write", "tasks:read"], createdAt: "2026-05-02T08:00:00+08:00", lastUsedAt: "2026-09-18T16:55:00+08:00", expiresAt: "2027-05-02T08:00:00+08:00" },
  { id: "ak-2", name: "报表导出脚本", prefix: "nx_live_3c91", scopes: ["tasks:read", "audit:read"], createdAt: "2026-07-19T13:10:00+08:00", lastUsedAt: "2026-09-17T09:30:00+08:00", expiresAt: "2026-12-31T23:59:00+08:00" },
  { id: "ak-3", name: "试点环境（已吊销）", prefix: "nx_test_b70d", scopes: ["tasks:read"], createdAt: "2026-09-01T14:05:00+08:00", lastUsedAt: null, expiresAt: "2026-10-01T14:05:00+08:00" },
];

export const sessionSeeds = [
  { id: "se-1", device: "Windows · Chrome 128", ip: "10.12.4.31", location: "上海", at: "2026-09-18T16:58:00+08:00", current: true },
  { id: "se-2", device: "macOS · Safari 18", ip: "10.12.4.77", location: "上海", at: "2026-09-17T21:14:00+08:00", current: false },
  { id: "se-3", device: "iOS · Nexus App", ip: "172.20.8.19", location: "杭州", at: "2026-09-15T08:02:00+08:00", current: false },
];

/* --------------------------------------------------------------- 格式化工具 */

/* Editing forms work on the entity minus its id; a destructured rest element
   would leave an unused binding behind, so the id is dropped explicitly. */
export function omitId<T extends { id: string }>(value: T): Omit<T, "id"> {
  const copy: Record<string, unknown> = { ...value };
  delete copy.id;
  return copy as Omit<T, "id">;
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function formatNumber(value: number) {
  return value.toLocaleString("zh-CN");
}

export function compactNumber(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

/* Absolute timestamps only — see the note at the top of this file. */export function formatDateTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
