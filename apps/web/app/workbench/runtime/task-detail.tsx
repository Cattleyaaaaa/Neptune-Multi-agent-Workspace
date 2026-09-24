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
import { useAuth } from "../../auth/provider";
import { StepInspector } from "./step-inspector";
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
  initialStep,
  onStepChange,
}: {
  task: Task | undefined;
  busy: boolean;
  onDecide: (decision: "approve" | "reject") => void;
  apiUrl: string;
  /* 选中的步骤镜像在 ?step=<id> 上：每一步因此都有可以直接打开的地址。 */
  initialStep?: string | null;
  onStepChange?: (stepId: string | null) => void;
}) {
  const [active, setActive] = useState<StageFilter>("all");
  const [stepId, setStepId] = useState<string | null>(initialStep ?? null);

  // Read the stage from the hash once on mount (after hydration, so the server
  // and client first render stay identical).
  useEffect(() => {
    const raw = window.location.hash.replace(/^#/, "");
    if (!raw.startsWith("stage=")) return;
    const value = raw.slice("stage=".length) as StageFilter;
    if (stageFilters.includes(value)) setActive(value);
  }, []);

  // 外部（地址栏）变化时跟随，例如直接打开带 step 的链接、或用户前进后退
  useEffect(() => {
    setStepId(initialStep ?? null);
  }, [initialStep]);

  // 地址里的 step 指向一个不存在的步骤（旧链接、手改）时清掉它，别留一个打不开的地址
  useEffect(() => {
    if (!task || !stepId) return;
    if (!task.plan.some((step) => step.id === stepId)) setStepId(null);
  }, [task, stepId]);

  const changeStep = useCallback((next: string | null) => {
    setStepId(next);
    // 用原生 replaceState 改 query：保留 hash 里的阶段选择，也不触发服务端重新渲染
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (next) url.searchParams.set("step", next);
      else url.searchParams.delete("step");
      window.history.replaceState(null, "", url.toString());
    }
    onStepChange?.(next);
  }, [onStepChange]);

  const changeStage = useCallback((next: StageFilter) => {
    setActive(next);
    const base = window.location.pathname + window.location.search;
    window.history.replaceState(null, "", next === "all" ? base : `${base}#stage=${next}`);
  }, []);

  const opened = task && stepId ? task.plan.find((step) => step.id === stepId) : undefined;

  return <>
    <TaskOverview task={task} apiUrl={apiUrl} />
    {task?.status === "awaiting_approval" && <ApprovalGate task={task} busy={busy} onDecide={onDecide} />}
    <StageTabs task={task} active={active} onSelect={changeStage} />
    <StageDetails task={task} active={active} onOpenStep={changeStep} />
    {task && opened && <StepInspector task={task} step={opened} onClose={() => changeStep(null)} />}
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

  // 目标是页面标题，这里不再重复；只保留"这次运行是什么状态、走到哪、有多少东西可看"。
  return <section className="overview panel task-overview">
    <div className="overview-bar">
      <div className="badges">
        <b className={`status-tag ${statusTone(task.status)}`}>{statusText(task.status)}</b>
        <b>{typeText(task.task_type)}</b>
        <b className={`risk ${task.risk_level}`}>{riskText(task.risk_level)}</b>
        <b className="muted">{task.execution_mode === "plan_only" ? "仅生成计划" : "自动执行"}</b>
      </div>

      <div className="overview-meters">
        <div className="progress-unit">
          <div className="progress-head"><small>流程</small><small>{doneStages}/{stages.length}</small></div>
          <div className="progress-track"><i style={{ width: `${stagePercent}%` }} /></div>
        </div>
        <div className="progress-unit">
          <div className="progress-head"><small>计划</small><small>{progress.total ? `${progress.done}/${progress.total} · ${progress.percent}%` : "待生成"}</small></div>
          <div className="progress-track"><i style={{ width: `${progress.percent}%` }} /></div>
        </div>
      </div>

      <div className="overview-counts">
        <span><b>{task.plan.length}</b>步骤</span>
        <span><b>{task.agent_trace.length}</b>轨迹</span>
        <span><b>{task.tool_trace.length}</b>工具</span>
        <span><b>{Object.keys(task.artifacts).length}</b>交付物</span>
      </div>

      <div className="overview-actions">
        <small>更新于 {formatUpdatedAt(task.updated_at)}</small>
        <a className="head-link" href={`${apiUrl}/api/tasks/${task.task_id}/export`}><DownloadSimple />下载记录</a>
      </div>
    </div>

    <div className="overview-foot-line">
      <code>{task.task_id}</code>
      {current ? <span>当前阶段「{current.name}」</span> : <span>全部阶段已完成</span>}
    </div>

    {task.final_response && <div className="result"><CheckCircle weight="fill" />{task.final_response}</div>}
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
  const { isGuest } = useAuth();

  return <section className="approval-banner panel">
    <div className="approval-card">
      <div><Lightning weight="fill" /><span><strong>需要执行授权</strong><small>风险等级：{riskText(task.risk_level)} · 专业处理与质量审查已完成</small></span></div>
      <p>批准后将仅执行计划中列出的动作；拒绝则结束流程。</p>
      <div>
        <button onClick={() => onDecide("reject")} disabled={busy || isGuest}><X />拒绝</button>
        <button className="approve" onClick={() => onDecide("approve")} disabled={busy || isGuest}><CheckCircle weight="fill" />批准执行</button>
      </div>
      {isGuest && <p className="approval-guest">访客是只读会话，不能审批。</p>}
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
      {stages.map((stage) => {
        const count = stageCount(task, stage.key);
        return <button
          type="button"
          role="tab"
          aria-selected={active === stage.key}
          className={`filter-chip ${active === stage.key ? "active" : ""}`}
          key={stage.key}
          onClick={() => onSelect(stage.key)}
        >
          <i className={`stage-tab-dot ${stage.state}`} aria-hidden="true" />
          {stage.name}
          {count > 0 && <em>{count}</em>}
        </button>;
      })}
    </div>
  </section>;
}

