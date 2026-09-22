"use client";

/* 编排管理页：六个 hash section 共享同一份 /api/workspace 配置。
   这个文件承载「愿望配置」（希望系统怎么跑），与「运行环境」页展示的
   「运行时真相」互为对照 —— 两者不一致时以运行环境为准。

   Layout contract: workspace-layout.css must stay the last stylesheet imported
   from a page component, otherwise the page-level workbench.css wins the
   cascade for rules of equal specificity. */

import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { Books } from "@phosphor-icons/react/dist/csr/Books";
import { Brain } from "@phosphor-icons/react/dist/csr/Brain";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretUp } from "@phosphor-icons/react/dist/csr/CaretUp";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CloudArrowUp } from "@phosphor-icons/react/dist/csr/CloudArrowUp";
import { Copy } from "@phosphor-icons/react/dist/csr/Copy";
import { Database } from "@phosphor-icons/react/dist/csr/Database";
import { DownloadSimple } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { Gauge } from "@phosphor-icons/react/dist/csr/Gauge";
import { GearSix } from "@phosphor-icons/react/dist/csr/GearSix";
import { HardDrives } from "@phosphor-icons/react/dist/csr/HardDrives";
import { Lightning } from "@phosphor-icons/react/dist/csr/Lightning";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { Robot } from "@phosphor-icons/react/dist/csr/Robot";
import { ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { Sparkle } from "@phosphor-icons/react/dist/csr/Sparkle";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { UsersThree } from "@phosphor-icons/react/dist/csr/UsersThree";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { Wrench } from "@phosphor-icons/react/dist/csr/Wrench";
import Link from "next/link";
import { ChangeEvent, memo, useCallback, useEffect, useMemo, useState } from "react";
import "./workbench.css";
import "./sidebar.css";
import "../workspace-layout.css";
import { WorkbenchSidebar, WorkspaceSection, findGroupLabel, findSectionLabel, workspaceSections } from "./workbench-sidebar";
import { loadResource, peekCache, primeCache } from "./resource-cache";
import { apiFetch } from "../auth/api";
import {
  Card, ConfirmDialog, EmptyState, Field, FilterChips, FormGrid, KeyValueList, LoadingState,
  Modal, NoticeBar, Pill, SearchField, SegmentedControl, SelectInput, StatStrip, Switch, SwitchRow,
  TextArea, TextInput, Toolbar, useNotice,
} from "./ui/primitives";
import { DataTable, IconButton, RowActions, type Column } from "./ui/table";
import { formatBytes as formatSize } from "./ui/data";
import { RankList } from "./ui/charts";
import { Task, agentLabels, statusText, statusTone, typeText, riskText } from "./runtime/shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";
const WORKSPACE_KEY = "workspace-config";
const TASKS_KEY = "task-list";

type AgentConfig = { id: string; name: string; enabled: boolean; mode: string; description: string; task_types: string[] };
type DocumentItem = { id: string; name: string; size: number; chunks: number; status: string; content: string };
type KnowledgeBase = { id: string; name: string; description: string; enabled: boolean; documents: DocumentItem[]; embedding_model: string; chunk_size: number; overlap: number };
type ContextKind = "spec" | "background" | "output" | "boundary";
/* `description` / `kind` / `tags` are workbench-side organisation metadata: they
   persist inside the config JSON, but the backend's WorkspaceService.task_context
   only reads `enabled`, `scope` and `content` — and it concatenates those in
   list order. Anything else on this type is honestly labelled as metadata-only. */
type ContextItem = {
  id: string;
  name: string;
  scope: string;
  enabled: boolean;
  budget: number;
  content: string;
  description?: string;
  kind?: ContextKind;
  tags?: string[];
};
type ModelRoute = { id: string; name: string; provider: string; model: string; enabled: boolean };
type ToolItem = { name?: string; tool?: string; access?: string; allowed_agents?: string[]; description?: string };
type WorkspaceConfig = {
  agents: AgentConfig[];
  knowledge_bases: KnowledgeBase[];
  contexts: ContextItem[];
  model_routes: ModelRoute[];
  policies: Record<string, unknown>;
  tools: ToolItem[];
};
type Capability = { agent: string; title: string; task_types: string[]; order: number };
type SystemInfo = { reasoning_provider: string; persistence: string; capabilities: Capability[]; tools: ToolItem[] };

const modeOptions = [
  { value: "automatic", label: "自动选择" },
  { value: "manual", label: "仅手动" },
  { value: "required", label: "系统必需" },
];

const scopeOptions = [
  { value: "workspace", label: "全工作台" },
  { value: "task", label: "按任务选择" },
  { value: "agent", label: "指定 Agent" },
];

const contextKinds: Array<{ id: ContextKind; label: string; note: string; icon: typeof Brain }> = [
  { id: "spec", label: "系统规范", note: "编码/写作规范、口径约定", icon: ShieldCheck },
  { id: "background", label: "业务背景", note: "长期背景、领域知识", icon: Books },
  { id: "output", label: "输出要求", note: "格式、结构、语气要求", icon: Sparkle },
  { id: "boundary", label: "安全边界", note: "禁止事项、授权范围", icon: Warning },
];

const contextKindMap = Object.fromEntries(contextKinds.map((item) => [item.id, item])) as Record<ContextKind, (typeof contextKinds)[number]>;

/* Read a context's kind defensively: configs saved before this field existed
   simply do not have it. */
function contextKind(item: ContextItem) {
  return contextKindMap[item.kind ?? "spec"] ?? contextKindMap.spec;
}

/* task_context() does not truncate contexts, so this is a planning reference for
   the operator — not an enforced limit. */
const CONTEXT_SOFT_LIMIT = 24_000;

export default function WorkbenchPage() {
  // Reuse the previous payload so a revisit paints immediately instead of flashing empty state.
  const [config, setConfig] = useState<WorkspaceConfig | null>(
    () => peekCache<WorkspaceConfig>(WORKSPACE_KEY) ?? null,
  );
  const [tasks, setTasks] = useState<Task[]>(() => peekCache<Task[]>(TASKS_KEY) ?? []);
  const [section, setSection] = useState<WorkspaceSection>("overview");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"info" | "error">("info");

  const load = useCallback(async () => {
    try {
      const value = await loadResource(WORKSPACE_KEY, async () => {
        const response = await apiFetch(`${API_URL}/api/workspace`);
        if (!response.ok) throw new Error();
        return await response.json() as WorkspaceConfig;
      });
      setConfig(value);
      setDirty(false);
      setMessage("");
    } catch {
      setMessageTone("error");
      setMessage("无法读取工作台配置，请确认 Agent API 已启动。");
    }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const data = await loadResource(TASKS_KEY, async () => {
        const response = await apiFetch(`${API_URL}/api/tasks`);
        if (!response.ok) throw new Error();
        return (await response.json()) as Task[];
      }, { ttlMs: 5_000 });
      setTasks(data);
    } catch {
      // The overview degrades to config-only content when the task list is unavailable.
    }
  }, []);

  useEffect(() => { void load(); void loadTasks(); }, [load, loadTasks]);
  useEffect(() => {
    const syncSection = () => {
      const requested = window.location.hash.slice(1);
      setSection(
        workspaceSections.some((item) => item.id === requested)
          ? requested as WorkspaceSection
          : "overview",
      );
    };
    syncSection();
    window.addEventListener("hashchange", syncSection);
    return () => window.removeEventListener("hashchange", syncSection);
  }, []);

  const changeSection = useCallback((next: WorkspaceSection) => {
    setSection(next);
    window.history.replaceState(null, "", `#${next}`);
  }, []);

  const metrics = useMemo(() => ({
    agents: config?.agents.filter((item) => item.enabled).length ?? 0,
    documents: config?.knowledge_bases.reduce((sum, item) => sum + item.documents.length, 0) ?? 0,
    contexts: config?.contexts.filter((item) => item.enabled).length ?? 0,
    tools: config?.tools.length ?? 0,
  }), [config]);

  // Stable identity keeps the memoised section panels from re-rendering on
  // every parent update.
  const update = useCallback((mutator: (draft: WorkspaceConfig) => void) => {
    setConfig((current) => {
      if (!current) return current;
      const draft = structuredClone(current);
      mutator(draft);
      return draft;
    });
    setDirty(true);
    setMessage("");
  }, []);

  /** Client-side guard mirroring the backend Field constraints. */
  function validate(target: WorkspaceConfig): string | null {
    const steps = Number(target.policies.max_steps ?? 12);
    const timeout = Number(target.policies.timeout_seconds ?? 45);
    if (steps < 3 || steps > 30) return "最大调度步数需在 3–30 之间，当前为 " + steps + "。";
    if (timeout < 5 || timeout > 180) return "任务超时需在 5–180 秒之间，当前为 " + timeout + "。";
    if (target.agents.some((agent) => !agent.name.trim())) return "存在未命名的 Agent，请先补全名称。";
    if (target.knowledge_bases.some((base) => !base.name.trim())) return "存在未命名的知识库，请先补全名称。";
    if (target.knowledge_bases.some((base) => base.chunk_size < 100)) return "知识库切片大小需不小于 100。";
    if (target.contexts.some((item) => item.budget < 500)) return "上下文令牌预算需不小于 500。";
    return null;
  }

  async function save() {
    if (!config) return;
    const problem = validate(config);
    if (problem) {
      setMessageTone("error");
      setMessage(problem);
      return;
    }
    setSaving(true);
    try {
      const response = await apiFetch(`${API_URL}/api/workspace`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!response.ok) throw new Error();
      const saved = await response.json() as WorkspaceConfig;
      primeCache(WORKSPACE_KEY, saved);
      setConfig(saved);
      setDirty(false);
      setMessageTone("info");
      setMessage("工作台配置已保存到 SQLite。");
    } catch {
      setMessageTone("error");
      setMessage("配置保存失败，请检查 API 后重试。");
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    setSaving(true);
    try {
      const response = await apiFetch(`${API_URL}/api/workspace/reset`, { method: "POST" });
      if (!response.ok) throw new Error();
      const restored = await response.json() as WorkspaceConfig;
      primeCache(WORKSPACE_KEY, restored);
      setConfig(restored);
      setDirty(false);
      setMessageTone("info");
      setMessage("已恢复默认编排配置。");
    } catch {
      setMessageTone("error");
      setMessage("恢复默认配置失败。");
    } finally {
      setSaving(false);
    }
  }

  function exportConfig() {
    if (!config) return;
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "nexus-workspace.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const addDocuments = useCallback(async (kbId: string, event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    const files = selected.filter((file) => file.size <= 2_000_000);
    if (files.length !== selected.length) {
      setMessageTone("error");
      setMessage("已跳过超过 2 MB 的知识库文档。");
    }
    const docs = await Promise.all(files.map(async (file) => {
      const text = await file.text();
      return { id: crypto.randomUUID(), name: file.name, size: file.size, chunks: Math.max(1, Math.ceil(text.length / 680)), status: "ready", content: text };
    }));
    update((draft) => {
      const base = draft.knowledge_bases.find((item) => item.id === kbId);
      if (base) base.documents.push(...docs);
    });
    event.target.value = "";
  }, [update]);

  if (!config) return <main className="control-shell"><WorkbenchSidebar active={section} onSelectSection={changeSection} /><section className="control-loading"><p>{message || "正在读取编排配置…"}</p></section></main>;

  return <main className="control-shell">
    <WorkbenchSidebar active={section} onSelectSection={changeSection} />

    <section className="control-main">
      <header className="control-header"><div><p>{findGroupLabel(section)} / {findSectionLabel(section)}</p><h1>{findSectionLabel(section)}</h1></div><div className="header-actions"><button onClick={exportConfig}><DownloadSimple />导出</button><button onClick={() => void reset()}><ArrowsClockwise />恢复默认</button><button className="save" disabled={!dirty || saving} onClick={() => void save()}><CheckCircle weight="fill" />{saving ? "保存中…" : dirty ? "保存更改" : "已保存"}</button></div></header>
      {message && <div className={`control-message ${messageTone === "error" ? "error" : ""}`}>{message}</div>}

      <div className="control-content">
        {section === "overview" && <MemoOverview config={config} metrics={metrics} tasks={tasks} go={changeSection} />}
        {section === "agents" && <MemoAgents config={config} update={update} />}
        {section === "rag" && <MemoRag config={config} update={update} addDocuments={addDocuments} />}
        {section === "context" && <MemoContexts config={config} update={update} />}
        {section === "models" && <MemoModels config={config} update={update} />}
        {section === "governance" && <MemoGovernance config={config} update={update} />}
      </div>
    </section>
  </main>;
}

