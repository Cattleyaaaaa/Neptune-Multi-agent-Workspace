"use client";

import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { ChartBar } from "@phosphor-icons/react/dist/csr/ChartBar";
import { ChartLineUp } from "@phosphor-icons/react/dist/csr/ChartLineUp";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Gauge } from "@phosphor-icons/react/dist/csr/Gauge";
import { Lightning } from "@phosphor-icons/react/dist/csr/Lightning";
import { Pulse } from "@phosphor-icons/react/dist/csr/Pulse";
import { Timer } from "@phosphor-icons/react/dist/csr/Timer";
import { WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { useMemo, useState } from "react";
import { WorkspacePage } from "../ui/shell";
import {
  Card, FilterChips, KeyValueList, Pill, SampleBanner, SegmentedControl,
  StatStrip, Toolbar, useNotice,
} from "../ui/primitives";
import { BarChart, HeatGrid, LineChart, RankList } from "../ui/charts";
import { DataTable, type Column } from "../ui/table";
import { formatDateTime, formatNumber, incidentSeeds, observabilityDays, observabilityHeat, observabilityHeatColumns, observabilityHeatRows, observabilityLatency, toolCallSeeds } from "../ui/data";

type Range = "7d" | "14d" | "30d";
type Level = "all" | "P2" | "P3" | "P4";

const rangeFactors: Record<Range, number> = { "7d": 1, "14d": 1.9, "30d": 3.9 };

const levelTone: Record<string, "danger" | "warn" | "info" | "neutral"> = {
  P2: "danger",
  P3: "warn",
  P4: "info",
};

/* 可观测性: 从任务、工具与推理三个层面回答「系统现在健康吗」。所有图表都基于同一
   份时间窗口数据，切换时间范围时指标、趋势、热力图会同步变化。 */
export default function ObservabilityPage() {
  const { notice, push, clear } = useNotice();
  const [range, setRange] = useState<Range>("7d");
  const [level, setLevel] = useState<Level>("all");

  const factor = rangeFactors[range];

  const metrics = useMemo(() => {
    const runs = Math.round(186 * factor);
    const success = Math.round(179 * factor);
    const avgLatency = 46 + (range === "30d" ? 7 : range === "14d" ? 3 : 0);
    const p95 = 112 + (range === "30d" ? 21 : range === "14d" ? 9 : 0);
    return [
      { label: "任务运行", value: runs, note: `${success} 次成功 · 成功率 ${Math.round((success / runs) * 100)}%`, icon: Lightning },
      { label: "平均时延", value: `${avgLatency}s`, note: `P95 ${p95}s`, icon: Timer },
      { label: "工具调用", value: Math.round(2210 * factor), note: "含失败重试", icon: Gauge },
      { label: "未恢复事件", value: Math.round(2 * (range === "7d" ? 1 : 2)), note: "P2 及以上需当日闭环", icon: WarningCircle },
    ];
  }, [range, factor]);

  const incidents = useMemo(
    () => incidentSeeds.filter((item) => level === "all" || item.level === level),
    [level],
  );

  const toolColumns: Array<Column<(typeof toolCallSeeds)[number]>> = [
    {
      key: "tool",
      header: "工具",
      sortValue: (row) => row.tool,
      render: (row) => <span className="cell-title"><strong className="mono">{row.tool}</strong><small>主要调用方：{row.agent}</small></span>,
    },
    {
      key: "calls",
      header: "调用次数",
      align: "right",
      sortValue: (row) => row.calls,
      render: (row) => <strong>{formatNumber(row.calls)}</strong>,
    },
    {
      key: "failures",
      header: "失败",
      align: "right",
      sortValue: (row) => row.failures,
      render: (row) => <span className={row.failures ? "text-danger" : ""}>{row.failures}</span>,
    },
    {
      key: "rate",
      header: "失败率",
      align: "right",
      secondary: true,
      sortValue: (row) => (row.failures / row.calls) * 100,
      render: (row) => <span className={`failure-rate ${row.failures / row.calls > 0.01 ? "high" : ""}`}>
        {((row.failures / row.calls) * 100).toFixed(2)}%
      </span>,
    },
    {
      key: "avgMs",
      header: "平均耗时",
      align: "right",
      secondary: true,
      sortValue: (row) => row.avgMs,
      render: (row) => `${row.avgMs} ms`,
    },
  ];

  return <WorkspacePage
    active="observability"
    note="从任务、工具与推理三个层面观察系统健康度：运行量与成功率、时延分布、负载热力图，以及需要跟进的异常事件。"
    notice={notice}
    onDismissNotice={clear}
    actions={<>
      <button type="button" onClick={() => push("指标已刷新（示例数据）", "info")}><ArrowsClockwise />刷新指标</button>
    </>}
  >
    <SampleBanner note="指标基于本地示例数据生成，未接入后端时序存储与真实告警通道。" />

    <Toolbar>
      <SegmentedControl<Range>
        value={range}
        onChange={setRange}
        options={[
          { id: "7d", label: "近 7 天" },
          { id: "14d", label: "近 14 天" },
          { id: "30d", label: "近 30 天" },
        ]}
      />
      <span className="toolbar-hint">时间范围会同步影响下方所有图表与指标卡</span>
    </Toolbar>

    <StatStrip items={metrics} />

    <Card icon={ChartBar} title="每日任务运行量" note={`单位：次 · 近 ${range === "7d" ? 7 : range === "14d" ? 14 : 30} 天`}>
      <BarChart
        data={observabilityDays.map((label, index) => ({
          label,
          value: Math.round([31, 28, 34, 42, 38, 33, 26][index % 7] * factor),
        }))}
      />
    </Card>

    <div className="split-grid">
      <Card icon={ChartLineUp} title="时延趋势" note={`单位：秒 · 近 ${range === "7d" ? 7 : range === "14d" ? 14 : 30} 天`}>
        <LineChart series={observabilityLatency} formatValue={(value) => `${value}s`} />
      </Card>

      <Card icon={Pulse} title="工具调用排行" note="按累计调用次数排序">
        <RankList
          items={toolCallSeeds.map((item, index) => ({
            label: item.tool,
            value: item.calls,
            tone: ["#2f6b4f", "#4f8a67", "#6fa87f", "#8fbd92", "#a8cf7a", "#c3d98f"][index],
          }))}
          unit=" 次"
        />
      </Card>
    </div>

    <Card icon={Gauge} title="负载热力图" note="按工作日与时段统计的任务并发量，深色代表高峰">
      <HeatGrid
        rows={observabilityHeatRows}
        columns={observabilityHeatColumns}
        values={observabilityHeat}
        formatValue={(value) => `${value} 个任务`}
      />
      <div className="legend-row">
        <span>低</span>
        {[0.14, 0.32, 0.5, 0.68, 0.9].map((alpha) => <i key={alpha} style={{ background: `rgba(47, 107, 79, ${alpha})` }} />)}
        <span>高</span>
        <b className="legend-note">高峰集中在工作日 09:00–18:00</b>
      </div>
    </Card>

    <Card icon={ChartLineUp} title="工具健康度" note="失败率超过 1% 会以红色标出，便于优先排查">
      <DataTable
        columns={toolColumns}
        rows={toolCallSeeds}
        rowKey={(row) => row.tool}
        pageSize={6}
        emptyTitle="暂无工具调用记录"
      />
    </Card>

    <Card
      icon={WarningCircle}
      title="异常事件"
      note="按严重程度分级，P2 及以上需要当日闭环"
      count={incidents.length}
      toolbar={<Toolbar>
        <FilterChips<Level>
          value={level}
          onChange={setLevel}
          options={[
            { id: "all", label: "全部" },
            { id: "P2", label: "P2 严重" },
            { id: "P3", label: "P3 一般" },
            { id: "P4", label: "P4 提示" },
          ]}
          counts={{
            all: incidentSeeds.length,
            P2: incidentSeeds.filter((item) => item.level === "P2").length,
            P3: incidentSeeds.filter((item) => item.level === "P3").length,
            P4: incidentSeeds.filter((item) => item.level === "P4").length,
          }}
        />
      </Toolbar>}
    >
      {incidents.length
        ? <ul className="incident-list">
          {incidents.map((item) => <li key={item.id}>
            <Pill tone={levelTone[item.level]}>{item.level}</Pill>
            <div>
              <strong>{item.title}</strong>
              <small>{item.scope} · {formatDateTime(item.at)} · 跟进人 {item.owner}</small>
            </div>
            <Pill tone={item.status === "已关闭" || item.status === "已恢复" ? "ok" : item.status === "处理中" ? "warn" : "neutral"}>{item.status}</Pill>
            <button type="button" className="ghost-action" onClick={() => push(`已把「${item.title}」加入跟进清单（示例）`, "info")}>跟进</button>
          </li>)}
        </ul>
        : <div className="placeholder empty-state"><CheckCircle /><p><strong>该级别暂无异常事件</strong><small>切换严重程度筛选可以查看其他级别的记录。</small></p></div>}
    </Card>

    <div className="split-grid">
      <Card icon={Pulse} title="运行健康摘要" note="当前时间窗口内的关键结论">
        <KeyValueList rows={[
          { label: "任务成功率", value: "96.2%" },
          { label: "平均排队时长", value: "1.4s" },
          { label: "推理回退次数", value: "6 次（远程失败后切本地）" },
          { label: "审批平均等待", value: "12 分钟" },
          { label: "MCP 服务可用率", value: "83%（6 个服务中 5 个正常）" },
        ]} />
      </Card>

      <Card icon={Timer} title="时延分解" note="单位：秒 · 取近 7 天平均">
        <RankList
          items={[
            { label: "推理耗时", value: 34, tone: "#2f6b4f" },
            { label: "工具调用", value: 21, tone: "#6fa87f" },
            { label: "审批等待", value: 12, tone: "#a8cf7a" },
            { label: "调度与排队", value: 6, tone: "#c3d98f" },
          ]}
          unit="s"
        />
      </Card>
    </div>

    <p className="page-note">扩展点：接入后端后可提供按任务类型维度的下钻、自定义告警阈值，以及把异常事件直接指回运行中心对应任务的事件流。</p>
  </WorkspacePage>;
}
