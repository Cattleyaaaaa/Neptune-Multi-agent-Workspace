"use client";

import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { ChartBar } from "@phosphor-icons/react/dist/csr/ChartBar";
import { Coins } from "@phosphor-icons/react/dist/csr/Coins";
import { DownloadSimple } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { Gauge } from "@phosphor-icons/react/dist/csr/Gauge";
import { Robot } from "@phosphor-icons/react/dist/csr/Robot";
import { Stack } from "@phosphor-icons/react/dist/csr/Stack";
import { useMemo, useState } from "react";
import { WorkspacePage } from "../ui/shell";
import {
  Card, Field, KeyValueList, NumberInput, Pill, ProgressMeter, SampleBanner,
  SegmentedControl, SelectInput, StatStrip, SwitchRow, TextInput, Toolbar, useNotice,
} from "../ui/primitives";
import { RankList, StackedBarChart, DonutChart } from "../ui/charts";
import { DataTable, type Column } from "../ui/table";
import { useRecord } from "../ui/store";
import { compactNumber, formatNumber, usageByAgent, usageByModel, usageDaily } from "../ui/data";

type Range = "7d" | "14d" | "30d";

type BudgetSettings = {
  monthlyBudget: number;
  alertAt: number;
  hardStop: boolean;
  currency: string;
  note: string;
};

const defaultBudget: BudgetSettings = {
  monthlyBudget: 320,
  alertAt: 80,
  hardStop: false,
  currency: "CNY",
  note: "Q3 预算已审批",
};

const rangeFactors: Record<Range, number> = { "7d": 1, "14d": 1.94, "30d": 4.08 };

/* Token 用量: 按天、按模型、按 Agent 三个维度拆解消耗，并给出预算与告警设置。
   数据来源与运行中心的任务运行一一对应，便于定位是哪个 Agent 在烧钱。 */
