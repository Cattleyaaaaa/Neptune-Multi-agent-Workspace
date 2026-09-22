"use client";

import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { CirclesFour } from "@phosphor-icons/react/dist/csr/CirclesFour";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useState } from "react";
import {
  Task,
  TaskStatus,
  agentLabels,
  formatUpdatedAt,
  statusFilters,
  statusText,
  statusTone,
  typeText,
} from "./shared";

/* 左侧会话栏：每个会话就是一次任务运行。默认「新建」视图只负责浏览与切换，
   「管理」视图额外提供搜索、状态筛选、刷新，以及恢复已关闭的会话。 */
export function SessionsPanel({
  tasks,
  activeId,
  onSelect,
  onClose,
  hiddenCount,
  onRestore,
  loading,
  refreshing,
  onRefresh,
  query,
  onQueryChange,
  filter,
  onFilterChange,
  onCreate,
  error,
  onRetry,
}: {
  tasks: Task[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  hiddenCount: number;
  onRestore: () => void;
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  query: string;
  onQueryChange: (value: string) => void;
  filter: TaskStatus;
  onFilterChange: (value: TaskStatus) => void;
  onCreate: () => void;
  error: string;
  onRetry: () => void;
}) {
  const [managing, setManaging] = useState(false);

  return <aside className="sessions">
    <div className="sessions-head">
      <div className="sessions-title"><strong>会话</strong><small>{tasks.length}</small></div>
      <div className="segmented" role="tablist" aria-label="会话视图">
        <button type="button" role="tab" aria-selected={!managing} className={!managing ? "active" : ""} onClick={() => setManaging(false)}>新建</button>
        <button type="button" role="tab" aria-selected={managing} className={managing ? "active" : ""} onClick={() => setManaging(true)}>管理</button>
      </div>
    </div>

    {managing && <div className="sessions-tools">
      <label className="task-search">
        <MagnifyingGlass />
        <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索会话目标或 ID" />
      </label>
      <div className="task-filters">
        {statusFilters.map((item) => <button
          type="button"
          className={`filter-chip ${filter === item.id ? "active" : ""}`}
          key={item.id}
          onClick={() => onFilterChange(item.id)}
        >{item.label}</button>)}
      </div>
      <div className="sessions-tools-row">
        <button type="button" className="tool-btn" onClick={onRefresh} disabled={refreshing}>
          <ArrowsClockwise className={refreshing ? "spin" : undefined} />{refreshing ? "刷新中…" : "刷新"}
        </button>
        {hiddenCount > 0 && <button type="button" className="tool-btn" onClick={onRestore}>恢复已关闭 {hiddenCount}</button>}
      </div>
    </div>}

    <div className="session-list">
      {error && <div className="inline-error"><Warning /><span>{error}</span><button type="button" onClick={onRetry}>重试</button></div>}
      {loading && <div className="sessions-empty"><span className="spinner" /><p>正在读取会话…</p></div>}
      {!loading && !tasks.length && <div className="sessions-empty"><CirclesFour /><p>还没有会话</p><small>在下方输入框描述目标，即可创建第一个会话。</small></div>}
      {!loading && tasks.map((task) => (
        <SessionItem
          key={task.task_id}
          task={task}
          active={task.task_id === activeId}
          onSelect={() => onSelect(task.task_id)}
          onClose={() => onClose(task.task_id)}
        />
      ))}
    </div>

    <div className="sessions-foot">
      <button type="button" className="primary" onClick={onCreate}><Plus />新建会话</button>
    </div>
  </aside>;
}

function SessionItem({
  task,
  active,
  onSelect,
  onClose,
}: {
  task: Task;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const leadAgent = task.plan.length ? agentLabels[task.plan[0].agent] ?? typeText(task.task_type) : typeText(task.task_type);
  return <article className={`session-item ${active ? "active" : ""}`}>
    <button type="button" className="session-main" onClick={onSelect}>
      <i className={`dot ${statusTone(task.status)}`} />
      <span className="session-text">
        <strong>{task.objective}</strong>
        <span className="session-meta">
          <small>{leadAgent}</small>
          <small>·</small>
          <small>{statusText(task.status)}</small>
          <small>·</small>
          <small>{formatUpdatedAt(task.updated_at)}</small>
        </span>
      </span>
    </button>
    {active && <button type="button" className="session-close" onClick={onClose} aria-label="关闭会话" title="关闭会话（仅从列表移除，可恢复）"><X /></button>}
  </article>;
}
