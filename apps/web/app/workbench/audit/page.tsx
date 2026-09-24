"use client";

import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { ClipboardText } from "@phosphor-icons/react/dist/csr/ClipboardText";
import { DownloadSimple } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { FlowArrow } from "@phosphor-icons/react/dist/csr/FlowArrow";
import { Lightning } from "@phosphor-icons/react/dist/csr/Lightning";
import { Toolbox } from "@phosphor-icons/react/dist/csr/Toolbox";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { WorkspacePage } from "../ui/shell";
import {
  Card, EmptyState, FilterChips, LoadingState, SearchField, SegmentedControl,
  StatStrip, Toolbar, useNotice,
} from "../ui/primitives";
import { RankList } from "../ui/charts";
import { loadResource, peekCache } from "../resource-cache";
import { apiFetch } from "../../auth/api";
import { Task, agentLabels, statusText, statusTone } from "../runtime/shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";
const TASKS_KEY = "task-list";
const PAGE_SIZE = 8;

type Range = "all" | "24h" | "7d";
type CallStatus = "all" | "success" | "failed";

const rangeLabels: Record<Range, string> = {
  all: "全部时间",
  "24h": "近 24 小时",
  "7d": "近 7 天",
};

/* 运行审计: the cross-task view of what the agents actually did — every tool
   call and every handoff, gathered from the tasks the runtime already loads.
   时间范围按任务的 updated_at 过滤，因为事件流尚未提供独立的时间戳接口。 */