export default function UsagePage() {
  const { notice, push, clear } = useNotice();
  const { value: budget, patch, reset } = useRecord<BudgetSettings>("usage-budget", defaultBudget);
  const [range, setRange] = useState<Range>("7d");
  const [model, setModel] = useState("all");
  const [groupBy, setGroupBy] = useState<"model" | "agent">("model");

  const factor = rangeFactors[range];
  const input = Math.round(usageDaily.reduce((sum, item) => sum + item.input, 0) * factor);
  const output = Math.round(usageDaily.reduce((sum, item) => sum + item.output, 0) * factor);
  const cost = Number((usageDaily.reduce((sum, item) => sum + item.cost, 0) * factor).toFixed(2));
  const total = input + output;
  const budgetUsed = Math.min(100, Math.round((cost / Math.max(budget.monthlyBudget, 1)) * 100));

  const metrics = [
    { label: "总 Token", value: compactNumber(total), note: `${formatNumber(total)} tokens`, icon: Stack },
    { label: "输入 / 输出", value: `${compactNumber(input)} / ${compactNumber(output)}`, note: `输出占比 ${Math.round((output / total) * 100)}%`, icon: ChartBar },
    { label: "估算成本", value: `¥${cost.toFixed(2)}`, note: `预算 ¥${budget.monthlyBudget}`, icon: Coins },
    { label: "缓存命中", value: "31.4%", note: "复用上下文节省的输入量", icon: Gauge },
  ];

  const modelRows = useMemo(() => usageByModel.map((item) => ({
    ...item,
    tokens: Math.round(item.tokens * factor),
    cost: Number((item.cost * factor).toFixed(2)),
    avg: Math.round((item.cost * factor) / Math.max(item.tokens / 1_000_000, 0.001) * 100) / 100,
    share: item.share,
    status: item.label.startsWith("本地") ? "本地回退" : "已启用",
  })), [factor]);

  const visibleModels = useMemo(
    () => modelRows.filter((row) => model === "all" || row.label === model),
    [modelRows, model],
  );

  const columns: Array<Column<(typeof modelRows)[number]>> = [
    {
      key: "label",
      header: "模型 / 通道",
      sortValue: (row) => row.label,
      render: (row) => <span className="cell-title">
        <strong className="mono">{row.label}</strong>
        <small>{row.status}</small>
      </span>,
    },
    {
      key: "tokens",
      header: "Token 用量",
      align: "right",
      sortValue: (row) => row.tokens,
      render: (row) => <span className="cell-stack right"><strong>{compactNumber(row.tokens)}</strong><small>{formatNumber(row.tokens)} tokens</small></span>,
    },
    {
      key: "share",
      header: "占比",
      align: "right",
      sortValue: (row) => row.share,
      render: (row) => <div className="share-cell"><ProgressMeter value={row.share} max={100} compact /><small>{row.share}%</small></div>,
    },
    {
      key: "cost",
      header: "成本",
      align: "right",
      secondary: true,
      sortValue: (row) => row.cost,
      render: (row) => <span className={row.cost === 0 ? "text-ok" : ""}>¥{row.cost.toFixed(2)}</span>,
    },
    {
      key: "avg",
      header: "百万 Token 单价",
      align: "right",
      secondary: true,
      sortValue: (row) => row.avg,
      render: (row) => row.cost === 0 ? <Pill tone="ok">本地免费</Pill> : `¥${row.avg.toFixed(2)}`,
    },
  ];

  function exportCsv() {
    const header = "日期,输入Token,输出Token,成本(CNY)\n";
    const body = usageDaily.map((item) => `${item.label},${item.input},${item.output},${item.cost}`).join("\n");
    const blob = new Blob([`\uFEFF${header}${body}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "nexus-token-usage.csv";
    anchor.click();
    URL.revokeObjectURL(url);
    push("已导出近 7 天用量明细 CSV");
  }

  return <WorkspacePage
    active="usage"
    note="按住天、按模型、按 Agent 拆解 Token 消耗与成本，并设置月度预算与超限策略。远程推理与本地回退会分别计量。"
    notice={notice}
    onDismissNotice={clear}
    actions={<>
      <button type="button" onClick={() => push("用量数据已刷新（示例数据）", "info")}><ArrowsClockwise />刷新用量</button>
      <button type="button" className="save action-btn" onClick={exportCsv}><DownloadSimple />导出 CSV</button>
    </>}
  >
    <SampleBanner note="用量与成本为本地示例数据，接入后端计量后可展示真实账单与按任务下钻的明细。" />

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
      <SelectInput
        value={model}
        onChange={setModel}
        options={[{ value: "all", label: "全部模型" }, ...modelRows.map((row) => ({ value: row.label, label: row.label }))]}
      />
    </Toolbar>

    <StatStrip items={metrics} />

    <Card icon={ChartBar} title="每日消耗" note="柱高为当日总 Token，深浅区分输入与输出">
      <StackedBarChart
        data={usageDaily.map((item) => ({
          label: item.label,
          parts: [
            { label: "输入", value: Math.round(item.input * factor), color: "#2f6b4f" },
            { label: "输出", value: Math.round(item.output * factor), color: "#a8cf7a" },
          ],
        }))}
        formatValue={(value) => compactNumber(value)}
      />
      <div className="legend-row">
        <span><i style={{ background: "#2f6b4f" }} />输入 Token</span>
        <span><i style={{ background: "#a8cf7a" }} />输出 Token</span>
        <b className="legend-note">周末用量明显低于工作日，与定时任务节奏一致</b>
      </div>
    </Card>

    <Card
      icon={Stack}
      title="维度拆解"
      note="切换后下方表格与排行会同步变化"
      toolbar={<Toolbar>
        <SegmentedControl<"model" | "agent">
          value={groupBy}
          onChange={setGroupBy}
          options={[{ id: "model", label: "按模型" }, { id: "agent", label: "按 Agent" }]}
        />
      </Toolbar>}
    >
      {groupBy === "model"
        ? <DataTable
          columns={columns}
          rows={visibleModels}
          rowKey={(row) => row.label}
          pageSize={6}
          emptyTitle="没有匹配的模型"
          emptyNote="切换模型筛选条件后重试。"
        />
        : <RankList
          items={usageByAgent.map((item, index) => ({
            label: item.label,
            value: Math.round(item.value * factor),
            tone: ["#2f6b4f", "#4f8a67", "#6fa87f", "#8fbd92", "#a8cf7a", "#c3d98f"][index],
          }))}
          formatValue={(value) => compactNumber(value)}
          unit=" tokens"
        />}
    </Card>

    <div className="split-grid">
      <Card icon={Coins} title="预算与告警" note="设置会保存在本地，用于演示配置校验与保存反馈">
        <div className="budget-block">
          <ProgressMeter
            value={cost}
            max={budget.monthlyBudget}
            tone={budgetUsed >= 100 ? "danger" : budgetUsed >= budget.alertAt ? "warn" : "ok"}
          />
          <p className="budget-caption">
            本周期已使用 <strong>¥{cost.toFixed(2)}</strong> / ¥{budget.monthlyBudget}
            <span className={`budget-tag ${budgetUsed >= budget.alertAt ? "warn" : "ok"}`}>
              {budgetUsed >= 100 ? "已超预算" : budgetUsed >= budget.alertAt ? "接近阈值" : "预算充足"}
            </span>
          </p>
        </div>

        <div className="form-grid cols-2">
          <Field label="月度预算" hint={`单位：${budget.currency}`}>
            <NumberInput value={budget.monthlyBudget} min={0} max={100000} step={10} onChange={(value) => patch({ monthlyBudget: value })} />
          </Field>
          <Field label="告警阈值" hint="达到该百分比时提示" error={budget.alertAt > 100 ? "阈值不能超过 100%" : undefined}>
            <NumberInput value={budget.alertAt} min={1} max={100} step={5} onChange={(value) => patch({ alertAt: value })} />
          </Field>
          <Field label="结算币种">
            <SelectInput
              value={budget.currency}
              onChange={(value) => patch({ currency: value })}
              options={[
                { value: "CNY", label: "人民币 CNY" },
                { value: "USD", label: "美元 USD" },
              ]}
            />
          </Field>
          <Field label="备注" hint="仅本地保留">
            <TextInput value={budget.note} onChange={(value) => patch({ note: value })} placeholder="例如：Q3 预算已审批" />
          </Field>
        </div>

        <SwitchRow
          title="超预算硬停止"
          note="开启后达到 100% 将拒绝新的远程推理请求并回退到本地规则"
          checked={budget.hardStop}
          onChange={(value) => patch({ hardStop: value })}
        />

        <div className="detail-actions">
          <button type="button" className="ghost-action" onClick={() => { reset(); push("已恢复默认预算设置", "info"); }}>恢复默认</button>
          <button type="button" className="primary-action action-btn" onClick={() => {
            if (budget.alertAt > 100) { push("告警阈值不能超过 100%", "error"); return; }
            push(`预算设置已保存：¥${budget.monthlyBudget} · 阈值 ${budget.alertAt}%`);
          }}>保存设置</button>
        </div>
      </Card>

      <Card icon={Stack} title="按模型拆分" note="各推理通道的 Token 占比，本地回退不产生费用">
        <DonutChart
          centerLabel="总 Token"
          centerValue={compactNumber(total)}
          segments={modelRows.map((row, index) => ({
            label: row.label,
            value: row.tokens,
            tone: ["#2f6b4f", "#a8cf7a", "#7f9e8c", "#c3d98f"][index % 4],
          }))}
        />
      </Card>
    </div>

    <Card icon={Robot} title="计量口径" note="与运行中心的统计保持一致">
      <div className="padded-block">
        <KeyValueList rows={[
          { label: "计入范围", value: "任务理解、规划、专业 Agent 与审查" },
          { label: "不计入", value: "本地规则推理（成本为 0）" },
          { label: "缓存抵扣", value: "命中上下文的输入按 25% 计费" },
          { label: "结算周期", value: "自然月，次月 1 日生成账单" },
          { label: "异常判定", value: "单任务成本超过 ¥2.00 触发复核" },
        ]} />
        <p className="page-note">当前隐藏的成本详情：本地回退节省约 ¥18.60，占总消耗的 46%。</p>
      </div>
    </Card>
  </WorkspacePage>;
}
