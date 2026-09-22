"use client";

import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { Database } from "@phosphor-icons/react/dist/csr/Database";
import { Gear } from "@phosphor-icons/react/dist/csr/Gear";
import { Path } from "@phosphor-icons/react/dist/csr/Path";
import { ShareNetwork } from "@phosphor-icons/react/dist/csr/ShareNetwork";
import { SidebarSimple } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { Sparkle } from "@phosphor-icons/react/dist/csr/Sparkle";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../workbench.css";
import "../sidebar.css";
import "../../workspace-layout.css";
import { apiFetch } from "../../auth/api";
import { loadResource, peekCache, primeCache } from "../resource-cache";
import { WorkbenchSidebar, findGroupLabel, findSectionLabel } from "../workbench-sidebar";
import { TaskComposer } from "./composer";
import { EngineModal, type Engine } from "./engine-modal";
import { SessionsPanel } from "./sessions";
import {
  AUTO_AGENT,
  Task,
  TaskStatus,
  agentLabels,
  formatUpdatedAt,
  knowledgeSummary,
  matchesStatusFilter,
  statusText,
  statusTone,
  typeText,
} from "./shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";
const TASKS_KEY = "task-list";
const ENGINE_KEY = "nexus.engine";
const HIDDEN_KEY = "nexus.hiddenSessions";

type Capability = { agent: string; title: string; task_types: string[]; order: number };
type WorkspaceConfig = {
  agents: Array<{ id: string; name: string; enabled: boolean }>;
  knowledge_bases: Array<{ id: string; name: string; enabled: boolean; documents?: unknown[] }>;
};
type SystemInfo = { capabilities: Capability[] };

/* 对话分组：同一 conversation_id 的多轮运行合成一段对话；
   老数据没有 conversation_id，就各自成一条，不会被硬凑到一起。 */
function conversationOf(task: Task): string {
  return task.conversation_id || task.task_id;
}

/* 多轮上下文：把当前对话最近几轮压成一段文字带给下一次运行，
   后端只认 `context` 字段，所以"连续追问"是真生效而不是界面假象。 */
function transcriptOf(tasks: Task[]): string {
  return tasks
    .slice(-4)
    .map((task) => `用户：${task.objective}\n助手：${(task.final_response ?? "（未产出结论）").slice(0, 400)}`)
    .join("\n\n");
}

