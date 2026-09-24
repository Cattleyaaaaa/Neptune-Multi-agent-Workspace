"use client";

import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { ChartBar } from "@phosphor-icons/react/dist/csr/ChartBar";
import { ChartLineUp } from "@phosphor-icons/react/dist/csr/ChartLineUp";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Gauge } from "@phosphor-icons/react/dist/csr/Gauge";
import { Lightning } from "@phosphor-icons/react/dist/csr/Lightning";
import { Pulse } from "@phosphor-icons/react/dist/csr/Pulse";
import { Robot } from "@phosphor-icons/react/dist/csr/Robot";
import { WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { WorkspacePage } from "../ui/shell";
import {
  Card, EmptyState, ErrorState, FilterChips, KeyValueList, LoadingState, Pill, StatStrip, Toolbar, useNotice,
} from "../ui/primitives";
import { BarChart, DonutChart, LineChart, RankList } from "../ui/charts";
import { DataTable, type Column } from "../ui/table";
import { loadResource, peekCache } from "../resource-cache";
import { agentLabels, statusText } from "../runtime/shared";
import { apiFetch, toErrorMessage } from "../../auth/api";
import { formatDateTime, formatNumber } from "../ui/data";

const API_URL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";
const KEY = "observability";

type LabelValue = { label: string; value: number };
type ToolStat = { tool: string; calls: number; failed: number; access: string };
type RecentTask = { task_id: string; objective: string; status: string; phase: string; updated_at: string };

type Observability = {
  collected: boolean;
  totals: {
    tasks: number;
    completed: number;
    failed: number;
    needs_human: number;
    awaiting_approval: number;
    rejected: number;
    tool_calls: number;
    tool_failures: number;
    events: number;
  };
  success_rate: number;
  status_breakdown: LabelValue[];
  phase_breakdown: LabelValue[];
  tool_calls: ToolStat[];
  agent_activity: LabelValue[];
  daily: Array<{ label: string; tasks: number; events: number }>;
  recent: RecentTask[];
  note: string;
};

/* 状态徽标的语气。后端状态除了 statusMeta 里的几项还会有 failed，一起兜住。 */
const pillTones: Record<string, "neutral" | "ok" | "warn" | "danger" | "info"> = {
  completed: "ok",
  running: "info",
  planned: "neutral",
  awaiting_approval: "warn",
  rejected: "danger",
  needs_human: "danger",
  failed: "danger",
};

const statusColor: Record<string, string> = {
  completed: "#2f6b4f",
  running: "#6fa87f",
  planned: "#a8cf7a",
  awaiting_approval: "#d8c56a",
  rejected: "#c98b5e",
  needs_human: "#c98b5e",
  failed: "#c98b5e",
};

const phaseLabels: Record<string, string> = {
  intake: "接入理解",
  planning: "任务规划",
  dispatching: "派单调度",
  researching: "研究检索",
  analyzing: "数据分析",
  engineering: "软件工程",
  drafting: "交付起草",
  reviewing: "质量审查",
  executing: "受控执行",
  verifying: "结果核验",
  reacting: "ReAct 循环",
  rejected: "已拒绝",
};

const accessLabels: Record<string, string> = { read: "只读", write: "写入", admin: "管理" };

/* 可观测性: 全部指标来自 /api/observability 的真实运行记录 —— 任务状态、阶段、
   工具调用与事件按天聚合。后端没有采集的维度（时延、P95、告警等级）这里就
   不画，避免用随机数冒充真实数据。 */
export default function ObservabilityPage() {
  const { notice, push, clear } = useNotice();
  const [data, setData] = useState<Observability | null>(() => peekCache<Observability>(KEY) ?? null);
  const [loaded, setLoaded] = useState(() => Boolean(peekCache<Observability>(KEY)));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("all");

  /* 返回错误信息（成功则为空串）：刷新失败且手里还有旧数据时，用提示条告知而不是静默显示旧值。 */
  const load = useCallback(async (force = false) => {
    try {
      const payload = await loadResource(KEY, async () => {
        const response = await apiFetch(`${API_URL}/api/observability`);
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(toErrorMessage(body, "无法读取可观测性指标"));
        return body as Observability;
      }, { ttlMs: 5_000, force });
      setData(payload);
      setError("");
      return "";
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "无法读取可观测性指标，请确认 Agent API 已启动。";
      setError(message);
      return message;
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const message = await load(true);
    setRefreshing(false);
    push(message || "可观测性指标已刷新", message ? "error" : "info");
  }, [load, push]);

  const statusOptions = useMemo(() => {
    const seen = Array.from(new Set(data?.recent.map((item) => item.status) ?? []));
    return [{ id: "all", label: "全部" }, ...seen.map((item) => ({ id: item, label: statusText(item) }))];
  }, [data]);

  const recentRows = useMemo(
    () => (data?.recent ?? []).filter((row) => status === "all" || row.status === status),
    [data, status],
  );

  const recentCounts = useMemo(() => {
    const counts: Record<string, number> = { all: data?.recent.length ?? 0 };
    for (const row of data?.recent ?? []) counts[row.status] = (counts[row.status] ?? 0) + 1;
    return counts;
  }, [data]);

  const toolColumns: Array<Column<ToolStat>> = [
    {
      key: "tool",
      header: "工具",
      sortValue: (row) => row.tool,
      render: (row) => <span className="cell-title">
        <strong className="mono">{row.tool}</strong>
        <small>权限：{accessLabels[row.access] ?? (row.access || "未标注")}</small>
      </span>,
    },
    {
      key: "calls",
      header: "调用次数",
      align: "right",
      sortValue: (row) => row.calls,
      render: (row) => <strong>{formatNumber(row.calls)}</strong>,
    },
    {
      key: "failed",
      header: "失败",
      align: "right",
      sortValue: (row) => row.failed,
      render: (row) => <span className={row.failed ? "text-danger" : ""}>{row.failed}</span>,
    },
    {
      key: "rate",
      header: "失败率",
      align: "right",
      secondary: true,
      sortValue: (row) => row.failed / Math.max(row.calls, 1),
      render: (row) => {
        const rate = (row.failed / Math.max(row.calls, 1)) * 100;
        return <span className={`failure-rate ${rate > 1 ? "high" : ""}`}>{rate.toFixed(2)}%</span>;
      },
    },
  ];

  const recentColumns: Array<Column<RecentTask>> = [
    {
      key: "objective",
      header: "任务",
      sortValue: (row) => row.objective,
      render: (row) => <span className="cell-title">
        <strong>{row.objective || "（无目标描述）"}</strong>
        <small className="mono">{row.task_id}</small>
      </span>,
    },
    {
      key: "status",
      header: "状态",
      sortValue: (row) => statusText(row.status),
      render: (row) => <Pill tone={pillTones[row.status] ?? "neutral"}>{statusText(row.status)}</Pill>,
    },
    {
      key: "phase",
      header: "阶段",
      secondary: true,
      sortValue: (row) => phaseLabels[row.phase] ?? row.phase,
      render: (row) => phaseLabels[row.phase] ?? row.phase,
    },
    {
      key: "updated_at",
      header: "最近更新",
      align: "right",
      secondary: true,
      sortValue: (row) => row.updated_at,
      render: (row) => formatDateTime(row.updated_at),
    },
  ];

  /* 首屏用占位，数据到位后整体替换：避免把空数组和真实数值混在一起误导。 */
  function body() {
    if (!loaded) return <LoadingState label="正在读取可观测性指标…" />;
    if (!data) return <ErrorState message={error || "未读取到可观测性指标"} onRetry={() => void refresh()} />;

    const { totals } = data;
    const metrics = [
      { label: "任务总数", value: formatNumber(totals.tasks), note: `已完成 ${totals.completed} · 失败 ${totals.failed}`, icon: Lightning },
      { label: "任务成功率", value: `${Math.round(data.success_rate * 100)}%`, note: "按「已完成 / 任务总数」计算", icon: CheckCircle },
      { label: "工具调用", value: formatNumber(totals.tool_calls), note: `失败 ${totals.tool_failures} 次`, icon: Gauge },
      {
        label: "待处理",
        value: formatNumber(totals.needs_human + totals.awaiting_approval),
        note: `需人工 ${totals.needs_human} · 待审批 ${totals.awaiting_approval}`,
        icon: WarningCircle,
      },
    ];

    const statusSegments = data.status_breakdown.map((item) => ({
      label: statusText(item.label),
      value: item.value,
      tone: statusColor[item.label],
    }));

    return <>
      {data.note && <EmptyState title="尚无运行数据" note={data.note} />}

      <Toolbar>
        <span className="toolbar-hint">统计窗口固定为最近 7 天（后端按天聚合，暂无更长窗口的历史数据）</span>
      </Toolbar>

      <StatStrip items={metrics} />

      <Card icon={ChartLineUp} title="每日任务与事件量" note="两条曲线同一份按天聚合结果：任务更新量与事件流条数">
        <LineChart
          series={[
            { label: "任务", color: "#2f6b4f", points: data.daily.map((item) => item.tasks) },
            { label: "事件", color: "#6fa87f", points: data.daily.map((item) => item.events) },
          ]}
        />
      </Card>

      <div className="split-grid">
        <Card icon={ChartBar} title="任务状态分布" note="同一份任务集合按状态拆解" count={totals.tasks}>
          {statusSegments.length
            ? <DonutChart centerLabel="任务总数" centerValue={formatNumber(totals.tasks)} segments={statusSegments} />
            : <EmptyState title="暂无任务" note="运行第一个任务后这里会出现状态分布。" />}
        </Card>

        <Card icon={Pulse} title="执行阶段分布" note="任务最后一次停留的阶段">
          {data.phase_breakdown.length
            ? <BarChart data={data.phase_breakdown.map((item) => ({ label: phaseLabels[item.label] ?? item.label, value: item.value }))} />
            : <EmptyState title="暂无阶段数据" note="任务进入执行后才会写入阶段。" />}
        </Card>
      </div>

      <div className="split-grid">
        <Card icon={Gauge} title="工具调用排行" note="按累计调用次数排序，取前 8 个">
          {data.tool_calls.length
            ? <RankList
              items={data.tool_calls.slice(0, 8).map((item, index) => ({
                label: item.tool,
                value: item.calls,
                tone: ["#2f6b4f", "#4f8a67", "#6fa87f", "#8fbd92", "#a8cf7a", "#c3d98f"][index % 6],
              }))}
              unit=" 次"
            />
            : <EmptyState title="暂无工具调用记录" note="任务调用工具后这里会累计。" />}
        </Card>

        <Card icon={Robot} title="Agent 活跃度" note="按 agent_trace 中的执行次数统计">
          {data.agent_activity.length
            ? <RankList items={data.agent_activity.map((item, index) => ({
              label: agentLabels[item.label] ?? item.label,
              value: item.value,
              tone: ["#2f6b4f", "#6fa87f", "#a8cf7a", "#d8c56a", "#c98b5e", "#8c9aa3"][index % 6],
            }))} unit=" 次" />
            : <EmptyState title="暂无 Agent 执行记录" note="还没有任何 Agent 产生轨迹。" />}
        </Card>
      </div>

      <Card icon={Gauge} title="工具健康度" note="失败率超过 1% 会标红，优先排查" count={data.tool_calls.length}>
        <DataTable
          columns={toolColumns}
          rows={data.tool_calls}
          rowKey={(row) => row.tool}
          pageSize={6}
          emptyTitle="暂无工具调用记录"
          emptyNote="后端尚未记录任何工具调用。"
        />
      </Card>

      <Card
        icon={Lightning}
        title="最近任务"
        note="按最近更新时间排序，最多 8 条"
        count={recentRows.length}
        toolbar={<Toolbar>
          <FilterChips value={status} onChange={setStatus} options={statusOptions} counts={recentCounts} />
        </Toolbar>}
      >
        <DataTable
          columns={recentColumns}
          rows={recentRows}
          rowKey={(row) => row.task_id}
          pageSize={6}
          emptyTitle="暂无任务记录"
          emptyNote="在「运行中心」创建任务后，这里会显示最近的运行。"
        />
      </Card>

      <Card icon={ChartBar} title="运行健康摘要" note="以上指标同口径，均来自真实任务与事件流">
        <KeyValueList rows={[
          { label: "任务总数", value: `${formatNumber(totals.tasks)} 个` },
          { label: "已完成 / 失败", value: `${formatNumber(totals.completed)} / ${formatNumber(totals.failed)}` },
          { label: "已拒绝", value: `${formatNumber(totals.rejected)} 个` },
          { label: "工具调用 / 失败", value: `${formatNumber(totals.tool_calls)} / ${formatNumber(totals.tool_failures)}` },
          { label: "事件条数", value: `${formatNumber(totals.events)} 条` },
          { label: "下钻入口", value: <Link className="small-action" href="/workbench/audit">运行审计</Link> },
        ]} />
      </Card>

      <p className="page-note">
        扩展点：后端目前只按天聚合，因此不提供时延、P95 与告警等级等尚未采集的维度；后续若落库时序数据，可直接在此追加更多下钻。
      </p>
    </>;
  }

  return <WorkspacePage
    active="observability"
    note="从任务、工具与 Agent 三个层面观察系统健康度：运行量与成功率、状态与阶段分布、工具调用健康度，以及最近的任务。"
    notice={notice}
    onDismissNotice={clear}
    actions={<>
      <button type="button" onClick={() => void refresh()} disabled={refreshing}>
        <ArrowsClockwise className={refreshing ? "spin" : undefined} />{refreshing ? "刷新中…" : "刷新指标"}
      </button>
    </>}
  >
    {body()}
  </WorkspacePage>;
}
