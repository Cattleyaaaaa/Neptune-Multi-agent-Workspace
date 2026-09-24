"use client";

/* Shared UI kit for the workbench pages.
   Everything here is presentational: it owns no data and talks to no API, so
   the same table / drawer / form primitives serve real config sections (which
   read /api/workspace) and the local-state pages alike. */

import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Info } from "@phosphor-icons/react/dist/csr/Info";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { X } from "@phosphor-icons/react/dist/csr/X";
import type { ComponentType, ReactNode } from "react";
import { useCallback, useEffect, useId, useState } from "react";

export type IconComponent = ComponentType<{
  weight?: "thin" | "light" | "regular" | "bold" | "fill" | "duotone";
  className?: string;
}>;

export type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";

/* ------------------------------------------------------------------ status */

export function Pill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function ChipList({ items, empty = "—" }: { items: string[]; empty?: string }) {
  if (!items.length) return <span className="muted-text">{empty}</span>;
  return <span className="chip-list">{items.map((item) => <b key={item}>{item}</b>)}</span>;
}

/* ------------------------------------------------------------------ notices */

export type Notice = { id: number; tone: "success" | "error" | "info"; text: string };

/* Inline feedback channel. Every mutation in the workbench reports through this
   so no button is ever silently inert. */
export function useNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);

  const push = useCallback((text: string, tone: Notice["tone"] = "success") => {
    setNotice({ id: Date.now(), tone, text });
  }, []);

  const clear = useCallback(() => setNotice(null), []);

  useEffect(() => {
    if (!notice) return;
    if (notice.tone === "error") return; // errors stay until acknowledged
    const timer = window.setTimeout(() => setNotice(null), 3600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return { notice, push, clear };
}

export function NoticeBar({ notice, onClose }: { notice: Notice | null; onClose: () => void }) {
  if (!notice) return null;
  const Icon = notice.tone === "success" ? CheckCircle : notice.tone === "error" ? WarningCircle : Info;
  return (
    <div className={`notice ${notice.tone}`} role="status">
      <Icon weight="fill" />
      <p>{notice.text}</p>
      <button type="button" aria-label="关闭提示" onClick={onClose}><X /></button>
    </div>
  );
}

/* -------------------------------------------------------------------- cards */

export function Card({
  icon: Icon,
  title,
  note,
  count,
  action,
  toolbar,
  children,
  className = "",
}: {
  icon?: IconComponent;
  title: string;
  note?: string;
  count?: ReactNode;
  action?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`control-card ${className}`.trim()}>
      <div className="card-title">
        {Icon && <span><Icon weight="duotone" /></span>}
        <div><h2>{title}</h2>{note && <p>{note}</p>}</div>
        {action && <div className="card-action">{action}</div>}
        {count !== undefined && count !== null && <b className="card-count">{count}</b>}
      </div>
      {toolbar}
      {children}
    </section>
  );
}

export function StatStrip({ items }: { items: Array<{ label: string; value: ReactNode; note?: string; icon?: IconComponent }> }) {
  return <div className="stat-strip">
    {items.map(({ label, value, note, icon: Icon }) => (
      <div key={label}>
        <small>{label}</small>
        <strong>{value}</strong>
        <p>{note ?? ""}</p>
        {Icon && <Icon />}
      </div>
    ))}
  </div>;
}

export function KeyValueList({ rows }: { rows: Array<{ label: string; value: ReactNode }> }) {
  return <dl className="kv-list">
    {rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
  </dl>;
}

/* ------------------------------------------------------------------ toolbar */

export function SearchField({
  value,
  onChange,
  placeholder = "搜索…",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return <label className="task-search">
    <MagnifyingGlass />
    <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    {value && <button type="button" aria-label="清空搜索" onClick={() => onChange("")}><X /></button>}
  </label>;
}

export function FilterChips<T extends string>({
  options,
  value,
  onChange,
  counts,
}: {
  options: Array<{ id: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  counts?: Partial<Record<T, number>>;
}) {
  return <div className="task-filters">
    {options.map((option) => (
      <button
        type="button"
        key={option.id}
        className={`filter-chip ${value === option.id ? "active" : ""}`}
        onClick={() => onChange(option.id)}
      >
        {option.label}
        {counts?.[option.id] !== undefined && <em>{counts[option.id]}</em>}
      </button>
    ))}
  </div>;
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="ui-toolbar">{children}</div>;
}

/* --------------------------------------------------- loading / empty / error */

export function LoadingState({ label = "正在加载…" }: { label?: string }) {
  return <div className="placeholder"><span className="spinner" /><p>{label}</p></div>;
}

export function EmptyState({
  icon: Icon = Info,
  title,
  note,
  action,
}: {
  icon?: IconComponent;
  title: string;
  note?: string;
  action?: ReactNode;
}) {
  return <div className="placeholder empty-state">
    <Icon />
    <p><strong>{title}</strong>{note && <small>{note}</small>}</p>
    {action}
  </div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="placeholder error-state">
    <WarningCircle />
    <p><strong>加载失败</strong><small>{message}</small></p>
    {onRetry && <button type="button" className="ghost-action" onClick={onRetry}>重试</button>}
  </div>;
}

export function SampleBanner({ note }: { note?: string }) {
  return <div className="sample-banner">
    <Warning />
    <p><strong>示例数据</strong>{note ?? "本页尚未接入后端接口，数据保存在浏览器本地存储中，仅用于演示交互。"}</p>
  </div>;
}

/* ------------------------------------------------------------------- modals */

export function Modal({
  open,
  onClose,
  title,
  description,
  footer,
  children,
  variant = "center",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  footer?: ReactNode;
  children: ReactNode;
  variant?: "center" | "side";
}) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return <div className={`ui-overlay ${variant}`} role="presentation" onClick={onClose}>
    <div
      className={`ui-modal ${variant}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(event) => event.stopPropagation()}
    >
      <header className="ui-modal-head">
        <div><h2 id={titleId}>{title}</h2>{description && <p>{description}</p>}</div>
        <button type="button" aria-label="关闭" onClick={onClose}><X /></button>
      </header>
      <div className="ui-modal-body">{children}</div>
      {footer && <footer className="ui-modal-foot">{footer}</footer>}
    </div>
  </div>;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "确认删除",
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return <Modal
    open={open}
    onClose={onClose}
    title={title}
    description={message}
    footer={<>
      <button type="button" className="ghost-action" onClick={onClose}>取消</button>
      <button type="button" className="danger-action" onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</button>
    </>}
  >
    <p className="confirm-hint">该操作会立即影响当前列表，请确认后继续。</p>
  </Modal>;
}

/* -------------------------------------------------------------------- forms */

export function FormGrid({
  children,
  columns = 2,
  className = "",
}: {
  children: ReactNode;
  columns?: 1 | 2;
  /* 允许调用点补一个语义类名（例如设置页要限宽）。 */
  className?: string;
}) {
  return <div className={`form-grid cols-${columns} ${className}`.trim()}>{children}</div>;
}

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return <div className={`form-field ${error ? "has-error" : ""}`}>
    <label>{label}{required && <em>*</em>}</label>
    {children}
    {error ? <small className="field-error">{error}</small> : hint ? <small className="form-hint">{hint}</small> : null}
  </div>;
}

export function TextInput({
  value,
  onChange,
  placeholder,
  invalid,
  type = "text",
  autoComplete,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  invalid?: boolean;
  /** 密码字段用 password；默认 text，保持既有调用点不变。 */
  type?: "text" | "password" | "email";
  autoComplete?: string;
}) {
  return <input
    className="ui-input"
    type={type}
    value={value}
    placeholder={placeholder}
    autoComplete={autoComplete}
    aria-invalid={invalid || undefined}
    onChange={(event) => onChange(event.target.value)}
  />;
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 4,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return <textarea className="ui-textarea" rows={rows} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />;
}

export function SelectInput<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return <select className="ui-select" value={value} onChange={(event) => onChange(event.target.value as T)}>
    {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>;
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return <input
    className="ui-input"
    type="number"
    value={value}
    min={min}
    max={max}
    step={step}
    onChange={(event) => onChange(Number(event.target.value))}
  />;
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; label?: string }) {
  return <button
    type="button"
    aria-label={label ?? "切换状态"}
    aria-pressed={checked}
    className={`toggle ${checked ? "on" : ""}`}
    disabled={disabled}
    onClick={() => onChange(!checked)}
  ><i /></button>;
}

export function SwitchRow({
  title,
  note,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  note: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return <div className="switch-row">
    <span><strong>{title}</strong><small>{note}</small></span>
    <Switch checked={checked} onChange={onChange} disabled={disabled} label={title} />
  </div>;
}

export function ProgressMeter({ value, max, tone = "ok", compact }: { value: number; max: number; tone?: Tone; compact?: boolean }) {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return <div className={`meter ${compact ? "compact" : ""}`}>
    <div className="meter-track"><i className={`meter-fill ${tone}`} style={{ width: `${percent}%` }} /></div>
    <small>{percent}%</small>
  </div>;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ id: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return <div className="segmented">
    {options.map((option) => (
      <button
        type="button"
        key={option.id}
        className={value === option.id ? "active" : ""}
        onClick={() => onChange(option.id)}
      >{option.label}</button>
    ))}
  </div>;
}

/* Small helper shared by config pages: a header action button. */
export function ActionButton({
  icon: Icon,
  children,
  onClick,
  variant = "default",
  disabled,
  type = "button",
}: {
  icon?: IconComponent;
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "ghost" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return <button type={type} className={`${variant === "default" ? "" : `${variant}-action`} action-btn`} onClick={onClick} disabled={disabled}>
    {Icon && <Icon />}{children}
  </button>;
}
