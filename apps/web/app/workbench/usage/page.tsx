"use client";

import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { ChartBar } from "@phosphor-icons/react/dist/csr/ChartBar";
import { DownloadSimple } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { Gauge } from "@phosphor-icons/react/dist/csr/Gauge";
import { Robot } from "@phosphor-icons/react/dist/csr/Robot";
import { Stack } from "@phosphor-icons/react/dist/csr/Stack";
import { useCallback, useEffect, useState } from "react";
import { WorkspacePage } from "../ui/shell";
import {
  Card, EmptyState, ErrorState, KeyValueList, LoadingState, StatStrip, Toolbar, useNotice,
} from "../ui/primitives";
import { BarChart, DonutChart, RankList } from "../ui/charts";
import { loadResource, peekCache } from "../resource-cache";
import { apiFetch, toErrorMessage } from "../../auth/api";
import { compactNumber, formatNumber } from "../ui/data";

const API_URL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";
const KEY = "usage";

type LabelValue = { label: string; value: number };

type Usage = {
  collected: boolean;
  provider: string;
  totals: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  by_role: LabelValue[];
  by_day: Array<{ label: string; tokens: number }>;
  runs: { tasks: number; steps: number; tool_calls: number };
  note: string;
};

const roleLabels: Record<string, string> = {
  intake: "任务理解",
  planner: "任务规划",
  supervisor: "任务监督",
  research: "研究与证据",
  data: "数据分析",
  code: "软件工程",
  document: "交付物编排",
  review: "独立审查",
};

function providerLabel(provider: string) {
  if (!provider) return "未知";
  if (provider.startsWith("local")) return "本地规则推理";
  if (provider.endsWith("-with-fallback")) return "远程 + 本地回退";
  if (provider.startsWith("openai")) return "OpenAI Responses";
  return provider;
}

/* Token 用量: 数据来自 /api/usage。只有推理服务真的上报 usage 时才有 Token 数值；
   本地规则推理不上报，此时图表为空并且原样展示后端 note —— 运行量（任务 / 步骤 /
   工具调用）始终来自真实任务记录，不补随机数、不算没有依据的费用。 */