/* ------------------------------------------------------------------ 下部：阶段详情（随按钮切换） */

function StageDetails({
  task,
  active,
  onOpenStep,
}: {
  task: Task | undefined;
  active: StageFilter;
  onOpenStep: (stepId: string) => void;
}) {
  if (!task) return null;
  const stages = deriveStages(task);
  const visible = active === "all" ? stages : stages.filter((stage) => stage.key === active);
  return <div className={`stage-details ${active === "all" ? "" : "stage-single"}`}>
    {visible.map((stage) => <StagePanel key={stage.key} task={task} stage={stage} onOpenStep={onOpenStep} />)}
  </div>;
}

function StagePanel({
  task,
  stage,
  onOpenStep,
}: {
  task: Task;
  stage: Stage;
  onOpenStep: (stepId: string) => void;
}) {
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
        return <Fragment key={step.id}>
          <button
            type="button"
            className={`plan-step ${done ? "done" : ""} ${currentStep ? "current" : ""}`}
            onClick={() => onOpenStep(step.id)}
            title="查看这一步的产出、工具调用与轨迹"
          >
            <i>{done ? <Check /> : index + 1}</i>
            <span><strong>{agentLabels[step.agent] ?? step.agent}</strong><small>{step.title}</small></span>
            <em>详情<ArrowRight /></em>
          </button>
          {index < task.plan.length - 1 && <b className="plan-arrow"><ArrowRight /></b>}
        </Fragment>;
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
    {artifactCount ? <div className="artifact-grid">{Object.entries(task.artifacts).map(([agent, value]) => {
      // 产物属于某个 Agent；点开它等于打开那个步骤的详情（含完整字段，而不是一行摘要）
      const owner = task.plan.find((step) => step.agent === agent);
      const body = <><FileText weight="duotone" /><div><small>{agentLabels[agent] ?? agent}</small><strong>{String(value.title ?? "Agent 产物")}</strong><p>{artifactSummary(value)}</p></div>{owner && <em>详情<ArrowRight /></em>}</>;
      return owner
        ? <button type="button" className="artifact-card" key={agent} onClick={() => onOpenStep(owner.id)}>{body}</button>
        : <article key={agent}>{body}</article>;
    })}</div> : <Placeholder text="研究、数据、代码或文档产物将出现在这里。" />}
  </section>;
}

/* 每个阶段"有多少东西可看"，直接标在按钮上，省得点进去才发现是空的。 */
function stageCount(task: Task, key: string): number {
  if (key === "planning") return new Set(task.plan.map((step) => step.agent)).size;
  if (key === "schedule") return task.plan.length;
  if (key === "collaboration") return task.agent_trace.length;
  if (key === "deliverables") return Object.keys(task.artifacts).length;
  return 0;
}

function Placeholder({ text }: { text: string }) {
  return <div className="placeholder"><CirclesFour /><p>{text}</p></div>;
}
