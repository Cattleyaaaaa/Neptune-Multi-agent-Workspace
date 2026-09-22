"use client";

/* Table workhorse for the workbench list pages: sorting, pagination, empty /
   loading / error states and a detail-row hook. Columns are declared by the
   page so the table stays generic. */

import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretUp } from "@phosphor-icons/react/dist/csr/CaretUp";
import { CaretLeft } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { Database } from "@phosphor-icons/react/dist/csr/Database";
import { WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { EmptyState, LoadingState } from "./primitives";

export type Column<T> = {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Providing this makes the column sortable. */
  sortValue?: (row: T) => string | number;
  align?: "left" | "right" | "center";
  /** Hidden under 1080px so wide tables never crush their primary column. */
  secondary?: boolean;
};

export type DataTableProps<T> = {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  pageSize?: number;
  loading?: boolean;
  loadingLabel?: string;
  error?: string;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyNote?: string;
  emptyAction?: ReactNode;
  activeKey?: string | null;
  onRowClick?: (row: T) => void;
  rowTone?: (row: T) => string;
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  pageSize = 8,
  loading,
  loadingLabel,
  error,
  onRetry,
  emptyTitle = "暂无数据",
  emptyNote,
  emptyAction,
  activeKey,
  onRowClick,
  rowTone,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);

  const sorted = useMemo(() => {
    const column = columns.find((item) => item.key === sortKey);
    if (!column?.sortValue) return rows;
    const direction = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const left = column.sortValue!(a);
      const right = column.sortValue!(b);
      if (typeof left === "number" && typeof right === "number") return (left - right) * direction;
      return String(left).localeCompare(String(right), "zh-CN") * direction;
    });
  }, [rows, columns, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  useEffect(() => {
    // Filtering can shrink the list under the current page; snap back so the
    // table never renders an empty page while rows exist.
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const visible = useMemo(
    () => sorted.slice((page - 1) * pageSize, page * pageSize),
    [sorted, page, pageSize],
  );

  function toggleSort(column: Column<T>) {
    if (!column.sortValue) return;
    if (sortKey === column.key) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(column.key);
      setSortDir("asc");
    }
    setPage(1);
  }

  if (loading) return <LoadingState label={loadingLabel ?? "正在加载数据…"} />;
  if (error) return <div className="placeholder error-state">
    <WarningCircle />
    <p><strong>加载失败</strong><small>{error}</small></p>
    {onRetry && <button type="button" className="ghost-action" onClick={onRetry}>重试</button>}
  </div>;
  if (!rows.length) return <EmptyState icon={Database} title={emptyTitle} note={emptyNote} action={emptyAction} />;

  return <div className="data-table-wrap">
    <div className="data-table" role="table">
      <div className="dt-head" role="row">
        {columns.map((column) => {
          const sortable = Boolean(column.sortValue);
          return <div
            key={column.key}
            role="columnheader"
            aria-sort={sortKey === column.key ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
            className={`dt-cell ${column.align ?? "left"} ${column.secondary ? "secondary" : ""} ${sortable ? "sortable" : ""}`}
          >
            {sortable
              ? <button type="button" onClick={() => toggleSort(column)}>
                {column.header}
                {sortKey === column.key
                  ? (sortDir === "asc" ? <CaretUp weight="bold" /> : <CaretDown weight="bold" />)
                  : <CaretDown className="sort-idle" weight="bold" />}
              </button>
              : column.header}
          </div>;
        })}
      </div>
      <div className="dt-body" role="rowgroup">
        {visible.map((row) => {
          const key = rowKey(row);
          return <div
            key={key}
            role="row"
            tabIndex={onRowClick ? 0 : undefined}
            className={`dt-row ${onRowClick ? "clickable" : ""} ${activeKey === key ? "active" : ""} ${rowTone?.(row) ?? ""}`.trim()}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            onKeyDown={onRowClick ? (event) => { if (event.key === "Enter") onRowClick(row); } : undefined}
          >
            {columns.map((column) => <div
              key={column.key}
              role="cell"
              className={`dt-cell ${column.align ?? "left"} ${column.secondary ? "secondary" : ""}`}
            >{column.render(row)}</div>)}
          </div>;
        })}
      </div>
    </div>

    <div className="dt-foot">
      <span>共 {rows.length} 条 · 第 {page} / {pageCount} 页</span>
      <div className="pager">
        <button type="button" aria-label="上一页" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}><CaretLeft /></button>
        <button type="button" aria-label="下一页" disabled={page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}><CaretRight /></button>
      </div>
    </div>
  </div>;
}

/* Row action cluster used inside the last column of most tables. */
export function RowActions({ children }: { children: ReactNode }) {
  return <div className="row-actions" onClick={(event) => event.stopPropagation()}>{children}</div>;
}

export function IconButton({
  icon: Icon,
  label,
  onClick,
  tone = "default",
  disabled,
}: {
  icon: React.ComponentType<{ weight?: "thin" | "light" | "regular" | "bold" | "fill" | "duotone" }>;
  label: string;
  onClick: () => void;
  tone?: "default" | "danger";
  disabled?: boolean;
}) {
  return <button type="button" className={`icon-button ${tone}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}><Icon /></button>;
}
