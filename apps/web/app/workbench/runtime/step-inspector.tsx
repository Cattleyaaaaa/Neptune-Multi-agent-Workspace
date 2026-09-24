"use client";

/* 单步检查器：把"执行流程里的某一步"完整摊开。

   为什么需要它：执行计划与交付物阶段以前只列出一行摘要，点不开也带不走 —— 想知道
   "这一步到底产出了什么、调了哪些工具、有没有被审批拦住"，只能去翻整页汇总。
   现在每一步都有独立入口（并且地址里带 step 参数，可以直接分享）。

   内容全部来自任务本身的 plan / agent_trace / tool_trace / artifacts，不额外请求、
   也不做二次解释：字段名保持后端原样，避免"界面翻译"和真实产物对不上。 */

import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { FlowArrow } from "@phosphor-icons/react/dist/csr/FlowArrow";
import { Toolbox } from "@phosphor-icons/react/dist/csr/Toolbox";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useEffect } from "react";
import { FieldList } from "./artifact-view";
import { Step, Task, agentLabels } from "./shared";

function StepState({ task, step }: { task: Task; step: Step }) {
  const index = task.plan.findIndex((item) => item.id === step.id);
  const done = task.completed_agents.includes(step.agent);
  const running = !done
    && task.plan.slice(0, Math.max(index, 0)).every((item) => task.completed_agents.includes(item.agent));
  if (done) return <b className="stage-state done">已完成</b>;
  if (running && task.status === "running") return <b className="stage-state current">进行中</b>;
  return <b className="stage-state pending">待执行</b>;
}

export function StepInspector({
  task,
  step,
  onClose,
}: {
  task: Task;
  step: Step;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const index = task.plan.findIndex((item) => item.id === step.id);
  const artifact = task.artifacts[step.agent];
  const tools = task.tool_trace.filter((item) => item.agent === step.agent);
  const traces = task.agent_trace.filter((item) => item.agent === step.agent);
  const number = String(index + 1).padStart(2, "0");

  return <div className="step-mask" role="dialog" aria-modal="true" aria-label="步骤详情">
    <section className="step-sheet">
      <header className="step-head">
        <span className="step-number">{number}</span>
        <div>
          <h2>{step.title}</h2>
          <p>{agentLabels[step.agent] ?? step.agent} · {step.agent}</p>
        </div>
        <StepState task={task} step={step} />
        <button type="button" className="step-close" onClick={onClose} aria-label="关闭"><X /></button>
      </header>

      <div className="step-body">
        <section className="step-block">
          <h3><FileText weight="duotone" />这一步的产出</h3>
          {artifact
            ? <FieldList value={artifact} />
            : <p className="step-empty">这一步还没有产出。它会在 Supervisor 交接过来之后执行。</p>}
        </section>

        <section className="step-block">
          <h3><Toolbox weight="duotone" />工具调用 · {tools.length} 次</h3>
          {tools.length
            ? <div className="step-tools">{tools.map((item, i) => <div key={`${item.tool}-${i}`}>
              <Toolbox weight="duotone" />
              <span>
                <strong>{item.tool}</strong>
                <small>{item.access} · {item.status}</small>
                <p>{item.summary}</p>
              </span>
              <CheckCircle weight="fill" />
            </div>)}</div>
            : <p className="step-empty">这一步没有调用工具，或调用记录还没产生。</p>}
        </section>

        <section className="step-block">
          <h3><FlowArrow weight="duotone" />协作轨迹 · {traces.length} 条</h3>
          {traces.length
            ? <div className="step-traces">{traces.map((item, i) => <div key={`${item.summary}-${i}`}>
              <i />
              <span>
                <strong>{item.role}</strong>
                <p>{item.summary}</p>
              </span>
              {item.handoff && item.handoff !== "end" && <small>
                <FlowArrow />{agentLabels[item.handoff] ?? item.handoff}
              </small>}
            </div>)}
            </div>
            : <p className="step-empty">还没有这一步的轨迹事件。</p>}
        </section>
      </div>
    </section>
  </div>;
}
