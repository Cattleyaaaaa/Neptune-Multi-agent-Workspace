"use client";

/* Dependency-free chart set. The workbench ships no chart library, so the
   monitoring pages render SVG / CSS primitives that inherit the palette. */

import type { ReactNode } from "react";
import { Fragment } from "react";

const PALETTE = ["#2f6b4f", "#6fa87f", "#a8cf7a", "#d8c56a", "#c98b5e", "#8c9aa3"];

export type Series = { label: string; value: number; tone?: string };

export function BarChart({
  data,
  height = 210,
  unit = "",
  formatValue,
}: {
  data: Series[];
  height?: number;
  unit?: string;
  formatValue?: (value: number) => string;
}) {
  const max = Math.max(...data.map((item) => item.value), 1);
  return <div className="bar-chart" style={{ height }}>
    {data.map((item) => {
      const percent = Math.round((item.value / max) * 100);
      return <div className="bar-col" key={item.label}>
        <span className="bar-value">{formatValue ? formatValue(item.value) : item.value}{unit}</span>
        <div className="bar-track">
          <i style={{ height: `${Math.max(percent, 2)}%`, background: item.tone ?? undefined }} />
        </div>
        <small>{item.label}</small>
      </div>;
    })}
  </div>;
}

/** Stacked columns: used for token 用量（输入/输出）. */
export function StackedBarChart({
  data,
  height = 210,
  formatValue,
}: {
  data: Array<{ label: string; parts: Array<{ label: string; value: number; color: string }> }>;
  height?: number;
  formatValue?: (value: number) => string;
}) {
  return <div className="bar-chart stacked" style={{ height }}>
    {data.map((column) => {
      const total = column.parts.reduce((sum, part) => sum + part.value, 0);
      const max = Math.max(...data.map((item) => item.parts.reduce((sum, part) => sum + part.value, 0)), 1);
      return <div className="bar-col" key={column.label}>
        <span className="bar-value">{formatValue ? formatValue(total) : total}</span>
        <div className="bar-track">
          <div className="bar-stack" style={{ height: `${Math.max(Math.round((total / max) * 100), 2)}%` }}>
            {column.parts.map((part) => <i key={part.label} style={{ flex: part.value, background: part.color }} />)}
          </div>
        </div>
        <small>{column.label}</small>
      </div>;
    })}
  </div>;
}

export function LineChart({
  series,
  height = 220,
  formatValue,
}: {
  series: Array<{ label: string; color: string; points: number[] }>;
  height?: number;
  formatValue?: (value: number) => string;
}) {
  const width = 640;
  const padding = { top: 16, right: 12, bottom: 26, left: 12 };
  const all = series.flatMap((item) => item.points);
  const max = Math.max(...all, 1);
  const min = Math.min(...all, 0);
  const span = Math.max(max - min, 1);
  const labels = series[0]?.points.length ?? 0;

  const x = (index: number) => padding.left
    + (index / Math.max(labels - 1, 1)) * (width - padding.left - padding.right);
  const y = (value: number) => padding.top
    + (1 - (value - min) / span) * (height - padding.top - padding.bottom);

  return <div className="line-chart">
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="时间序列趋势">
      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => <line
        key={ratio}
        x1={padding.left}
        x2={width - padding.right}
        y1={padding.top + ratio * (height - padding.top - padding.bottom)}
        y2={padding.top + ratio * (height - padding.top - padding.bottom)}
        className="grid-line"
      />)}
      {series.map((item) => {
        const d = item.points.map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
        const area = `${d} L${x(item.points.length - 1).toFixed(1)},${y(min)} L${x(0).toFixed(1)},${y(min)} Z`;
        return <g key={item.label}>
          <path d={area} fill={item.color} opacity="0.10" />
          <path d={d} fill="none" stroke={item.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </g>;
      })}
    </svg>
    <div className="line-legend">
      {series.map((item) => <span key={item.label}><i style={{ background: item.color }} />{item.label}
        <b>{formatValue ? formatValue(item.points[item.points.length - 1] ?? 0) : item.points[item.points.length - 1] ?? 0}</b>
      </span>)}
    </div>
  </div>;
}

export function DonutChart({
  segments,
  centerLabel,
  centerValue,
}: {
  segments: Series[];
  centerLabel: string;
  centerValue: ReactNode;
}) {
  const total = segments.reduce((sum, item) => sum + item.value, 0) || 1;
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return <div className="donut-chart">
    <svg viewBox="0 0 140 140" role="img" aria-label={centerLabel}>
      <circle cx="70" cy="70" r={radius} fill="none" stroke="#eef2ef" strokeWidth="18" />
      {segments.map((segment, index) => {
        const length = (segment.value / total) * circumference;
        const element = <circle
          key={segment.label}
          cx="70"
          cy="70"
          r={radius}
          fill="none"
          stroke={segment.tone ?? PALETTE[index % PALETTE.length]}
          strokeWidth="18"
          strokeDasharray={`${length} ${circumference - length}`}
          strokeDashoffset={-offset}
          strokeLinecap="butt"
          transform="rotate(-90 70 70)"
        />;
        offset += length;
        return element;
      })}
      <text x="70" y="66" textAnchor="middle" className="donut-value">{centerValue}</text>
      <text x="70" y="86" textAnchor="middle" className="donut-label">{centerLabel}</text>
    </svg>
    <ul className="donut-legend">
      {segments.map((segment, index) => <li key={segment.label}>
        <i style={{ background: segment.tone ?? PALETTE[index % PALETTE.length] }} />
        <span>{segment.label}</span>
        <b>{Math.round((segment.value / total) * 100)}%</b>
      </li>)}
    </ul>
  </div>;
}

/** Horizontal ranked bars — top tools / top agents / failure hotspots. */
export function RankList({
  items,
  formatValue,
  unit = "",
}: {
  items: Series[];
  formatValue?: (value: number) => string;
  unit?: string;
}) {
  const max = Math.max(...items.map((item) => item.value), 1);
  return <ul className="rank-list">
    {items.map((item, index) => <li key={item.label}>
      <span className="rank-index">{String(index + 1).padStart(2, "0")}</span>
      <span className="rank-label">{item.label}</span>
      <span className="rank-track"><i style={{ width: `${Math.max((item.value / max) * 100, 3)}%`, background: item.tone }} /></span>
      <b>{formatValue ? formatValue(item.value) : item.value}{unit}</b>
    </li>)}
  </ul>;
}

/** 7 × 24 activity heat grid, used by 可观测性 for hourly load. */
export function HeatGrid({
  rows,
  columns,
  values,
  formatValue,
}: {
  rows: string[];
  columns: string[];
  values: number[][];
  formatValue?: (value: number) => string;
}) {
  const max = Math.max(...values.flat(), 1);
  return <div className="heat-grid" style={{ gridTemplateColumns: `64px repeat(${columns.length}, minmax(0, 1fr))` }}>
    <span className="heat-corner" />
    {columns.map((column) => <span className="heat-col-label" key={column}>{column}</span>)}
    {rows.map((row, rowIndex) => <Fragment key={row}>
      <span className="heat-row-label">{row}</span>
      {columns.map((column, columnIndex) => {
        const value = values[rowIndex]?.[columnIndex] ?? 0;
        const intensity = value / max;
        return <span
          className="heat-cell"
          key={`${row}-${column}`}
          title={`${row} ${column} · ${formatValue ? formatValue(value) : value}`}
          style={{ background: intensity === 0 ? "#f2f6f3" : `rgba(47, 107, 79, ${0.14 + intensity * 0.76})` }}
        />;
      })}
    </Fragment>)}
  </div>;
}
