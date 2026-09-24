"use client";

import { Paperclip } from "@phosphor-icons/react/dist/csr/Paperclip";
import { PaperPlaneTilt } from "@phosphor-icons/react/dist/csr/PaperPlaneTilt";
import { FormEvent, KeyboardEvent } from "react";

export const templates = [
  { label: "研究", text: "比较 LangGraph、CrewAI 和 AutoGen，形成技术选型报告" },
  { label: "数据", text: "分析 CSV 销售数据并定义核心指标和质量检查" },
  { label: "代码", text: "分析 API 登录故障，制定修复方案和测试标准" },
  { label: "审批", text: "生成季度总结并发送给客户" },
];

/* 底部输入区：附加文件 + 消息输入 + 发送，Enter 发送、Shift+Enter 换行。
   对话页里发送的是"这条消息"：同一段对话内的多轮会带上历史上下文，
   没有选中对话时则开启新对话。 */
export function TaskComposer({
  objective,
  onObjectiveChange,
  context,
  onContextChange,
  fileName,
  mode,
  onModeChange,
  busy,
  onSubmit,
  onFile,
  error,
  hint,
  readOnly = false,
  placeholder = "描述任务目标，例如：比较三种编排框架并形成选型报告",
}: {
  objective: string;
  onObjectiveChange: (value: string) => void;
  context: string;
  onContextChange: (value: string) => void;
  fileName: string;
  mode: "auto" | "plan_only";
  onModeChange: (value: "auto" | "plan_only") => void;
  busy: boolean;
  onSubmit: (event: FormEvent) => void;
  onFile: (file?: File) => void;
  error: string;
  hint?: string;
  /* 访客是只读会话：输入与发送都禁用，并说明原因。 */
  readOnly?: boolean;
  placeholder?: string;
}) {
  const valid = objective.trim().length >= 3;

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return <section className="workspace-input" id="task-composer">
    <form onSubmit={onSubmit}>
      <div className="input-row">
        <label className="attach-btn" title="附加 CSV、TXT、MD 或 JSON">
          <Paperclip />
          <input type="file" accept=".csv,.txt,.md,.json,text/*,application/json" onChange={(event) => onFile(event.target.files?.[0])} />
        </label>
        <textarea
          id="task-objective"
          value={objective}
          onChange={(event) => onObjectiveChange(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          placeholder={readOnly ? "访客是只读会话，不能发起任务" : placeholder}
          disabled={readOnly}
        />
        <button className="primary" disabled={busy || !valid || readOnly}>
          {busy ? "调度中…" : <><PaperPlaneTilt weight="fill" />发送</>}
        </button>
      </div>

      <input
        className="context-field"
        value={context}
        onChange={(event) => onContextChange(event.target.value)}
        placeholder="补充背景、约束或期望交付物（可选）"
      />

      <div className="input-foot">
        <div className="template-row">
          {templates.map((item) => <button type="button" key={item.label} onClick={() => onObjectiveChange(item.text)}>{item.label}</button>)}
        </div>
        <label className="mode-inline">
          <input type="checkbox" checked={mode === "plan_only"} onChange={(event) => onModeChange(event.target.checked ? "plan_only" : "auto")} />
          仅生成计划
        </label>
        <span className="input-hint">
          {readOnly
            ? "访客是只读会话：可以浏览运行记录与步骤，不能发起任务、审批或改动配置"
            : fileName ? `已附加 ${fileName}` : hint ?? "Enter 发送 · Shift + Enter 换行"}
        </span>
      </div>

      {objective.length > 0 && !valid && <div className="field-hint">目标至少需要 3 个字符才能提交。</div>}
    </form>
    {error && <div className="error">{error}</div>}
  </section>;
}