export default function UsagePage() {
  const { notice, push, clear } = useNotice();
  const [data, setData] = useState<Usage | null>(() => peekCache<Usage>(KEY) ?? null);
  const [loaded, setLoaded] = useState(() => Boolean(peekCache<Usage>(KEY)));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  /* 返回错误信息（成功则为空串）：刷新失败而手里还有旧数据时，用提示条告知而不是静默显示旧值。 */
  const load = useCallback(async (force = false) => {
    try {
      const payload = await loadResource(KEY, async () => {
        const response = await apiFetch(`${API_URL}/api/usage`);
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(toErrorMessage(body, "无法读取用量数据"));
        return body as Usage;
      }, { ttlMs: 5_000, force });
      setData(payload);
      setError("");
      return "";
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "无法读取用量数据，请确认 Agent API 已启动。";
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
    push(message || "用量数据已刷新", message ? "error" : "info");
  }, [load, push]);

  function exportCsv() {
    if (!data) return;
    const header = "日期,Token\n";
    const body = data.by_day.map((item) => `${item.label},${item.tokens}`).join("\n");
    const blob = new Blob([`\uFEFF${header}${body}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "neptune-token-usage.csv";
    anchor.click();
    URL.revokeObjectURL(url);
    push(`已导出最近 ${data.by_day.length} 天用量明细 CSV`);
  }

  function body() {
    if (!loaded) return <LoadingState label="正在读取用量数据…" />;
    if (!data) return <ErrorState message={error || "未读取到用量数据"} onRetry={() => void refresh()} />;

    const { totals, runs } = data;
    const metrics = [
      {
        label: "总 Token",
        value: compactNumber(totals.total_tokens),
        note: `${formatNumber(totals.total_tokens)} tokens`,
        icon: Stack,
      },
      {
        label: "输入 / 输出",
        value: `${compactNumber(totals.prompt_tokens)} / ${compactNumber(totals.completion_tokens)}`,
        note: totals.total_tokens
          ? `输出占比 ${Math.round((totals.completion_tokens / totals.total_tokens) * 100)}%`
          : "当前 Provider 未上报用量",
        icon: ChartBar,
      },
      {
        label: "推理 Provider",
        value: providerLabel(data.provider),
        note: data.collected ? "已上报 token 用量" : "不上报 token 用量",
        icon: Robot,
      },
      {
        label: "运行量",
        value: formatNumber(runs.tasks),
        note: `${formatNumber(runs.steps)} 个步骤 · ${formatNumber(runs.tool_calls)} 次工具调用`,
        icon: Gauge,
      },
    ];

    return <>
      {data.note && <EmptyState title="用量口径说明" note={data.note} />}

      <Toolbar>
        <span className="toolbar-hint">
          统计窗口固定为最近 7 天（后端按天聚合）；Token 只有推理服务上报 usage 时才会计入。
        </span>
      </Toolbar>

      <StatStrip items={metrics} />

      <Card icon={ChartBar} title="每日 Token" note="单位：tokens · 按任务更新时间归集到天">
        {data.by_day.some((item) => item.tokens > 0)
          ? <BarChart data={data.by_day.map((item) => ({ label: item.label, value: item.tokens }))} formatValue={(value) => compactNumber(value)} />
          : <EmptyState title="暂无 Token 用量" note={data.note || "推理服务尚未上报任何用量记录。"} />}
      </Card>

      <div className="split-grid">
        <Card icon={Stack} title="Token 角色分布" note="按推理时声明的角色归集" count={totals.total_tokens}>
          {data.by_role.length
            ? <DonutChart
              centerLabel="总 Token"
              centerValue={compactNumber(totals.total_tokens)}
              segments={data.by_role.map((item, index) => ({
                label: roleLabels[item.label] ?? item.label,
                value: item.value,
                tone: ["#2f6b4f", "#a8cf7a", "#6fa87f", "#d8c56a", "#c98b5e", "#8c9aa3"][index % 6],
              }))}
            />
            : <EmptyState title="暂无角色分布" note={data.note || "推理服务上报用量后这里会按角色拆解。"} />}
        </Card>

        <Card icon={Gauge} title="Token 排行" note="按角色累计 Token 排序">
          {data.by_role.length
            ? <RankList
              items={data.by_role.map((item, index) => ({
                label: roleLabels[item.label] ?? item.label,
                value: item.value,
                tone: ["#2f6b4f", "#4f8a67", "#6fa87f", "#8fbd92", "#a8cf7a", "#c3d98f"][index % 6],
              }))}
              formatValue={(value) => compactNumber(value)}
              unit=" tokens"
            />
            : <EmptyState title="暂无 Token 数据" note={data.note || "还没有可用于排行的用量记录。"} />}
        </Card>
      </div>

      <Card icon={Robot} title="运行量" note="即使没有 Token 上报，这一组指标也来自真实记录">
        <KeyValueList rows={[
          { label: "任务数", value: `${formatNumber(runs.tasks)} 个` },
          { label: "计划步骤", value: `${formatNumber(runs.steps)} 步` },
          { label: "工具调用", value: `${formatNumber(runs.tool_calls)} 次` },
          { label: "每任务平均步骤", value: runs.tasks ? (runs.steps / runs.tasks).toFixed(1) : "—" },
          { label: "推理 Provider", value: providerLabel(data.provider) },
          { label: "用量采集", value: data.collected ? "已采集" : "未采集" },
        ]} />
      </Card>

      <Card icon={Gauge} title="计量口径" note="明确说清哪些是真的、哪些还没采集">
        <div className="padded-block">
          <KeyValueList rows={[
            { label: "Token 来源", value: "任务产物中推理环节上报的 usage 字段" },
            { label: "采集条件", value: "仅当推理服务返回 usage 时计入，本地规则推理为 0" },
            { label: "统计窗口", value: "最近 7 天，按任务更新时间归集" },
            { label: "运行量来源", value: "任务表、计划步骤与工具调用轨迹" },
            { label: "费用折算", value: "后端未提供价格表，页面不做金额估算" },
          ]} />
          <p className="page-note">
            扩展点：接入带价格表的用量账单后，可以在这里补 By Model 维度、月度预算与超支告警；在此之前不展示任何估算金额。
          </p>
        </div>
      </Card>
    </>;
  }

  return <WorkspacePage
    active="usage"
    note="按天、按角色拆解 Token 消耗，并给出真实任务运行量。Token 只有在推理 Provider 上报 usage 时才会计入。"
    notice={notice}
    onDismissNotice={clear}
    actions={<>
      <button type="button" onClick={() => void refresh()} disabled={refreshing}>
        <ArrowsClockwise className={refreshing ? "spin" : undefined} />{refreshing ? "刷新中…" : "刷新用量"}
      </button>
      <button type="button" className="save action-btn" onClick={exportCsv} disabled={!data}>
        <DownloadSimple />导出 CSV
      </button>
    </>}
  >
    {body()}
  </WorkspacePage>;
}