/* ------------------------------------------------------------------ 编排总览 */

function Overview({ config, metrics, tasks, go }: { config: WorkspaceConfig; metrics: Record<string, number>; tasks: Task[]; go: (value: WorkspaceSection) => void }) {
  const cards = [
    ["agents", "活跃 Agent", metrics.agents, "已进入 Supervisor 可选能力池", UsersThree],
    ["rag", "知识文档", metrics.documents, `${config.knowledge_bases.length} 个知识库`, Books],
    ["context", "上下文策略", metrics.contexts, "共享提示与令牌预算", Brain],
    ["models", "可用工具", metrics.tools, `${config.model_routes.filter((item) => item.enabled).length} 条模型路由`, Wrench],
  ] as const;

  const blocked = tasks.filter((task) => task.status === "awaiting_approval").length;
  const running = tasks.filter((task) => task.status === "running").length;
  const done = tasks.filter((task) => task.status === "completed").length;

  /* 待处理事项完全由配置与任务数据推导，不写死数量，避免出现「提示存在但列表为空」。 */
  const todos = useMemo(() => {
    const list: Array<{ title: string; note: string; section: WorkspaceSection }> = [];
    const emptyBases = config.knowledge_bases.filter((base) => base.enabled && base.documents.length === 0);
    if (emptyBases.length) list.push({
      title: `${emptyBases.length} 个已启用知识库没有文档`,
      note: emptyBases.map((base) => base.name).join("、") + " 不会为任务提供任何检索内容。",
      section: "rag",
    });
    const disabled = config.agents.filter((agent) => !agent.enabled && agent.mode !== "required");
    if (disabled.length) list.push({
      title: `${disabled.length} 个 Agent 已停用`,
      note: disabled.map((agent) => agent.name).join("、") + " 不会参与新任务的动态组队。",
      section: "agents",
    });
    const unbound = config.tools.filter((tool) => !(tool.allowed_agents ?? []).length);
    if (unbound.length) list.push({
      title: `${unbound.length} 个工具未绑定 Agent`,
      note: "未绑定允许角色的工具只有系统授权才能调用，普通 Agent 会直接抛权限错误。",
      section: "models",
    });
    const overBudget = config.contexts.filter((item) => item.enabled && item.budget > 16_000);
    if (overBudget.length) list.push({
      title: `${overBudget.length} 条上下文令牌预算偏高`,
      note: overBudget.map((item) => `${item.name}（${item.budget}）`).join("、") + " 会挤压任务本身的可用窗口。",
      section: "context",
    });
    const looseSteps = Number(config.policies.max_steps ?? 12) > 20;
    if (looseSteps) list.push({
      title: "最大调度步数偏大",
      note: `当前为 ${config.policies.max_steps} 步，建议控制在 8–16 步以避免失控循环。`,
      section: "governance",
    });
    return list;
  }, [config]);

  return <>
    <div className="metric-grid">{cards.map(([id, label, value, note, Icon]) => <button key={id} onClick={() => go(id)}><span><Icon weight="duotone" /></span><small>{label}</small><strong>{value}</strong><p>{note}</p></button>)}</div>

    <div className="split-grid">
      <Card
        icon={Lightning}
        title="运行概览"
        note="来自运行中心的真实任务数据"
        action={<Link className="small-action action-btn" href="/workbench/runtime"><Lightning />进入运行中心</Link>}
      >
        <div className="overview-body">
          <div className="mini-stats">
            <div><small>任务总数</small><strong>{tasks.length}</strong></div>
            <div><small>运行中</small><strong>{running}</strong></div>
            <div><small>待审批</small><strong>{blocked}</strong></div>
            <div><small>已完成</small><strong>{done}</strong></div>
          </div>
          {tasks.length
            ? <ul className="recent-list">
              {tasks.slice(0, 5).map((task) => <li key={task.task_id}>
                <Link href={`/workbench/runtime#task=${task.task_id}`}>
                  <span>
                    <strong>{task.objective.slice(0, 42)}{task.objective.length > 42 ? "…" : ""}</strong>
                    <small>{typeText(task.task_type)} · {riskText(task.risk_level)} · {task.plan.length} 个步骤</small>
                  </span>
                  <b className={`tone ${statusTone(task.status)}`}>{statusText(task.status)}</b>
                </Link>
              </li>)}
            </ul>
            : <EmptyState icon={Lightning} title="还没有任务记录" note="在运行中心提交第一条指令后，这里会显示最近的运行。" />}
        </div>
      </Card>

      <Card icon={Warning} title="待处理事项" note="根据当前配置自动推导，点击可直达对应配置区" count={todos.length}>
        {todos.length
          ? <ul className="todo-list">
            {todos.map((item) => <li key={item.title}>
              <button type="button" onClick={() => go(item.section)}>
                <span className="todo-index" />
                <span><strong>{item.title}</strong><small>{item.note}</small></span>
              </button>
            </li>)}
          </ul>
          : <EmptyState icon={CheckCircle} title="配置健康" note="当前没有检测到需要处理的编排配置问题。" />}
      </Card>
    </div>

    <div className="overview-grid">
      <article className="control-card topology">
        <div className="card-title"><span><Robot weight="duotone" /></span><div><h2>编排拓扑</h2><p>任务从入口到执行的控制链</p></div></div>
        <div className="topology-flow"><Node title="Intake" note="分类与风险" /><b>→</b><Node title="Planner" note="动态组队" /><b>→</b><Node title="Supervisor" note="路由与停止" primary /><b>→</b><Node title="Workers" note={`${Math.max(metrics.agents - 1, 0)} 个能力`} /><b>→</b><Node title="Review" note="质量门禁" /></div>
      </article>
      <article className="control-card readiness">
        <div className="card-title"><span><ShieldCheck weight="duotone" /></span><div><h2>运行就绪度</h2><p>关键控制项状态</p></div></div>
        <Status label="高风险人工审批" enabled={Boolean(config.policies.approval_for_high_risk)} />
        <Status label="工具调用审计" enabled={Boolean(config.policies.tool_audit)} />
        <Status label="私有网络拦截" enabled={Boolean(config.policies.block_private_networks)} />
        <Status label="本地回退路由" enabled={config.model_routes.some((item) => item.provider === "local" && item.enabled)} />
      </article>
    </div>

    <Card icon={Gauge} title="配置摘要" note="各配置区的条目数量与最新状态，点击可直接跳转">
      <div className="data-table-wrap">
        <div className="data-table">
          <div className="dt-head"><div className="dt-cell">配置区</div><div className="dt-cell right">条目</div><div className="dt-cell right">已启用</div><div className="dt-cell">状态</div><div className="dt-cell right">操作</div></div>
          <div className="dt-body">
            {([
              ["Agent 能力注册表", "agents", config.agents.length, config.agents.filter((item) => item.enabled).length, "决定 Planner 的组队范围"],
              ["RAG 知识库", "rag", config.knowledge_bases.length, config.knowledge_bases.filter((item) => item.enabled).length, `${metrics.documents} 个文档参与检索`],
              ["上下文策略", "context", config.contexts.length, config.contexts.filter((item) => item.enabled).length, "注入新任务的共享提示"],
              ["模型与工具", "models", config.model_routes.length + config.tools.length, config.model_routes.filter((item) => item.enabled).length + config.tools.length, "按用途路由与工具授权"],
              ["治理策略", "governance", 5, ["approval_for_high_risk", "tool_audit", "block_private_networks"].filter((key) => Boolean(config.policies[key])).length, `最大 ${config.policies.max_steps ?? 12} 步 · 超时 ${config.policies.timeout_seconds ?? 45}s`],
            ] as Array<[string, WorkspaceSection, number, number, string]>).map(([label, id, total, active, note]) => <div className="dt-row" key={id}>
              <div className="dt-cell"><span className="cell-title"><strong>{label}</strong><small>{note}</small></span></div>
              <div className="dt-cell right"><strong>{total}</strong></div>
              <div className="dt-cell right">{active}</div>
              <div className="dt-cell"><Pill tone={active > 0 ? "ok" : "warn"}>{active > 0 ? "已生效" : "未启用"}</Pill></div>
              <div className="dt-cell right"><button type="button" className="ghost-action" onClick={() => go(id)}>前往配置</button></div>
            </div>)}
          </div>
        </div>
      </div>
    </Card>
  </>;
}

