"use client";

import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CirclesFour } from "@phosphor-icons/react/dist/csr/CirclesFour";
import { DownloadSimple } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { FlowArrow } from "@phosphor-icons/react/dist/csr/FlowArrow";
import { Lightning } from "@phosphor-icons/react/dist/csr/Lightning";
import { Toolbox } from "@phosphor-icons/react/dist/csr/Toolbox";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { Fragment, useCallback, useEffect, useState } from "react";
import {
  Stage,
  StageFilter,
  Task,
  agentLabels,
  artifactSummary,
  currentStage,
  deriveStages,
  formatUpdatedAt,
  riskText,
  stageFilters,
  stageStateText,
  statusText,
  statusTone,
  taskProgress,
  typeText,
} from "./shared";

/* Layout follows the information:
   top    → 任务总览 (name / status / two progress meters side by side)
   middle → 执行流程 tab group (阶段按钮，选中即深色填充)
   bottom → 该阶段的详情面板（"全部" 时平铺五个阶段）
   plus   人工控制 only when an approval is genuinely pending.
   The selected tab is mirrored into the URL hash so a refresh keeps it. */
export function TaskDetail({
  task,
  busy,
  onDecide,
  apiUrl,
}: {
  task: Task | undefined;
  busy: boolean;
  onDecide: (decision: "approve" | "reject") => void;
  apiUrl: string;
}) {
  const [active, setActive] = useState<StageFilter>("all");

  // Read the stage from the hash once on mount (after hydration, so the server
  // and client first render stay identical).
  useEffect(() => {
    const raw = window.location.hash.replace(/^#/, "");
    if (!raw.startsWith("stage=")) return;
    const value = raw.slice("stage=".length) as StageFilter;
    if (stageFilters.includes(value)) setActive(value);
  }, []);

  const changeStage = useCallback((next: StageFilter) => {
    setActive(next);
    const base = window.location.pathname + window.location.search;
    window.history.replaceState(null, "", next === "all" ? base : `${base}#stage=${next}`);
  }, []);

  return <>
    <TaskOverview task={task} apiUrl={apiUrl} />
    {task?.status === "awaiting_approval" && <ApprovalGate task={task} busy={busy} onDecide={onDecide} />}
    <StageTabs task={task} active={active} onSelect={changeStage} />
    <StageDetails task={task} active={active} />
  </>;
}

/* ------------------------------------------------------------------ 顶部总览 */

function TaskOverview({ task, apiUrl }: { task: Task | undefined; apiUrl: string }) {
  if (!task) {
    return <section className="overview panel task-overview detail-empty">
      <div className="placeholder"><CirclesFour /><p>还没有选中的任务</p><small>在最上方「新建任务」里描述目标并启动，或从任务空间里选择一个已有任务查看它的完整流程。</small></div>
    </section>;
  }

  const progress = taskProgress(task);
  const stages = deriveStages(task);
  const current = currentStage(stages);
  const doneStages = stages.filter((stage) => stage.state === "done").length;
  const stagePercent = Math.round((doneStages / stages.length) * 100);

  return <section className="overview panel task-overview">
    <div className="panel-head">
      <span>总览</span>
      <div><h2>{task.objective}</h2><p>任务 {task.task_id}</p></div>
      <a className="head-link" href={`${apiUrl}/api/tasks/${task.task_id}/export`}><DownloadSimple />下载记录</a>
    </div>
    <div className="overview-body">
      <div className="badges">
        <b className={`status-tag ${statusTone(task.status)}`}>{statusText(task.status)}</b>
        <b>{typeText(task.task_type)}</b>
        <b className={`risk ${task.risk_level}`}>{riskText(task.risk_level)}</b>
        <b className="muted">{task.execution_mode === "plan_only" ? "仅生成计划" : "自动执行"}</b>
      </div>

      <div className="progress-block">
        <div className="progress-unit">
          <div className="progress-head"><small>流程进度</small><small>{doneStages}/{stages.length} 阶段{current ? ` · 当前「${current.name}」` : ""}</small></div>
          <div className="progress-track"><i style={{ width: `${stagePercent}%` }} /></div>
        </div>
        <div className="progress-unit">
          <div className="progress-head"><small>计划执行</small><small>{progress.total ? `${progress.done}/${progress.total} 步 · ${progress.percent}%` : "等待计划生成"}</small></div>
          <div className="progress-track"><i style={{ width: `${progress.percent}%` }} /></div>
        </div>
      </div>

      <div className="stat-grid">
        <div><small>计划步骤</small><strong>{task.plan.length}</strong></div>
        <div><small>Agent 活动</small><strong>{task.agent_trace.length}</strong></div>
        <div><small>工具调用</small><strong>{task.tool_trace.length}</strong></div>
        <div><small>交付物</small><strong>{Object.keys(task.artifacts).length}</strong></div>
      </div>

      <div className="overview-foot"><small>更新于 {formatUpdatedAt(task.updated_at)}</small></div>
      {task.final_response && <div className="result"><CheckCircle weight="fill" />{task.final_response}</div>}
    </div>
  </section>;
}

/* ------------------------------------------------------------------ 人工控制（仅待审批时出现，避免空面板堆积） */

function ApprovalGate({
  task,
  busy,
  onDecide,
}: {
  task: Task;
  busy: boolean;
  onDecide: (decision: "approve" | "reject") => void;
}) {
  return <section className="approval-banner panel">
    <div className="approval-card">
      <div><Lightning weight="fill" /><span><strong>需要执行授权</strong><small>风险等级：{riskText(task.risk_level)} · 专业处理与质量审查已完成</small></span></div>
      <p>批准后将仅执行计划中列出的动作；拒绝则结束流程。</p>
      <div>
        <button onClick={() => onDecide("reject")} disabled={busy}><X />拒绝</button>
        <button className="approve" onClick={() => onDecide("approve")} disabled={busy}><CheckCircle weight="fill" />批准执行</button>
      </div>
    </div>
  </section>;
}

/* ------------------------------------------------------------------ 中部：阶段按钮组（点击切换详情） */

function StageTabs({
  task,
  active,
  onSelect,
}: {
  task: Task | undefined;
  active: StageFilter;
  onSelect: (value: StageFilter) => void;
}) {
  if (!task) return null;
  const stages = deriveStages(task);
  const current = currentStage(stages);
  const doneStages = stages.filter((stage) => stage.state === "done").length;
  const hint = current
    ? `当前进行到「${current.name}」阶段 · 点击按钮切换阶段详情`
    : doneStages === stages.length
      ? "全部阶段已完成 · 点击按钮查看各阶段详情"
      : "等待流程开始";

  return <section className="panel stage-flow">
    <div className="panel-head">
      <span>流程</span>
      <div><h2>执行流程</h2><p>{hint}</p></div>
      <b>{doneStages}/{stages.length}</b>
    </div>
    <div className="stage-tabs" role="tablist" aria-label="流程阶段">
      <button
        type="button"
        role="tab"
        aria-selected={active === "all"}
        className={`filter-chip ${active === "all" ? "active" : ""}`}
        onClick={() => onSelect("all")}
      >全部</button>
      {stages.map((stage) => (
        <button
          type="button"
          role="tab"
          aria-selected={active === stage.key}
          className={`filter-chip ${active === stage.key ? "active" : ""}`}
          key={stage.key}
          onClick={() => onSelect(stage.key)}
        >
          <i className={`stage-tab-dot ${stage.state}`} aria-hidden="true" />
          {stage.name}
        </button>
      ))}
    </div>
  </section>;
}

/* ------------------------------------------------------------------ 下部：阶段详情（随按钮切换） */

function StageDetails({ task, active }: { task: Task | undefined; active: StageFilter }) {
  if (!task) return null;
  const stages = deriveStages(task);
  const visible = active === "all" ? stages : stages.filter((stage) => stage.key === active);
  return <div className={`stage-details ${active === "all" ? "" : "stage-single"}`}>
    {visible.map((stage) => <StagePanel key={stage.key} task={task} stage={stage} />)}
  </div>;
}

function StagePanel({ task, stage }: { task: Task; stage: Stage }) {
  const number = String(stage.index).padStart(2, "0");
  const badge = <b className={`stage-state ${stage.state}`}>{stageStateText[stage.state]}</b>;
  const artifactCount = Object.keys(task.artifacts).length;

  if (stage.key === "objective") {
    return <section className="panel stage-detail">
      <div className="panel-head"><span>{number}</span><div><h2>任务目标</h2><p>任务理解 Agent 识别任务类型与风险等级</p></div>{badge}</div>
      <div className="overview-body">
        <div className="objective-lead"><small>目标</small><h3>{task.objective}</h3></div>
        {task.context
          ? <div className="context-block"><small>背景与约束</small><p>{task.context}</p></div>
          : <div className="context-block empty-context"><small>背景与约束</small><p>未提供额外背景，Agent 将仅依据目标执行。</p></div>}
        <div className="badges">
          <b>{typeText(task.task_type)}</b>
          <b className={`risk ${task.risk_level}`}>{riskText(task.risk_level)}</b>
        </div>
      </div>
    </section>;
  }

  if (stage.key === "planning") {
    const teamAgents = Array.from(new Set(task.plan.map((step) => step.agent)));
    return <section className="panel stage-detail">
      <div className="panel-head"><span>{number}</span><div><h2>任务规划</h2><p>Planner 按能力注册表为任务组建团队</p></div>{badge}</div>
      {teamAgents.length ? <div className="artifact-grid">{teamAgents.map((agent) => {
        const steps = task.plan.filter((step) => step.agent === agent).length;
        const done = task.completed_agents.includes(agent);
        return <article key={agent}><CirclesFour weight="duotone" /><div><small>{done ? "已完成" : "待执行"}</small><strong>{agentLabels[agent] ?? agent}</strong><p>{steps} 个计划步骤</p></div></article>;
      })}</div> : <Placeholder text="Planner 会根据任务类型选择参与的专业 Agent。" />}
    </section>;
  }

  if (stage.key === "schedule") {
    return <section className="panel stage-detail stage-full">
      <div className="panel-head"><span>{number}</span><div><h2>执行计划</h2><p>Supervisor 按步骤逐步交接，完成即勾选</p></div>{badge}</div>
      {task.plan.length ? <div className="plan-flow">{task.plan.map((step, index) => {
        const done = task.completed_agents.includes(step.agent);
        const currentStep = !done && task.plan.slice(0, index).every((item) => task.completed_agents.includes(item.agent));
        return <div className={`${done ? "done" : ""} ${currentStep ? "current" : ""}`} key={step.id}><i>{done ? <Check /> : index + 1}</i><span><strong>{agentLabels[step.agent] ?? step.agent}</strong><small>{step.title}</small></span>{index < task.plan.length - 1 && <ArrowRight />}</div>;
      })}</div> : <Placeholder text="计划会根据任务类型动态生成。" />}
    </section>;
  }

  if (stage.key === "collaboration") {
    return <section className="panel stage-detail">
      <div className="panel-head"><span>{number}</span><div><h2>Agent 协作</h2><p>每次判断、交接和审查都可追溯</p></div>{badge}</div>
      {task.agent_trace.length ? <div className="trace-list">{task.agent_trace.map((item, index) => <div className={item.agent === "supervisor_agent" ? "supervisor" : ""} key={`${item.agent}-${index}`}><i /><span><strong>{item.role}</strong><p>{item.summary}</p></span>{item.handoff && item.handoff !== "end" && <small><FlowArrow />{agentLabels[item.handoff] ?? item.handoff}</small>}</div>)}</div> : <Placeholder text="Agent 开始工作后会产生实时轨迹。" />}
      <details className="tool-fold">
        <summary><Toolbox weight="duotone" />工具与权限 · {task.tool_trace.length} 次调用</summary>
        {task.tool_trace.length ? <div className="tool-list">{task.tool_trace.map((item, index) => <div key={`${item.tool}-${index}`}><Toolbox weight="duotone" /><span><strong>{item.tool}</strong><small>{agentLabels[item.agent] ?? item.agent} · {item.access}</small><p>{item.summary}</p></span><CheckCircle weight="fill" /></div>)}</div> : <Placeholder text="专业 Agent 调用工具后会显示权限审计。" />}
      </details>
    </section>;
  }

  return <section className="panel stage-detail">
    <div className="panel-head"><span>{number}</span><div><h2>交付物</h2><p>专业 Agent 的结构化输出</p></div>{badge}</div>
    {artifactCount ? <div className="artifact-grid">{Object.entries(task.artifacts).map(([agent, value]) => <article key={agent}><FileText weight="duotone" /><div><small>{agentLabels[agent] ?? agent}</small><strong>{String(value.title ?? "Agent 产物")}</strong><p>{artifactSummary(value)}</p></div></article>)}</div> : <Placeholder text="研究、数据、代码或文档产物将出现在这里。" />}
  </section>;
}

function Placeholder({ text }: { text: string }) {
  return <div className="placeholder"><CirclesFour /><p>{text}</p></div>;
}