export default function RuntimePage() {
  const [tasks, setTasks] = useState<Task[]>(() => peekCache<Task[]>(TASKS_KEY) ?? []);
  const [active, setActive] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(() => (peekCache<Task[]>(TASKS_KEY)?.length ?? 0) > 0);
  const [connected, setConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TaskStatus>("all");
  const [hidden, setHidden] = useState<string[]>([]);
  const [listOpen, setListOpen] = useState(true);

  const [objective, setObjective] = useState("");
  const [context, setContext] = useState("");
  const [fileName, setFileName] = useState("");
  const [mode, setMode] = useState<Engine>("auto");
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shared, setShared] = useState(false);

  // 运行控制：运行 Agent + 调用方式（是否检索知识库）
  const [agent, setAgent] = useState<string>(AUTO_AGENT);
  const [useKnowledgeBase, setUseKnowledgeBase] = useState(true);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);

  const logRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (force = false) => {
    try {
      const data = await loadResource(
        TASKS_KEY,
        async () => {
          const response = await apiFetch(`${API_URL}/api/tasks`);
          if (!response.ok) throw new Error();
          return (await response.json()) as Task[];
        },
        { ttlMs: 1_500, force },
      );
      setTasks(data);
      setConnected(true);
      setError("");
    } catch {
      setConnected(false);
      setError("无法连接 Agent API，请确认后端已启动。");
    } finally {
      setLoaded(true);
    }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }, [load]);

  useEffect(() => { void load(); }, [load]);

  // 每次进入运行中心都展示模式说明；上次选过的模式仍然读出来作为本次默认值。
  useEffect(() => {
    const saved = window.localStorage.getItem(ENGINE_KEY);
    if (saved === "auto" || saved === "plan_only") setMode(saved);
    setModalOpen(true);
    try {
      const raw = window.localStorage.getItem(HIDDEN_KEY);
      if (raw) setHidden(JSON.parse(raw) as string[]);
    } catch { /* ignore malformed local state */ }
  }, []);

  // 运行 Agent 候选来自能力注册表；禁用状态来自工作台配置，避免把禁用的 Agent 摆出来。
  useEffect(() => {
    void (async () => {
      try {
        const info = await loadResource<SystemInfo>("system-info", async () => {
          const response = await apiFetch(`${API_URL}/api/system`);
          if (!response.ok) throw new Error();
          return (await response.json()) as SystemInfo;
        });
        setCapabilities(info.capabilities);
      } catch { /* 保留空列表：只显示"自动编排" */ }
      try {
        const config = await loadResource<WorkspaceConfig>("workspace-config", async () => {
          const response = await apiFetch(`${API_URL}/api/workspace`);
          if (!response.ok) throw new Error();
          return (await response.json()) as WorkspaceConfig;
        });
        setWorkspace(config);
      } catch { /* 未配置时不影响对话 */ }
    })();
  }, []);

  const conversations = useMemo(() => {
    const grouped = new Map<string, Task[]>();
    for (const task of tasks) {
      const key = conversationOf(task);
      if (hidden.includes(key)) continue;
      grouped.set(key, [...(grouped.get(key) ?? []), task]);
    }
    return [...grouped.entries()]
      .map(([id, items]) => ({
        id,
        tasks: items,
        latest: items[items.length - 1],
      }))
      .sort((left, right) => (right.latest.updated_at ?? "").localeCompare(left.latest.updated_at ?? ""));
  }, [tasks, hidden]);

  // 首次拿到数据时自动选中最近一段对话
  useEffect(() => {
    if (active || !conversations.length) return;
    setActive(conversations[0].id);
  }, [active, conversations]);

  const current = useMemo(
    () => conversations.find((item) => item.id === active) ?? null,
    [conversations, active],
  );

  // 新消息进来后把对话滚到底部（只滚日志容器，不滚整页）
  useEffect(() => {
    const node = logRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [current?.tasks.length, current?.latest?.updated_at]);

  const visibleList = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return conversations
      .map((item) => item.latest)
      .filter((task) => {
        if (!matchesStatusFilter(task, filter)) return false;
        if (!keyword) return true;
        return (
          task.objective.toLowerCase().includes(keyword) ||
          task.task_id.toLowerCase().includes(keyword)
        );
      });
  }, [conversations, query, filter]);

  const enabledBases = (workspace?.knowledge_bases ?? []).filter((base) => base.enabled);
  const documentCount = enabledBases.reduce(
    (total, base) => total + (Array.isArray(base.documents) ? base.documents.length : 0),
    0,
  );
  const disabledAgents = new Set(
    (workspace?.agents ?? []).filter((item) => !item.enabled).map((item) => item.id),
  );

  function closeConversation(taskId: string) {
    const task = tasks.find((item) => item.task_id === taskId);
    const conversationId = task ? conversationOf(task) : taskId;
    setHidden((state) => {
      const next = Array.from(new Set([...state, conversationId]));
      window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
      return next;
    });
    setActive((state) => (state === conversationId ? null : state));
  }

  function restoreConversations() {
    setHidden([]);
    window.localStorage.removeItem(HIDDEN_KEY);
  }

  function startNewConversation() {
    setActive(null);
    setObjective("");
    setContext("");
    setFileName("");
    document.getElementById("task-objective")?.focus();
  }

  /* 分享的是"这次运行的步骤页"——它自带完整链路，比分享一个空壳对话页有用。 */
  async function shareConversation() {
    const url = current
      ? `${window.location.origin}/workbench/runtime/${current.latest.task_id}`
      : `${window.location.origin}/workbench/runtime`;
    try {
      await navigator.clipboard.writeText(url);
      setShared(true);
      window.setTimeout(() => setShared(false), 2_000);
    } catch {
      setError("复制链接失败，请手动复制地址栏。");
    }
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const text = objective.trim();
    if (text.length < 3) return;
    setBusy(true);
    setError("");
    const conversationId = active ?? `conv-${Date.now().toString(36)}`;
    const history = current ? transcriptOf(current.tasks) : "";
    try {
      const response = await apiFetch(`${API_URL}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          objective: text,
          context: [context, history].filter(Boolean).join("\n\n"),
          execution_mode: mode,
          agent,
          use_knowledge_base: useKnowledgeBase,
          conversation_id: conversationId,
        }),
      });
      if (!response.ok) throw new Error();
      const created = (await response.json()) as Task;
      setTasks((state) => {
        const next = [...state, created];
        primeCache(TASKS_KEY, next);
        return next;
      });
      setActive(conversationId);
      setObjective("");
      setContext("");
      setFileName("");
      await refresh();
    } catch {
      setError("消息发送失败，请检查 API 后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function decide(taskId: string, decision: "approve" | "reject") {
    setBusy(true);
    try {
      const response = await apiFetch(`${API_URL}/api/tasks/${taskId}/approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          approver_id: "workspace-owner",
          note: "已核对任务计划与风险",
        }),
      });
      if (!response.ok) throw new Error();
      await refresh();
    } catch {
      setError("审批失败，请刷新后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function loadFile(file?: File) {
    if (!file) return;
    if (file.size > 2_000_000) {
      setError("文件超过 2 MB，请缩小后再上传。");
      return;
    }
    setContext(await file.text());
    setFileName(file.name);
    setError("");
  }

  function chooseEngine(engine: Engine) {
    setMode(engine);
    window.localStorage.setItem(ENGINE_KEY, engine);
  }

  const closeModal = useCallback(() => {
    window.localStorage.setItem(ENGINE_KEY, mode);
    setModalOpen(false);
  }, [mode]);

  const agentLabel = agent === AUTO_AGENT
    ? "自动编排"
    : agentLabels[agent] ?? capabilities.find((item) => item.agent === agent)?.title ?? agent;

  return <>
    <main className="control-shell">
      <WorkbenchSidebar active="runtime" />
      <section className="control-main">
        <header className="control-header">
          <div>
            <p>{findGroupLabel("runtime")} / {findSectionLabel("runtime")}</p>
            <h1>{current ? current.latest.objective : "Agent 编排助手"}</h1>
          </div>
          <div className="header-actions">
            <button type="button" className="sessions-toggle" onClick={() => setListOpen((value) => !value)}>
              <SidebarSimple />对话
            </button>
            <Link className="tool-btn" href="/workbench/system"><Path />运行环境</Link>
          </div>
        </header>

        {/* 复用 runtime-shell 的两栏栅格与窄屏抽屉行为（sessions-open），
            否则样式与响应式规则要再写一遍。 */}
        <div className={`runtime-shell ${listOpen ? "sessions-open" : ""}`}>
          <SessionsPanel
            tasks={visibleList}
            activeId={current?.latest.task_id ?? null}
            onSelect={(taskId) => {
              const task = tasks.find((item) => item.task_id === taskId);
              if (task) setActive(conversationOf(task));
            }}
            onClose={closeConversation}
            hiddenCount={hidden.length}
            onRestore={restoreConversations}
            loading={!loaded}
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            query={query}
            onQueryChange={setQuery}
            filter={filter}
            onFilterChange={setFilter}
            onCreate={startNewConversation}
            error={connected ? "" : error}
            onRetry={() => void refresh()}
          />

          <section className="chat-main">
            <div className="chat-toolbar">
              <label className="chat-control">
                <span>运行 Agent</span>
                <select value={agent} onChange={(event) => setAgent(event.target.value)}>
                  <option value={AUTO_AGENT}>自动编排（Supervisor 组队）</option>
                  {capabilities.map((item) => <option key={item.agent} value={item.agent}>
                    {item.title}{disabledAgents.has(item.agent) ? "（已禁用，会回退）" : ""}
                  </option>)}
                </select>
              </label>

              <label className="chat-control">
                <span>调用方式</span>
                <select
                  value={useKnowledgeBase ? "kb" : "free"}
                  onChange={(event) => setUseKnowledgeBase(event.target.value === "kb")}
                >
                  <option value="free">自由问答</option>
                  <option value="kb">知识库问答</option>
                </select>
              </label>

              <div className={`rag-tag ${useKnowledgeBase ? "on" : "off"}`}>
                <Database />
                {useKnowledgeBase
                  ? enabledBases.length
                    ? `RAG 已开启 · ${enabledBases.length} 个知识库 · ${documentCount} 篇文档`
                    : "RAG 已开启，但没有启用的知识库"
                  : "RAG 已关闭，不会检索知识库文档"}
              </div>

              <button type="button" className="tool-btn" onClick={() => setModalOpen(true)}>
                <Gear />模式说明
              </button>

              <button type="button" className="tool-btn" onClick={() => void shareConversation()}>
                {shared ? <Check /> : <ShareNetwork />}{shared ? "已复制" : "分享"}
              </button>

              <button type="button" className="tool-btn chat-new" onClick={startNewConversation}>
                <Sparkle />新建对话
              </button>
            </div>

            <div className="chat-log" ref={logRef}>
              {error && <div className="inline-error"><Warning /><span>{error}</span>
                <button type="button" onClick={() => void refresh()}>重试</button></div>}

              {!current && <div className="chat-empty">
                <Sparkle weight="fill" />
                <h2>从一个目标开始</h2>
                <p>
                  Supervisor 会先理解目标与风险，再从能力注册表里挑出合适的 Agent 协作完成。
                  运行 Agent 与调用方式可在上方切换；步骤、协作与工具调用在「查看步骤」里。
                </p>
              </div>}

              {current && current.tasks.map((task) => <Fragment key={task.task_id}>
                <article className="bubble user">
                  <div className="bubble-body">
                    <p>{task.objective}</p>
                    <small>
                      {formatUpdatedAt(task.updated_at)} · {task.execution_mode === "plan_only" ? "仅生成计划" : "自动执行"} ·
                      {" "}{task.requested_agent && task.requested_agent !== AUTO_AGENT
                        ? agentLabels[task.requested_agent] ?? task.requested_agent
                        : "自动组队"}
                    </small>
                  </div>
                </article>

                <article className={`bubble agent ${statusTone(task.status)}`}>
                  <div className="bubble-avatar"><Sparkle weight="fill" /></div>
                  <div className="bubble-body">
                    <header>
                      <strong>{statusText(task.status)}</strong>
                      <span>{task.plan.length} 个步骤 · {typeText(task.task_type)}</span>
                      <i className={`dot ${statusTone(task.status)}`} />
                    </header>

                    <p className="bubble-text">
                      {task.final_response
                        ?? (task.status === "running"
                          ? "正在调度，Agent 协作进行中…"
                          : "本次运行没有产出文字结论，可打开步骤查看细节。")}
                    </p>

                    {task.status === "awaiting_approval" && <div className="bubble-approval">
                      <Warning />
                      <span>高风险动作已暂停，等待你确认后才执行并回查。</span>
                      <button type="button" className="primary" disabled={busy} onClick={() => void decide(task.task_id, "approve")}>
                        <Check weight="bold" />批准执行
                      </button>
                      <button type="button" disabled={busy} onClick={() => void decide(task.task_id, "reject")}>拒绝</button>
                    </div>}

                    <footer>
                      <span className="bubble-rag"><Database />{knowledgeSummary(task.knowledge)}</span>
                      <Link className="bubble-link" href={`/workbench/runtime/${task.task_id}`}>
                        查看步骤<ArrowRight />
                      </Link>
                    </footer>
                  </div>
                </article>
              </Fragment>)}
            </div>

            <TaskComposer
              objective={objective}
              onObjectiveChange={setObjective}
              context={context}
              onContextChange={setContext}
              fileName={fileName}
              mode={mode}
              onModeChange={chooseEngine}
              busy={busy}
              onSubmit={(event) => void send(event)}
              onFile={(file) => void loadFile(file)}
              error=""
              hint={current
                ? `继续「${current.latest.objective.slice(0, 12)}…」这段对话 · ${agentLabel}`
                : `将开启新对话 · ${agentLabel}`}
              placeholder="输入消息，Enter 发送，Shift + Enter 换行"
            />
          </section>
        </div>
      </section>
    </main>

    <EngineModal
      open={modalOpen}
      value={mode}
      onSelect={chooseEngine}
      onEnter={closeModal}
      onClose={closeModal}
    />
  </>;
}