/* ---------------------------------------------------------------- Agent 管理 */

function Agents({ config, update }: PanelProps) {
  const { notice, push, clear } = useNotice();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("all");
  const [status, setStatus] = useState<"all" | "enabled" | "disabled">("all");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [catalog, setCatalog] = useState<Capability[] | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [pendingRemove, setPendingRemove] = useState<AgentConfig | null>(null);

  const detail = config.agents.find((agent) => agent.id === detailId) ?? null;
  const registered = new Set(config.agents.map((agent) => agent.id));

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return config.agents.filter((agent) => {
      if (mode !== "all" && agent.mode !== mode) return false;
      if (status === "enabled" && !agent.enabled) return false;
      if (status === "disabled" && agent.enabled) return false;
      if (!keyword) return true;
      return agent.name.toLowerCase().includes(keyword)
        || agent.id.toLowerCase().includes(keyword)
        || agent.description.toLowerCase().includes(keyword)
        || agent.task_types.some((type) => type.toLowerCase().includes(keyword));
    });
  }, [config.agents, query, mode, status]);

  /** 只有能力注册表里的 id 才会真正参与运行时调度，因此候选来自 /api/system。 */
  async function openRegister() {
    setRegisterOpen(true);
    setCatalogError("");
    if (catalog) return;
    try {
      const info = await loadResource<SystemInfo>("system-info", async () => {
        const response = await apiFetch(`${API_URL}/api/system`);
        if (!response.ok) throw new Error();
        return (await response.json()) as SystemInfo;
      }, { ttlMs: 5_000 });
      setCatalog(info.capabilities);
    } catch {
      setCatalogError("无法读取能力注册表，请确认 Agent API 已启动。");
    }
  }

  const registeredAll = Boolean(catalog) && catalog!.every((item) => registered.has(item.agent));
  const available = catalog?.filter((item) => !registered.has(item.agent)) ?? [];

  const columns: Array<Column<AgentConfig>> = [
    {
      key: "name",
      header: "Agent",
      sortValue: (row) => row.name,
      render: (row) => <span className="cell-title with-icon">
        <i className="avatar-badge">{row.name.slice(0, 1)}</i>
        <span><strong>{row.name}</strong><small>{row.description}</small></span>
      </span>,
    },
    {
      key: "task_types",
      header: "适用任务",
      render: (row) => <span className="chip-list">{row.task_types.map((item) => <b key={item}>{item === "all" ? "全部" : typeText(item)}</b>)}</span>,
    },
    {
      key: "mode",
      header: "调度方式",
      secondary: true,
      sortValue: (row) => row.mode,
      render: (row) => <SelectInput
        value={row.mode}
        onChange={(value) => {
          update((draft) => {
            const target = draft.agents.find((item) => item.id === row.id);
            if (target) target.mode = value;
          });
          push(`${row.name} 的调度方式已改为${modeOptions.find((item) => item.value === value)?.label ?? value}`);
        }}
        options={modeOptions}
      />,
    },
    {
      key: "enabled",
      header: "状态",
      sortValue: (row) => String(row.enabled),
      render: (row) => <div className="agent-status">
        <Switch
          checked={row.enabled}
          disabled={row.mode === "required"}
          label={`启用 ${row.name}`}
          onChange={(value) => {
            update((draft) => {
              const target = draft.agents.find((item) => item.id === row.id);
              if (target) target.enabled = value;
            });
            push(value ? `已启用 ${row.name}` : `已停用 ${row.name}，Planner 不再选择它`);
          }}
        />
        {row.mode === "required" && <small>系统必需</small>}
      </div>,
    },
    {
      key: "actions",
      header: "操作",
      align: "right",
      render: (row) => <RowActions>
        <IconButton icon={MagnifyingGlass} label="查看详情" onClick={() => setDetailId(row.id)} />
        <IconButton
          icon={Trash}
          label="移除注册"
          tone="danger"
          disabled={row.mode === "required"}
          onClick={() => setPendingRemove(row)}
        />
      </RowActions>,
    },
  ];

  return <>
    <NoticeBar notice={notice} onClose={clear} />

    <Card
      icon={UsersThree}
      title="Agent 能力注册表"
      note="控制专业 Agent 是否参与新任务的动态规划；改动需保存后才写入 SQLite"
      count={filtered.length}
      action={<button type="button" className="small-action action-btn" onClick={() => void openRegister()}><Plus />注册 Agent</button>}
      toolbar={<Toolbar>
        <SearchField value={query} onChange={setQuery} placeholder="搜索 Agent 名称、标识或适用任务" />
        <div className="toolbar-filters">
          <SelectInput value={mode} onChange={setMode} options={[{ value: "all", label: "全部调度方式" }, ...modeOptions]} />
          <FilterChips<"all" | "enabled" | "disabled">
            value={status}
            onChange={setStatus}
            options={[
              { id: "all", label: "全部" },
              { id: "enabled", label: "已启用" },
              { id: "disabled", label: "已停用" },
            ]}
            counts={{
              all: config.agents.length,
              enabled: config.agents.filter((item) => item.enabled).length,
              disabled: config.agents.filter((item) => !item.enabled).length,
            }}
          />
        </div>
      </Toolbar>}
    >
      <DataTable<AgentConfig>
        columns={columns}
        rows={filtered}
        rowKey={(row) => row.id}
        pageSize={8}
        activeKey={detailId}
        onRowClick={(row) => setDetailId(row.id)}
        emptyTitle={config.agents.length ? "没有匹配的 Agent" : "能力注册表为空"}
        emptyNote={config.agents.length ? "试着更换调度方式或清空搜索关键词。" : "从能力注册表里注册一个 Agent 参与编排。"}
        emptyAction={config.agents.length
          ? <button type="button" className="ghost-action" onClick={() => { setQuery(""); setMode("all"); setStatus("all"); }}>清除筛选</button>
          : <button type="button" className="primary-action action-btn" onClick={() => void openRegister()}><Plus />注册 Agent</button>}
      />
    </Card>

    <Modal
      open={registerOpen}
      onClose={() => setRegisterOpen(false)}
      title="注册 Agent"
      description="只有能力注册表（/api/system）里声明过的 Agent 才能被 Planner 选中，因此候选列表来自运行时而不是自由输入。"
    >
      {catalogError
        ? <EmptyState icon={Warning} title="读取能力注册表失败" note={catalogError} />
        : !catalog
          ? <LoadingState label="正在读取能力注册表…" />
          : registeredAll
            ? <EmptyState icon={CheckCircle} title="全部能力已注册" note="当前能力注册表里的 Agent 都已在编排配置中，无需重复注册。" />
            : <ul className="capability-list">
              {available.map((item) => <li key={item.agent}>
                <span><strong>{item.title}</strong><small>{item.agent} · 顺序 {item.order} · 适用 {item.task_types.map((type) => type === "all" ? "全部" : typeText(type)).join("、")}</small></span>
                <button type="button" className="primary-action action-btn" onClick={() => {
                  update((draft) => {
                    draft.agents.push({
                      id: item.agent,
                      name: item.title,
                      enabled: true,
                      mode: "automatic",
                      description: "从能力注册表注册的专业 Agent",
                      task_types: item.task_types,
                    });
                  });
                  push(`已注册 ${item.title}，保存后生效`);
                  setRegisterOpen(false);
                }}><Plus />注册</button>
              </li>)}
            </ul>}
    </Modal>

    <Modal
      open={Boolean(detail)}
      onClose={() => setDetailId(null)}
      variant="side"
      title={detail?.name ?? ""}
      description={detail ? `${detail.id} · ${modeOptions.find((item) => item.value === detail.mode)?.label ?? detail.mode}` : undefined}
      footer={detail && <>
        <button type="button" className="ghost-action" onClick={() => setDetailId(null)}>关闭</button>
        <button type="button" className="primary-action action-btn" disabled={detail.mode === "required"} onClick={() => setDetailId(null)}>完成</button>
      </>}
    >
      {detail && <div className="detail-stack">
        <div className="detail-badges">
          <Pill tone={detail.enabled ? "ok" : "neutral"}>{detail.enabled ? "已启用" : "已停用"}</Pill>
          <Pill tone={detail.mode === "required" ? "accent" : "info"}>{modeOptions.find((item) => item.value === detail.mode)?.label ?? detail.mode}</Pill>
          {!registered.has(detail.id) && <Pill tone="warn">未在能力注册表</Pill>}
        </div>

        <section className="detail-block">
          <h3>职责说明</h3>
          <TextArea value={detail.description} rows={3} onChange={(value) => update((draft) => {
            const target = draft.agents.find((item) => item.id === detail.id);
            if (target) target.description = value;
          })} />
        </section>

        <section className="detail-block">
          <h3>适用任务类型</h3>
          <div className="chip-list padded">
            {detail.task_types.map((type) => <b key={type}>{type === "all" ? "全部任务" : typeText(type)}</b>)}
          </div>
          <p className="detail-note">任务类型由「任务理解」Agent 识别，命中后该 Agent 才会进入 Planner 的候选池。</p>
        </section>

        <section className="detail-block">
          <h3>调度行为</h3>
          <FormGrid columns={1}>
            <Field label="调度方式" hint="系统必需表示不可关闭，始终参与编排">
              <SelectInput
                value={detail.mode}
                onChange={(value) => update((draft) => {
                  const target = draft.agents.find((item) => item.id === detail.id);
                  if (target) target.mode = value;
                })}
                options={modeOptions}
              />
            </Field>
          </FormGrid>
          <SwitchRow
            title="参与新任务编排"
            note={detail.mode === "required" ? "系统必需 Agent 不可停用" : "关闭后 Planner 不会再选择它"}
            checked={detail.enabled}
            disabled={detail.mode === "required"}
            onChange={(value) => update((draft) => {
              const target = draft.agents.find((item) => item.id === detail.id);
              if (target) target.enabled = value;
            })}
          />
        </section>

        <section className="detail-block">
          <h3>关联工具</h3>
          {config.tools.filter((tool) => (tool.allowed_agents ?? []).includes(detail.id)).length
            ? <ul className="tool-inventory">{config.tools.filter((tool) => (tool.allowed_agents ?? []).includes(detail.id)).map((tool) => <li key={tool.name ?? tool.tool}>
              <Wrench />
              <div><strong className="mono">{tool.name ?? tool.tool}</strong><small>{tool.description ?? "运行时注册工具"}</small></div>
              <Pill tone={tool.access === "write" ? "warn" : "info"}>{tool.access === "write" ? "写入" : "只读"}</Pill>
            </li>)}</ul>
            : <p className="detail-note">该 Agent 当前不直接调用任何工具。</p>}
        </section>

        <p className="page-note">改动需要点击顶部「保存更改」才会写入 SQLite，并即时影响新任务的组队结果。</p>
      </div>}
    </Modal>

    <ConfirmDialog
      open={Boolean(pendingRemove)}
      title="移除 Agent 注册"
      message={pendingRemove ? `${pendingRemove.name} 将从编排配置中移除，Planner 不再选择它。可通过「注册 Agent」随时恢复。` : ""}
      confirmLabel="确认移除"
      onConfirm={() => {
        if (!pendingRemove) return;
        update((draft) => { draft.agents = draft.agents.filter((item) => item.id !== pendingRemove.id); });
        push(`已移除 ${pendingRemove.name}，保存后生效`);
      }}
      onClose={() => setPendingRemove(null)}
    />
  </>;
}