export default function AuditPage() {
  const { notice, push, clear } = useNotice();
  const [tasks, setTasks] = useState<Task[]>(() => peekCache<Task[]>(TASKS_KEY) ?? []);
  const [loaded, setLoaded] = useState(() => (peekCache<Task[]>(TASKS_KEY)?.length ?? 0) > 0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState("all");
  const [callStatus, setCallStatus] = useState<CallStatus>("all");
  const [range, setRange] = useState<Range>("all");
  const [callPage, setCallPage] = useState(1);
  const [handoffPage, setHandoffPage] = useState(1);

  const load = useCallback(async (force = false) => {
    try {
      const data = await loadResource(TASKS_KEY, async () => {
        const response = await apiFetch(`${API_URL}/api/tasks`);
        if (!response.ok) throw new Error();
        return (await response.json()) as Task[];
      }, { ttlMs: 2_000, force });
      setTasks(data);
      setError("");
    } catch {
      setError("无法读取任务审计数据，请确认 Agent API 已启动。");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
    push("审计数据已刷新", "info");
  }, [load, push]);

  /* 时间范围过滤：以任务最近一次更新时间为准。 */
  const scopedTasks = useMemo(() => {
    if (range === "all") return tasks;
    const cutoff = range === "24h" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    const now = tasks.reduce((latest, task) => {
      const at = task.updated_at ? new Date(task.updated_at).getTime() : 0;
      return Number.isNaN(at) ? latest : Math.max(latest, at);
    }, 0);
    if (!now) return tasks;
    return tasks.filter((task) => {
      const at = task.updated_at ? new Date(task.updated_at).getTime() : 0;
      return at && now - at <= cutoff;
    });
  }, [tasks, range]);

  const toolCalls = useMemo(() => scopedTasks.flatMap((task) => task.tool_trace.map((item) => ({
    tool: item.tool,
    agent: item.agent,
    access: item.access,
    status: item.status,
    summary: item.summary,
    task_id: task.task_id,
    objective: task.objective,
  }))), [scopedTasks]);

  const handoffs = useMemo(() => scopedTasks.flatMap((task) => task.agent_trace
    .filter((item) => item.handoff && item.handoff !== "end")
    .map((item) => ({
      from: item.role,
      to: item.handoff as string,
      summary: item.summary,
      task_id: task.task_id,
      objective: task.objective,
    }))), [scopedTasks]);

  const agents = useMemo(() => Array.from(new Set(toolCalls.map((item) => item.agent))), [toolCalls]);

  const visibleCalls = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return toolCalls.filter((item) => {
      if (agent !== "all" && item.agent !== agent) return false;
      if (callStatus !== "all" && item.status !== callStatus) return false;
      if (!keyword) return true;
      return item.tool.toLowerCase().includes(keyword)
        || item.objective.toLowerCase().includes(keyword)
        || item.task_id.toLowerCase().includes(keyword);
    });
  }, [toolCalls, agent, query, callStatus]);

  useEffect(() => { setCallPage(1); }, [query, agent, callStatus, range]);
  useEffect(() => { setHandoffPage(1); }, [range]);

  const callPages = Math.max(1, Math.ceil(visibleCalls.length / PAGE_SIZE));
  const handoffPages = Math.max(1, Math.ceil(handoffs.length / PAGE_SIZE));
  const pagedCalls = visibleCalls.slice((callPage - 1) * PAGE_SIZE, callPage * PAGE_SIZE);
  const pagedHandoffs = handoffs.slice((handoffPage - 1) * PAGE_SIZE, handoffPage * PAGE_SIZE);

  const callRanking = useMemo(() => {
    const counts = new Map<string, number>();
    toolCalls.forEach((item) => counts.set(item.agent, (counts.get(item.agent) ?? 0) + 1));
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, value], index) => ({
        label: agentLabels[label] ?? label,
        value,
        tone: ["#2f6b4f", "#4f8a67", "#6fa87f", "#8fbd92", "#a8cf7a", "#c3d98f"][index],
      }));
  }, [toolCalls]);

  const failures = toolCalls.filter((item) => item.status === "failed").length;

  const metrics = [
    { label: "任务总数", value: scopedTasks.length, note: rangeLabels[range], icon: ClipboardText },
    { label: "工具调用", value: toolCalls.length, note: `${failures} 次失败`, icon: Toolbox },
    { label: "协作记录", value: scopedTasks.reduce((sum, task) => sum + task.agent_trace.length, 0), note: "判断与交接全量留痕", icon: FlowArrow },
    { label: "待审批", value: scopedTasks.filter((task) => task.status === "awaiting_approval").length, note: "等待负责人放行", icon: Lightning },
  ];

  function exportCalls() {
    const header = "任务ID,工具,调用Agent,访问级别,结果,摘要\n";
    const body = visibleCalls.map((item) => [
      item.task_id,
      item.tool,
      agentLabels[item.agent] ?? item.agent,
      item.access,
      item.status === "failed" ? "失败" : "成功",
      `"${item.summary.replace(/"/g, "'")}"`,
    ].join(",")).join("\n");
    const blob = new Blob([`\uFEFF${header}${body}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "neptune-audit-tool-calls.csv";
    anchor.click();
    URL.revokeObjectURL(url);
    push(`已导出 ${visibleCalls.length} 条工具调用记录`);
  }

  return <WorkspacePage
    active="audit"
    note="汇总所有任务的工具调用与协作交接，用于回答「谁调用了什么、谁把任务交给了谁」。每条记录都可回溯到对应任务，可导出为 CSV 用于离线复核。"
    notice={notice}
    onDismissNotice={clear}
    actions={<>
      <button type="button" onClick={exportCalls} disabled={!visibleCalls.length}><DownloadSimple />导出 CSV</button>
      <button type="button" onClick={() => void refresh()} disabled={refreshing}><ArrowsClockwise className={refreshing ? "spin" : undefined} />{refreshing ? "刷新中…" : "刷新"}</button>
      <Link className="small-action action-btn" href="/workbench/runtime"><Lightning />运行中心</Link>
    </>}
  >
    {error && <div className="notice error" role="status"><Warning /><p>{error}</p></div>}

    <Toolbar>
      <SegmentedControl<Range>
        value={range}
        onChange={setRange}
        options={[
          { id: "all", label: "全部时间" },
          { id: "24h", label: "近 24 小时" },
          { id: "7d", label: "近 7 天" },
        ]}
      />
      <span className="toolbar-hint">按任务最近更新时间过滤，范围会影响下方全部统计</span>
    </Toolbar>

    <StatStrip items={metrics} />

    <Card icon={FlowArrow} title="调用分布" note="按调用 Agent 聚合的工具调用次数">
      {callRanking.length
        ? <RankList items={callRanking} unit=" 次" />
        : <EmptyState icon={Toolbox} title="暂无可统计的调用" note="在运行中心发起一个任务后，这里会显示工具调用的分布。" />}
    </Card>

    <Card
      icon={Toolbox}
      title="工具调用审计"
      note="每次调用都记录工具、调用 Agent、访问级别和结果"
      count={visibleCalls.length}
      toolbar={<>
        <div className="audit-bar">
          <SearchField value={query} onChange={setQuery} placeholder="搜索工具、任务目标或任务 ID" />
          <FilterChips<CallStatus>
            value={callStatus}
            onChange={setCallStatus}
            options={[
              { id: "all", label: "全部结果" },
              { id: "success", label: "成功" },
              { id: "failed", label: "失败" },
            ]}
            counts={{
              all: toolCalls.length,
              success: toolCalls.length - failures,
              failed: failures,
            }}
          />
        </div>
        {agents.length > 1 && <div className="audit-bar">
          <div className="task-filters">
            <button type="button" className={`filter-chip ${agent === "all" ? "active" : ""}`} onClick={() => setAgent("all")}>全部 Agent</button>
            {agents.map((item) => <button type="button" className={`filter-chip ${agent === item ? "active" : ""}`} key={item} onClick={() => setAgent(item)}>{agentLabels[item] ?? item}</button>)}
          </div>
        </div>}
      </>}
    >
      {!loaded
        ? <LoadingState label="正在读取审计数据…" />
        : visibleCalls.length
          ? <>
            <div className="audit-list">{pagedCalls.map((item, index) => (
              <Link className="audit-row" href={`/workbench/runtime#task=${item.task_id}`} key={`${item.tool}-${index}`}>
                <Toolbox weight="duotone" />
                <span>
                  <strong>{item.tool}</strong>
                  <small>{agentLabels[item.agent] ?? item.agent} · {item.access} · {item.task_id}</small>
                  <small>{item.summary}</small>
                </span>
                <b className={item.status === "failed" ? "failed" : ""}>{item.status === "failed" ? "失败" : "成功"}</b>
              </Link>
            ))}</div>
            {callPages > 1 && <div className="dt-foot">
              <span>第 {callPage} / {callPages} 页 · 共 {visibleCalls.length} 条</span>
              <div className="pager">
                <button type="button" aria-label="上一页" disabled={callPage <= 1} onClick={() => setCallPage((current) => current - 1)}>‹</button>
                <button type="button" aria-label="下一页" disabled={callPage >= callPages} onClick={() => setCallPage((current) => current + 1)}>›</button>
              </div>
            </div>}
          </>
          : <EmptyState
            icon={ClipboardText}
            title={toolCalls.length ? "没有匹配的调用记录" : "还没有工具调用记录"}
            note={toolCalls.length ? "试着更换 Agent、结果筛选或清空搜索关键词。" : "任务运行过程中产生的每次工具调用都会记录在这里。"}
            action={toolCalls.length
              ? <button type="button" className="ghost-action" onClick={() => { setQuery(""); setAgent("all"); setCallStatus("all"); }}>清除筛选</button>
              : <Link className="primary-action action-btn" href="/workbench/runtime"><Lightning />去运行中心</Link>}
          />}
    </Card>

    <Card
      icon={FlowArrow}
      title="协作交接"
      note="Supervisor 与专业 Agent 之间的任务交接"
      count={handoffs.length}
    >
      {!loaded
        ? <LoadingState label="正在读取协作记录…" />
        : handoffs.length
          ? <>
            <div className="audit-list">{pagedHandoffs.map((item, index) => (
              <Link className="audit-row" href={`/workbench/runtime#task=${item.task_id}`} key={`${item.task_id}-${index}`}>
                <FlowArrow weight="duotone" />
                <span>
                  <strong>{item.from} → {agentLabels[item.to] ?? item.to}</strong>
                  <small>{item.summary}</small>
                  <small>任务 {item.task_id} · {item.objective}</small>
                </span>
                <b className={`tone ${statusTone(scopedTasks.find((task) => task.task_id === item.task_id)?.status ?? "")}`}>{statusText(scopedTasks.find((task) => task.task_id === item.task_id)?.status ?? "")}</b>
              </Link>
            ))}</div>
            {handoffPages > 1 && <div className="dt-foot">
              <span>第 {handoffPage} / {handoffPages} 页 · 共 {handoffs.length} 条</span>
              <div className="pager">
                <button type="button" aria-label="上一页" disabled={handoffPage <= 1} onClick={() => setHandoffPage((current) => current - 1)}>‹</button>
                <button type="button" aria-label="下一页" disabled={handoffPage >= handoffPages} onClick={() => setHandoffPage((current) => current + 1)}>›</button>
              </div>
            </div>}
          </>
          : <EmptyState icon={Warning} title="还没有协作交接记录" note="任务进入 Agent 协作阶段后，这里会显示每次交接的来源与去向。" />}
    </Card>

    <p className="page-note">扩展点：接入服务端事件流后可做精确到秒的时间窗口筛选、按风险等级聚合，以及把审计记录直接关联到审批决策。</p>
  </WorkspacePage>;
}