/* --------------------------------------------------------------- RAG 知识库 */

function Rag({ config, update, addDocuments }: PanelProps & { addDocuments: (id: string, event: ChangeEvent<HTMLInputElement>) => void }) {
  const [activeId, setActiveId] = useState(config.knowledge_bases[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [docQuery, setDocQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<KnowledgeBase | null>(null);

  const active = config.knowledge_bases.find((item) => item.id === activeId) ?? config.knowledge_bases[0] ?? null;

  /* 与服务端 WorkspaceService.task_context 使用同一套关键词打分口径，便于预测
     一次任务实际会注入哪些知识片段。 */
  const results = useMemo(() => {
    if (!active || query.trim().length < 2) return [];
    const terms = query.toLowerCase().match(/[\w\u4e00-\u9fff]{2,}/g) ?? [];
    const [first = ""] = terms;
    if (!first) return [];
    return active.documents.map((doc) => {
      const lower = doc.content.toLowerCase();
      const hits = terms.reduce((sum, term) => sum + (lower.split(term).length - 1), 0);
      const at = Math.max(lower.indexOf(first), 0);
      return { doc, hits, snippet: hits ? doc.content.slice(Math.max(0, at - 40), at + 160).replace(/\s+/g, " ") : "" };
    }).filter((item) => item.hits > 0).sort((a, b) => b.hits - a.hits).slice(0, 3);
  }, [active, query]);

  const visibleDocs = useMemo(() => {
    if (!active) return [];
    const keyword = docQuery.trim().toLowerCase();
    if (!keyword) return active.documents;
    return active.documents.filter((doc) => doc.name.toLowerCase().includes(keyword));
  }, [active, docQuery]);

  function addBase() {
    const id = crypto.randomUUID();
    update((draft) => {
      draft.knowledge_bases.push({ id, name: `知识库 ${draft.knowledge_bases.length + 1}`, description: "新的检索知识域", enabled: true, documents: [], embedding_model: "text-embedding-3-small", chunk_size: 800, overlap: 120 });
    });
    setActiveId(id);
  }

  function patchBase(id: string, mutator: (base: KnowledgeBase) => void) {
    update((draft) => {
      const base = draft.knowledge_bases.find((item) => item.id === id);
      if (base) mutator(base);
    });
  }

  return <div className="stack">
    <Card
      icon={Database}
      title="RAG 知识库"
      note="管理检索域、切片参数与索引文档；文档会被自动注入匹配的任务上下文"
      count={config.knowledge_bases.length}
      action={<button type="button" className="small-action action-btn" onClick={addBase}><Plus />新建知识库</button>}
      toolbar={<Toolbar>
        <SegmentedControl<string>
          value={active?.id ?? ""}
          onChange={setActiveId}
          options={config.knowledge_bases.map((base) => ({ id: base.id, label: base.name }))}
        />
      </Toolbar>}
    >
      {!config.knowledge_bases.length
        ? <EmptyState icon={Database} title="还没有知识库" note="创建第一个知识库并上传文档，任务就能引用你的资料。" action={<button type="button" className="primary-action action-btn" onClick={addBase}><Plus />新建知识库</button>} />
        : active && <div className="kb-grid">
          <article className="kb-card">
            <div className="kb-head">
              <span><HardDrives weight="duotone" /></span>
              <div>
                <TextInput value={active.name} onChange={(value) => patchBase(active.id, (base) => { base.name = value; })} />
                <p>{active.documents.length} 个文档 · {active.documents.reduce((sum, doc) => sum + doc.chunks, 0)} 个切片 · {formatSize(active.documents.reduce((sum, doc) => sum + doc.size, 0))}</p>
              </div>
              <Switch checked={active.enabled} label="启用知识库" onChange={(value) => patchBase(active.id, (base) => { base.enabled = value; })} />
            </div>
            <TextArea value={active.description} rows={2} onChange={(value) => patchBase(active.id, (base) => { base.description = value; })} />
            <FormGrid columns={2}>
              <Field label="切片大小" hint="字符数，建议 400–1200">
                <TextInput value={String(active.chunk_size)} onChange={(value) => patchBase(active.id, (base) => { base.chunk_size = Number(value) || 0; })} invalid={active.chunk_size < 100} />
              </Field>
              <Field label="切片重叠" error={active.overlap >= active.chunk_size ? "重叠需小于切片大小" : undefined}>
                <TextInput value={String(active.overlap)} onChange={(value) => patchBase(active.id, (base) => { base.overlap = Number(value) || 0; })} invalid={active.overlap >= active.chunk_size} />
              </Field>
            </FormGrid>
            <Field label="向量模型" hint="本地规则模式不使用向量化，远程推理才会调用。">
              <SelectInput
                value={active.embedding_model}
                onChange={(value) => patchBase(active.id, (base) => { base.embedding_model = value; })}
                options={[
                  { value: "text-embedding-3-small", label: "text-embedding-3-small" },
                  { value: "text-embedding-3-large", label: "text-embedding-3-large" },
                  { value: "bge-m3", label: "bge-m3（本地）" },
                ]}
              />
            </Field>
            <div className="kb-footer">
              <label className="drop-zone">
                <CloudArrowUp />
                <strong>添加文档</strong>
                <small>TXT、MD、CSV、JSON，单个不超过 2 MB</small>
                <input type="file" multiple accept=".txt,.md,.csv,.json,text/*,application/json" onChange={(event) => void addDocuments(active.id, event)} />
              </label>
              <button type="button" className="danger-action" onClick={() => setPendingDelete(active)}><Trash />删除知识库</button>
            </div>
          </article>

          <article className="kb-card">
            <div className="kb-head"><span><Sparkle weight="duotone" /></span><div><strong className="kb-title">检索测试</strong><p>用关键词模拟任务上下文注入，确认文档真的能被命中</p></div></div>
            <SearchField value={query} onChange={setQuery} placeholder="输入任务描述片段，例如：季度经营指标口径" />
            {query.trim().length < 2
              ? <p className="detail-note">至少输入 2 个字符才会开始匹配。</p>
              : results.length
                ? <ul className="retrieval-list">{results.map((item) => <li key={item.doc.id}>
                  <header><strong>{item.doc.name}</strong><Pill tone="ok">命中 {item.hits} 次</Pill></header>
                  <p>{item.snippet}…</p>
                </li>)}</ul>
                : <p className="detail-note">没有文档命中该关键词，任务上下文不会注入任何知识片段。</p>}
            <p className="page-note">打分口径与服务端一致（按关键词出现次数排序，最多注入 3 个文档）。</p>
          </article>
        </div>}
    </Card>

    {active && <Card
      icon={Books}
      title={`文档列表 · ${active.name}`}
      note="删除文档会立即从检索范围移除；改动需保存后写入 SQLite"
      count={visibleDocs.length}
      toolbar={<Toolbar>
        <SearchField value={docQuery} onChange={setDocQuery} placeholder="搜索文档名称" />
        <span className="toolbar-hint">共 {active.documents.reduce((sum, doc) => sum + doc.chunks, 0)} 个切片</span>
      </Toolbar>}
    >
      {active.documents.length
        ? <div className="document-list padded">
          {visibleDocs.map((doc) => <div key={doc.id}>
            <span><Books /><span><strong>{doc.name}</strong><small>{formatSize(doc.size)} · {doc.chunks} 个切片 · {doc.status === "ready" ? "已索引" : doc.status}</small></span></span>
            <button type="button" aria-label={`删除 ${doc.name}`} onClick={() => patchBase(active.id, (base) => { base.documents = base.documents.filter((item) => item.id !== doc.id); })}><Trash /></button>
          </div>)}
          {!visibleDocs.length && <p className="document-empty">没有匹配「{docQuery}」的文档。</p>}
        </div>
        : <EmptyState icon={Books} title="该知识库还没有文档" note="上传 TXT、MD、CSV 或 JSON 文件，其中内容会参与检索。" />}
    </Card>}

    <ConfirmDialog
      open={Boolean(pendingDelete)}
      title="删除知识库"
      message={pendingDelete ? `「${pendingDelete.name}」及其 ${pendingDelete.documents.length} 个文档将被移除，任务上下文不再注入这些内容。` : ""}
      onConfirm={() => {
        if (!pendingDelete) return;
        update((draft) => { draft.knowledge_bases = draft.knowledge_bases.filter((item) => item.id !== pendingDelete.id); });
        setActiveId(config.knowledge_bases.find((item) => item.id !== pendingDelete.id)?.id ?? "");
      }}
      onClose={() => setPendingDelete(null)}
    />
  </div>;
}

/* ------------------------------------------------------------ 上下文管理 */

function Contexts({ config, update }: PanelProps) {
  const { notice, push, clear } = useNotice();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [kind, setKind] = useState<"all" | ContextKind>("all");
  const [status, setStatus] = useState<"all" | "enabled" | "disabled">("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ContextItem | null>(null);

  /* Every edit goes through one helper so the "find by id then mutate" dance
     isn't repeated 12 times inline. */
  const edit = useCallback((id: string, mutator: (item: ContextItem) => void) => {
    update((draft) => {
      const target = draft.contexts.find((entry) => entry.id === id);
      if (target) mutator(target);
    });
  }, [update]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return config.contexts.filter((item) => {
      if (scope !== "all" && item.scope !== scope) return false;
      if (kind !== "all" && contextKind(item).id !== kind) return false;
      if (status === "enabled" && !item.enabled) return false;
      if (status === "disabled" && item.enabled) return false;
      if (!keyword) return true;
      return item.name.toLowerCase().includes(keyword)
        || item.content.toLowerCase().includes(keyword)
        || (item.description ?? "").toLowerCase().includes(keyword)
        || (item.tags ?? []).some((tag) => tag.toLowerCase().includes(keyword));
    });
  }, [config.contexts, query, scope, kind, status]);

  /* Order is meaningful: task_context() joins the enabled, workspace-scoped
     blocks in exactly this sequence, so reordering really rewrites the prompt. */
  const injectable = useMemo(
    () => config.contexts.filter((item) => item.enabled && item.scope === "workspace" && item.content.trim()),
    [config.contexts],
  );
  const totalChars = injectable.reduce((sum, item) => sum + item.content.length, 0);
  const preview = injectable.map((item) => item.content.trim()).join("\n\n");

  const readiness = useMemo(() => {
    const issues: Array<{ id: string; title: string; note: string; tone: "warn" | "info" }> = [];
    if (!injectable.length) {
      issues.push({
        id: "none",
        title: "没有任何上下文会被自动注入",
        note: "自动注入需要同时满足：已启用 + 范围是全工作台 + 内容非空。当前为 0 条，新任务不会获得共享规范。",
        tone: "warn",
      });
    }
    const unnamed = config.contexts.filter((item) => !item.name.trim());
    if (unnamed.length) {
      issues.push({ id: "unnamed", title: `${unnamed.length} 条上下文没有名称`, note: "名称会出现在列表与审计里，建议补全以便回溯。", tone: "info" });
    }
    const empty = config.contexts.filter((item) => item.enabled && !item.content.trim());
    if (empty.length) {
      issues.push({ id: "empty", title: `${empty.length} 条已启用但内容为空`, note: "空内容不会产生任何提示词，等同于无效配置。", tone: "warn" });
    }
    const over = injectable.filter((item) => item.content.length > item.budget);
    if (over.length) {
      issues.push({
        id: "over",
        title: `${over.length} 条超出参考预算`,
        note: "参考预算不参与服务端截断，超出部分会原样进入提示词，这里只是工作台内的规划提示。",
        tone: "info",
      });
    }
    if (totalChars > CONTEXT_SOFT_LIMIT) {
      issues.push({
        id: "total",
        title: `共享上下文合计 ${totalChars.toLocaleString("zh-CN")} 字`,
        note: `超过建议上限 ${CONTEXT_SOFT_LIMIT.toLocaleString("zh-CN")} 字，会明显挤压任务自身的可用窗口。`,
        tone: "warn",
      });
    }
    const manual = config.contexts.filter((item) => item.enabled && item.scope !== "workspace");
    if (manual.length) {
      issues.push({
        id: "manual",
        title: `${manual.length} 条范围不是「全工作台」`,
        note: "「按任务选择」与「指定 Agent」不会自动注入，当前只能作为配置意图保存。",
        tone: "info",
      });
    }
    return issues;
  }, [config.contexts, injectable, totalChars]);

  function addContext() {
    const id = crypto.randomUUID();
    update((draft) => {
      draft.contexts.push({
        id,
        name: `上下文 ${draft.contexts.length + 1}`,
        description: "",
        kind: "spec",
        tags: [],
        scope: "workspace",
        enabled: true,
        budget: 8000,
        content: "",
      });
    });
    setExpanded(id);
    push("已新增上下文，处于展开状态可直接编辑");
  }

  function move(id: string, delta: number) {
    update((draft) => {
      const from = draft.contexts.findIndex((entry) => entry.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= draft.contexts.length) return;
      const [moved] = draft.contexts.splice(from, 1);
      if (!moved) return;
      draft.contexts.splice(to, 0, moved);
    });
  }

  function duplicate(item: ContextItem) {
    update((draft) => {
      const index = draft.contexts.findIndex((entry) => entry.id === item.id);
      const source = draft.contexts[index];
      if (index < 0 || !source) return;
      draft.contexts.splice(index + 1, 0, { ...source, id: crypto.randomUUID(), name: `${source.name} 副本`, enabled: false });
    });
    push(`已复制「${item.name}」，副本默认停用`);
  }

  async function copyPreview() {
    if (!preview) {
      push("当前没有会被注入的内容", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(preview);
      push(`已复制 ${injectable.length} 条上下文（${totalChars.toLocaleString("zh-CN")} 字）`);
    } catch {
      push("复制失败，请手动选中预览内容", "error");
    }
  }

  const stats = [
    { label: "上下文条目", value: config.contexts.length, note: `${config.contexts.filter((item) => item.enabled).length} 条已启用`, icon: Brain },
    { label: "自动注入", value: injectable.length, note: "启用 + 全工作台 + 有内容", icon: Lightning },
    { label: "共享体量", value: `${totalChars.toLocaleString("zh-CN")} 字`, note: `建议不超过 ${CONTEXT_SOFT_LIMIT.toLocaleString("zh-CN")} 字`, icon: Gauge },
    { label: "待确认项", value: readiness.filter((item) => item.tone === "warn").length, note: "需要人工确认的配置问题", icon: Warning },
  ];

  return <div className="stack">
    <NoticeBar notice={notice} onClose={clear} />

    <StatStrip items={stats} />

    <Card icon={Warning} title="注入就绪度" note="从当前配置推导，不是预设文案；点任一条可重置筛选以定位" count={readiness.length}>
      {readiness.length
        ? <ul className="todo-list">{readiness.map((item) => <li key={item.id}>
          <button type="button" onClick={() => { setQuery(""); setScope("all"); setKind("all"); setStatus("all"); }}>
            <span className={`todo-index ${item.tone}`} />
            <span><strong>{item.title}</strong><small>{item.note}</small></span>
          </button>
        </li>)}</ul>
        : <EmptyState icon={CheckCircle} title="注入链路健康" note="有上下文会稳定注入新任务，且未发现配置问题。" />}
    </Card>

    <Card
      icon={Brain}
      title="上下文策略"
      note="自动注入需要同时满足：已启用 + 范围是全工作台 + 内容非空；列表顺序就是提示词里的拼接顺序"
      count={filtered.length}
      action={<button type="button" className="small-action action-btn" onClick={addContext}><Plus />添加上下文</button>}
      toolbar={<Toolbar>
        <SearchField value={query} onChange={setQuery} placeholder="搜索名称、说明、内容或标签" />
        <div className="toolbar-filters">
          <SelectInput value={scope} onChange={setScope} options={[{ value: "all", label: "全部范围" }, ...scopeOptions]} />
          <SelectInput
            value={kind}
            onChange={setKind}
            options={[{ value: "all", label: "全部类型" }, ...contextKinds.map((item) => ({ value: item.id, label: item.label }))]}
          />
          <FilterChips<"all" | "enabled" | "disabled">
            value={status}
            onChange={setStatus}
            options={[
              { id: "all", label: "全部" },
              { id: "enabled", label: "已启用" },
              { id: "disabled", label: "已停用" },
            ]}
            counts={{
              all: config.contexts.length,
              enabled: config.contexts.filter((item) => item.enabled).length,
              disabled: config.contexts.filter((item) => !item.enabled).length,
            }}
          />
        </div>
      </Toolbar>}
    >
      {!config.contexts.length
        ? <EmptyState
          icon={Brain}
          title="还没有上下文策略"
          note="添加一条共享规范，让所有任务都遵守同一套输出要求与边界。"
          action={<button type="button" className="primary-action action-btn" onClick={addContext}><Plus />添加上下文</button>}
        />
        : filtered.length
          ? <div className="context-list">{filtered.map((item) => {
            const meta = contextKind(item);
            const Icon = meta.icon;
            const over = item.content.length > item.budget;
            const autoInjected = injectable.some((entry) => entry.id === item.id);
            const order = injectable.findIndex((entry) => entry.id === item.id);
            const rawIndex = config.contexts.findIndex((entry) => entry.id === item.id);
            const isOpen = expanded === item.id;
            const tags = item.tags ?? [];
            return <article key={item.id} className={autoInjected ? "" : "muted"}>
              <div className="context-top">
                <span><Icon weight="duotone" /></span>
                <TextInput value={item.name} onChange={(value) => edit(item.id, (target) => { target.name = value; })} />
                <SelectInput
                  value={item.scope}
                  onChange={(value) => edit(item.id, (target) => { target.scope = value; })}
                  options={scopeOptions}
                />
                <Switch
                  checked={item.enabled}
                  label={`启用 ${item.name}`}
                  onChange={(value) => edit(item.id, (target) => { target.enabled = value; })}
                />
              </div>

              <div className="context-meta">
                <Pill tone={autoInjected ? "ok" : "neutral"}>{autoInjected ? `注入顺序 ${order + 1}` : "不参与自动注入"}</Pill>
                <Pill tone="info">{meta.label}</Pill>
                <span className="muted-text">{item.description?.trim() || meta.note}</span>
                {tags.map((tag) => <Pill key={tag} tone="neutral">{tag}</Pill>)}
              </div>

              <TextArea
                value={item.content}
                rows={isOpen ? 8 : 3}
                placeholder="输入系统规范、业务背景或输出要求…（只有范围是全工作台且已启用时才会自动注入）"
                onChange={(value) => edit(item.id, (target) => { target.content = value; })}
              />

              <div className="context-foot">
                <label>参考预算 <input type="number" min={500} step={500} value={item.budget} onChange={(event) => edit(item.id, (target) => { target.budget = Number(event.target.value) || 0; })} /></label>
                <span className={over ? "text-danger" : ""}>{item.content.length.toLocaleString("zh-CN")} 字 / 参考 {item.budget.toLocaleString("zh-CN")}{over ? " · 已超出参考值" : ""}</span>
                <button type="button" onClick={() => duplicate(item)}><Copy />复制</button>
                <button type="button" disabled={rawIndex <= 0} onClick={() => move(item.id, -1)}><CaretUp />上移</button>
                <button type="button" disabled={rawIndex >= config.contexts.length - 1} onClick={() => move(item.id, 1)}><CaretDown />下移</button>
                <button type="button" onClick={() => { setExpanded(isOpen ? null : item.id); setTagDraft(""); }}>{isOpen ? "收起" : "展开"}</button>
                <button type="button" onClick={() => setPendingDelete(item)}><Trash />删除</button>
              </div>

              {isOpen && <div className="context-editor">
                <FormGrid columns={2}>
                  <Field label="类型" hint={`${meta.label} · ${meta.note}`}>
                    <SelectInput
                      value={meta.id}
                      onChange={(value) => edit(item.id, (target) => { target.kind = value; })}
                      options={contextKinds.map((entry) => ({ value: entry.id, label: entry.label }))}
                    />
                  </Field>
                  <Field label="说明" hint="列表摘要，不参与提示词注入">
                    <TextInput
                      value={item.description ?? ""}
                      onChange={(value) => edit(item.id, (target) => { target.description = value; })}
                      placeholder="这条上下文解决什么问题"
                    />
                  </Field>
                </FormGrid>
                <Field label="标签" hint="仅用于工作台内筛选，不参与提示词注入">
                  <div className="chip-list padded">
                    {tags.length
                      ? tags.map((tag) => <b key={tag}>
                        {tag}
                        <button
                          type="button"
                          aria-label={`移除标签 ${tag}`}
                          onClick={() => edit(item.id, (target) => { target.tags = (target.tags ?? []).filter((entry) => entry !== tag); })}
                        >×</button>
                      </b>)
                      : <span className="muted-text">还没有标签</span>}
                  </div>
                  <div className="inline-form">
                    <TextInput value={tagDraft} onChange={setTagDraft} placeholder="输入标签后点添加" />
                    <button type="button" className="ghost-action" onClick={() => {
                      const value = tagDraft.trim();
                      if (!value) return;
                      if (tags.includes(value)) { push("该标签已存在", "error"); return; }
                      edit(item.id, (target) => { target.tags = [...(target.tags ?? []), value]; });
                      setTagDraft("");
                      push(`已添加标签「${value}」`);
                    }}><Plus />添加</button>
                  </div>
                </Field>
              </div>}

              {over && <p className="inline-warning">
                <Warning />
                <span>内容超出参考预算。注意：参考预算<b>不参与服务端截断</b>，超出部分仍会原样进入提示词 —— 这里只是规划提示。</span>
              </p>}
              {item.enabled && item.scope === "workspace" && !item.content.trim() && <p className="detail-note">已启用且范围正确，但内容为空，实际不会注入任何提示词。</p>}
              {item.enabled && item.scope !== "workspace" && <p className="detail-note">范围不是「全工作台」，不会自动注入新任务，需要在运行时手动选用。</p>}
              {!item.enabled && <p className="detail-note">已停用：即使范围是全工作台也不会注入。</p>}
            </article>;
          })}</div>
          : <EmptyState
            icon={Brain}
            title="没有匹配的上下文"
            note="试着更换范围 / 类型 / 状态筛选，或清空搜索关键词。"
            action={<button type="button" className="ghost-action" onClick={() => { setQuery(""); setScope("all"); setKind("all"); setStatus("all"); }}>清除筛选</button>}
          />}
    </Card>

    <div className="split-grid">
      <Card
        icon={Sparkle}
        title="注入预览"
        note="把会注入的片段按当前顺序拼起来，等同于服务端 task_context() 的第一步"
        action={<button type="button" className="small-action action-btn" onClick={() => void copyPreview()}><Copy />复制预览</button>}
      >
        {injectable.length
          ? <div className="inject-preview">
            <div className="inject-order">
              {injectable.map((item, index) => <div key={item.id}>
                <span className="order-index">{String(index + 1).padStart(2, "0")}</span>
                <span>
                  <strong>{item.name || "未命名上下文"}</strong>
                  <small>{contextKind(item).label} · {item.content.length.toLocaleString("zh-CN")} 字</small>
                </span>
              </div>)}
            </div>
            <pre className="inject-body">{preview.length > 1400 ? `${preview.slice(0, 1400)}\n…（仅预览前 1400 字）` : preview}</pre>
            <KeyValueList rows={[
              { label: "片段数", value: `${injectable.length} 条` },
              { label: "合计字符", value: `${totalChars.toLocaleString("zh-CN")} 字` },
              { label: "估算 Token", value: `≈ ${Math.round(totalChars / 1.5).toLocaleString("zh-CN")}（粗估：1 token ≈ 1.5 字符）` },
              { label: "知识库补充", value: "命中关键词的文档最多 3 篇、每篇截断 4000 字" },
            ]} />
          </div>
          : <EmptyState
            icon={Warning}
            title="当前没有内容会被注入"
            note="启用一条范围是「全工作台」且内容非空的上下文后，这里会显示真正拼进提示词的文本。"
          />}
      </Card>

      <Card icon={ShieldCheck} title="范围语义" note="决定「何时被使用」，与「是否启用」是两个独立开关">
        <ul className="scope-list">
          <li>
            <Pill tone="ok">全工作台</Pill>
            <span><strong>自动注入</strong><small>每次新建任务都会带上（需同时满足已启用、内容非空）。</small></span>
          </li>
          <li>
            <Pill tone="neutral">按任务选择</Pill>
            <span><strong>手动选用</strong><small>不自动注入，由操作者在发起任务时选择。</small></span>
          </li>
          <li>
            <Pill tone="neutral">指定 Agent</Pill>
            <span><strong>按角色附加</strong><small>只在指定 Agent 执行时附加，不进入全局提示词。</small></span>
          </li>
        </ul>
        <p className="page-note">
          <Warning /> 后端目前只实现了「全工作台」的自动注入：
          <code>WorkspaceService.task_context()</code> 只筛选 <code>enabled</code> 为真且
          <code>scope</code> 等于 <code>workspace</code> 的条目，另外两种范围只会作为配置意图保存在 SQLite 中。
        </p>
      </Card>
    </div>

    <ConfirmDialog
      open={Boolean(pendingDelete)}
      title="删除上下文"
      message={pendingDelete ? `「${pendingDelete.name || "未命名上下文"}」将从策略中移除，保存后不再注入新任务。` : ""}
      onConfirm={() => {
        if (!pendingDelete) return;
        update((draft) => { draft.contexts = draft.contexts.filter((entry) => entry.id !== pendingDelete.id); });
        push(`已删除「${pendingDelete.name || "未命名上下文"}」，记得保存更改`);
      }}
      onClose={() => setPendingDelete(null)}
    />
  </div>;
}

/* ------------------------------------------------------------ 模型与工具 */

function Models({ config, update }: PanelProps) {
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState("all");
  const [access, setAccess] = useState<"all" | "read" | "write">("all");

  const agentOptions = useMemo(() => Array.from(new Set(config.tools.flatMap((tool) => tool.allowed_agents ?? []))), [config.tools]);

  const filteredTools = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return config.tools.filter((tool) => {
      const name = tool.name ?? tool.tool ?? "";
      if (agent !== "all" && !(tool.allowed_agents ?? []).includes(agent)) return false;
      if (access !== "all" && (tool.access ?? "read") !== access) return false;
      if (!keyword) return true;
      return name.toLowerCase().includes(keyword)
        || (tool.description ?? "").toLowerCase().includes(keyword)
        || (tool.allowed_agents ?? []).some((item) => item.toLowerCase().includes(keyword));
    });
  }, [config.tools, query, agent, access]);

  const callRanking = useMemo(() => {
    const counts = new Map<string, number>();
    config.tools.forEach((tool) => counts.set(tool.name ?? tool.tool ?? "未命名", 0));
    return Array.from(counts.entries()).slice(0, 6).map(([label], index) => ({
      label,
      value: Math.max(6, 60 - index * 8),
      tone: ["#2f6b4f", "#4f8a67", "#6fa87f", "#8fbd92", "#a8cf7a", "#c3d98f"][index],
    }));
  }, [config.tools]);

  const routeColumns: Array<Column<ModelRoute>> = [
    {
      key: "name",
      header: "路由",
      sortValue: (row) => row.name,
      render: (row) => <span className="cell-title"><strong>{row.name}</strong><small className="mono">{row.provider} / {row.model}</small></span>,
    },
    {
      key: "provider",
      header: "Provider",
      secondary: true,
      sortValue: (row) => row.provider,
      render: (row) => <Pill tone={row.provider === "local" ? "info" : "ok"}>{row.provider === "local" ? "本地回退" : row.provider === "runtime" ? "环境配置" : row.provider}</Pill>,
    },
    {
      key: "enabled",
      header: "启用",
      align: "right",
      render: (row) => <div className="row-actions">
        <Switch checked={row.enabled} label={`启用 ${row.name}`} onChange={(value) => update((draft) => { const target = draft.model_routes.find((item) => item.id === row.id); if (target) target.enabled = value; })} />
      </div>,
    },
    {
      key: "actions",
      header: "操作",
      align: "right",
      render: (row) => <RowActions>
        <IconButton
          icon={Trash}
          label="删除路由"
          tone="danger"
          disabled={config.model_routes.length <= 1}
          onClick={() => update((draft) => { draft.model_routes = draft.model_routes.filter((item) => item.id !== row.id); })}
        />
      </RowActions>,
    },
  ];

  return <div className="stack">
    <div className="split-grid">
      <Card
        icon={GearSix}
        title="模型路由"
        note="按用途配置主模型与回退链；实际生效的 Provider 以运行环境页为准"
        count={config.model_routes.length}
        action={<button type="button" className="small-action action-btn" onClick={() => update((draft) => {
          draft.model_routes.push({ id: crypto.randomUUID(), name: `路由 ${draft.model_routes.length + 1}`, provider: "local", model: "structured-rules", enabled: false });
        })}><Plus />新增路由</button>}
      >
        <DataTable<ModelRoute>
          columns={routeColumns}
          rows={config.model_routes}
          rowKey={(row) => row.id}
          pageSize={6}
          emptyTitle="还没有模型路由"
          emptyNote="至少保留一条路由，否则任务无法选择推理通道。"
        />
      </Card>

      <Card icon={Gauge} title="工具调用分布" note="示例分布，接入审计数据后可替换为真实调用量">
        <RankList items={callRanking} unit=" 次" />
      </Card>
    </div>

    <Card
      icon={Wrench}
      title="工具权限"
      note="每个工具绑定允许调用的 Agent，越权会抛 ToolPermissionError 并写入审计"
      count={filteredTools.length}
      toolbar={<Toolbar>
        <SearchField value={query} onChange={setQuery} placeholder="搜索工具名称或说明" />
        <div className="toolbar-filters">
          <SelectInput
            value={agent}
            onChange={setAgent}
            options={[{ value: "all", label: "全部 Agent" }, ...agentOptions.map((item) => ({ value: item, label: agentLabels[item] ?? item }))]}
          />
          <FilterChips<"all" | "read" | "write">
            value={access}
            onChange={setAccess}
            options={[
              { id: "all", label: "全部权限" },
              { id: "read", label: "只读" },
              { id: "write", label: "写入" },
            ]}
          />
        </div>
      </Toolbar>}
    >
      {filteredTools.length
        ? <div className="tool-registry padded">{filteredTools.map((tool, index) => <div key={`${tool.name ?? tool.tool}-${index}`}>
          <Wrench />
          <span><strong>{tool.name ?? tool.tool}</strong><small>{tool.description ?? "运行时注册工具"}</small><small>允许：{(tool.allowed_agents ?? []).map((item) => agentLabels[item] ?? item).join("、") || "系统授权"}</small></span>
          <b className={tool.access === "write" ? "write" : ""}>{tool.access === "write" ? "写入" : "只读"}</b>
        </div>)}</div>
        : <EmptyState icon={Wrench} title="没有匹配的工具" note="试着更换 Agent 或权限筛选。" action={<button type="button" className="ghost-action" onClick={() => { setQuery(""); setAgent("all"); setAccess("all"); }}>清除筛选</button>} />}
    </Card>
  </div>;
}

/* -------------------------------------------------------------- 治理策略 */

function Governance({ config, update }: PanelProps) {
  const [saved, setSaved] = useState(false);
  const maxSteps = Number(config.policies.max_steps ?? 12);
  const timeout = Number(config.policies.timeout_seconds ?? 45);
  const stepsError = maxSteps < 3 || maxSteps > 30 ? "需在 3–30 之间" : undefined;
  const timeoutError = timeout < 5 || timeout > 180 ? "需在 5–180 秒之间" : undefined;
  const approvalOn = Boolean(config.policies.approval_for_high_risk);

  const forced = [
    ["approval_for_high_risk", "高风险人工审批", "发布、部署、删除等动作必须暂停并等待负责人批准；由 LangGraph interrupt 实现，可在治理策略中关闭"],
    ["tool_audit", "工具调用审计", "记录工具、调用 Agent、访问级别和结果，写入 tool_trace"],
    ["block_private_networks", "拦截私有网络", "禁止研究工具访问本机、内网和保留地址（SSRF 防护）"],
  ] as const;

  return <div className="stack">
    <div className="split-grid">
      <Card icon={ShieldCheck} title="安全与审批" note="前两项由运行时强制执行，可通过开关调整；拦截私有网络不可关闭">
        {forced.map(([key, title, note]) => <SwitchRow
          key={key}
          title={title}
          note={note}
          checked={Boolean(config.policies[key])}
          disabled={key === "block_private_networks"}
          onChange={(value) => { update((draft) => { draft.policies[key] = value; }); setSaved(false); }}
        />)}
        <p className="page-note"><Warning /> 关闭「高风险人工审批」后，发布类任务将直接进入受控执行，请谨慎操作。</p>
      </Card>

      <Card icon={GearSix} title="运行限制" note="作为新任务可申请的上限，防止失控循环；保存后立即对后续任务生效">
        <FormGrid columns={2}>
          <Field label="最大调度步数" error={stepsError} hint={stepsError ? undefined : "建议 8–16 步"}>
            <TextInput
              value={String(config.policies.max_steps ?? 12)}
              invalid={Boolean(stepsError)}
              onChange={(value) => { update((draft) => { draft.policies.max_steps = Number(value) || 0; }); setSaved(false); }}
            />
          </Field>
          <Field label="任务超时（秒）" error={timeoutError} hint={timeoutError ? undefined : "超过后会进入 needs_human"}>
            <TextInput
              value={String(config.policies.timeout_seconds ?? 45)}
              invalid={Boolean(timeoutError)}
              onChange={(value) => { update((draft) => { draft.policies.timeout_seconds = Number(value) || 0; }); setSaved(false); }}
            />
          </Field>
        </FormGrid>
        <KeyValueList rows={[
          { label: "对后续任务的影响", value: `新任务最多 ${maxSteps} 步、${timeout} 秒` },
          { label: "审批门禁", value: approvalOn ? "高风险任务需要人工放行" : "已关闭，高风险任务直接执行" },
          { label: "停止条件", value: "达到步数上限、超时或 Supervisor 判定完成" },
        ]} />
        <div className="detail-actions">
          <button type="button" className="ghost-action" onClick={() => {
            update((draft) => { draft.policies.max_steps = 12; draft.policies.timeout_seconds = 45; });
            setSaved(false);
          }}>恢复推荐值</button>
          <button
            type="button"
            className="primary-action action-btn"
            disabled={Boolean(stepsError || timeoutError) || saved}
            onClick={() => setSaved(true)}
          >{saved ? "已确认" : "确认限制"}</button>
        </div>
      </Card>
    </div>

    <Card icon={ShieldCheck} title="策略快照" note="当前保存到 SQLite 的治理策略原文，便于比对与导出">
      {config.policies && Object.keys(config.policies).length
        ? <dl className="kv-list padded">{Object.entries(config.policies).map(([key, value]) => <div key={key}>
          <dt className="mono">{key}</dt>
          <dd>{typeof value === "boolean" ? (value ? "已启用" : "未启用") : String(value)}</dd>
        </div>)}</dl>
        : <EmptyState icon={ShieldCheck} title="没有策略项" note="恢复默认配置可写回系统内置的治理策略。" />}
    </Card>
  </div>;
}

/* ------------------------------------------------------------------ 公共件 */

type PanelProps = { config: WorkspaceConfig; update: (mutator: (draft: WorkspaceConfig) => void) => void };

/* Module scope keeps the memo wrappers referentially stable across renders. */
const MemoOverview = memo(Overview);
const MemoAgents = memo(Agents);
const MemoRag = memo(Rag);
const MemoContexts = memo(Contexts);
const MemoModels = memo(Models);
const MemoGovernance = memo(Governance);

function Node({ title, note, primary }: { title: string; note: string; primary?: boolean }) { return <div className={primary ? "primary-node" : ""}><strong>{title}</strong><small>{note}</small></div>; }
function Status({ label, enabled }: { label: string; enabled: boolean }) { return <div className="status-row"><span><i className={enabled ? "ok" : ""} />{label}</span><b>{enabled ? "已启用" : "未启用"}</b></div>; }
