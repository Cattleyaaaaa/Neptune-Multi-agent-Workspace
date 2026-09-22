"use client";

import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { CalendarBlank } from "@phosphor-icons/react/dist/csr/CalendarBlank";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { PencilSimple } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { Play } from "@phosphor-icons/react/dist/csr/Play";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { Timer } from "@phosphor-icons/react/dist/csr/Timer";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { useMemo, useState } from "react";
import { WorkspacePage } from "../ui/shell";
import {
  Card, ConfirmDialog, Field, FilterChips, FormGrid, LoadingState, Modal,
  Pill, SampleBanner, SearchField, SegmentedControl, SelectInput, StatStrip,
  SwitchRow, TextArea, TextInput, Toolbar, useNotice,
} from "../ui/primitives";
import { DataTable, IconButton, RowActions, type Column } from "../ui/table";
import { useCollection } from "../ui/store";
import {
  cronLabels, cronOptions, formatDateTime, nextRunFromCron, omitId, scheduleSeeds,
  type RunStatus, type Schedule,
} from "../ui/data";

type StatusFilter = "all" | "enabled" | "paused" | "error";

const runStatusMeta: Record<RunStatus, { label: string; tone: "ok" | "danger" | "info" | "neutral" }> = {
  success: { label: "成功", tone: "ok" },
  failed: { label: "失败", tone: "danger" },
  running: { label: "运行中", tone: "info" },
  skipped: { label: "已跳过", tone: "neutral" },
  never: { label: "未运行", tone: "neutral" },
};

const emptyDraft: Omit<Schedule, "id"> = {
  name: "",
  objective: "",
  cron: "0 9 * * *",
  timezone: "Asia/Shanghai",
  enabled: true,
  mode: "auto",
  riskLevel: "low",
  notify: "on_failure",
  lastRunAt: null,
  lastStatus: "never",
  nextRunAt: null,
  runCount: 0,
  failureCount: 0,
  owner: "陈立",
  createdAt: "",
};

/* 定时任务: 把「任务目标 + 调度表达式」注册成可重复运行的计划。执行本身仍由
   Supervisor 引擎完成，本页只负责计划的管理与运行状态追踪。 */
export default function SchedulesPage() {
  const { items, ready, create, update, remove } = useCollection<Schedule>("schedules", scheduleSeeds);
  const { notice, push, clear } = useNotice();

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [owner, setOwner] = useState("all");
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [draft, setDraft] = useState<Omit<Schedule, "id">>(emptyDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formOpen, setFormOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Schedule | null>(null);

  const owners = useMemo(() => ["all", ...Array.from(new Set(items.map((item) => item.owner)))], [items]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return items.filter((item) => {
      if (status === "enabled" && !item.enabled) return false;
      if (status === "paused" && item.enabled) return false;
      if (status === "error" && item.lastStatus !== "failed") return false;
      if (owner !== "all" && item.owner !== owner) return false;
      if (!keyword) return true;
      return item.name.toLowerCase().includes(keyword)
        || item.objective.toLowerCase().includes(keyword)
        || (cronLabels[item.cron] ?? item.cron).toLowerCase().includes(keyword);
    });
  }, [items, query, status, owner]);

  const detail = items.find((item) => item.id === detailId) ?? null;

  const metrics = useMemo(() => {
    const enabled = items.filter((item) => item.enabled).length;
    const totalRuns = items.reduce((sum, item) => sum + item.runCount, 0);
    const failures = items.reduce((sum, item) => sum + item.failureCount, 0);
    const rate = totalRuns ? Math.round(((totalRuns - failures) / totalRuns) * 100) : 100;
    return [
      { label: "启用中的计划", value: enabled, note: `共 ${items.length} 条计划`, icon: Clock },
      { label: "累计执行", value: totalRuns, note: "含手动与自动触发", icon: Play },
      { label: "近 30 日成功率", value: `${rate}%`, note: `${failures} 次失败待复盘`, icon: CheckCircle },
      { label: "异常计划", value: items.filter((item) => item.lastStatus === "failed").length, note: "上次执行失败", icon: WarningCircle },
    ];
  }, [items]);

  function openCreate() {
    setEditing(null);
    setDraft({ ...emptyDraft, createdAt: new Date().toISOString() });
    setErrors({});
    setFormOpen(true);
  }

  function openEdit(schedule: Schedule) {
    setEditing(schedule);
    setDraft(omitId(schedule));
    setErrors({});
    setFormOpen(true);
  }

  function submit() {
    const next: Record<string, string> = {};
    if (!draft.name.trim()) next.name = "请填写计划名称";
    if (draft.objective.trim().length < 10) next.objective = "任务目标至少 10 个字符，便于 Planner 理解";
    setErrors(next);
    if (Object.keys(next).length) return;

    const nextRunAt = draft.enabled ? nextRunFromCron(draft.cron) : null;
    if (editing) {
      update(editing.id, { ...draft, nextRunAt });
      push(`已更新计划「${draft.name}」`);
    } else {
      create({ ...draft, createdAt: draft.createdAt || new Date().toISOString(), nextRunAt });
      push(`已创建计划「${draft.name}」，下次运行见列表`);
    }
    setFormOpen(false);
  }

  function toggle(schedule: Schedule, enabled: boolean) {
    update(schedule.id, {
      enabled,
      nextRunAt: enabled ? nextRunFromCron(schedule.cron) : null,
    });
    push(enabled ? `已启用「${schedule.name}」` : `已暂停「${schedule.name}」`);
  }

  function runNow(schedule: Schedule) {
    update(schedule.id, {
      lastStatus: "running",
      lastRunAt: new Date().toISOString(),
      runCount: schedule.runCount + 1,
    });
    push(`已为「${schedule.name}」提交一次运行请求，可在运行中心查看进度`);
  }

  const columns: Array<Column<Schedule>> = [
    {
      key: "name",
      header: "计划",
      sortValue: (row) => row.name,
      render: (row) => <span className="cell-title">
        <strong>{row.name}</strong>
        <small>{row.objective}</small>
      </span>,
    },
    {
      key: "cron",
      header: "调度",
      sortValue: (row) => row.cron,
      render: (row) => <span className="cell-stack">
        <strong>{cronLabels[row.cron] ?? row.cron}</strong>
        <small className="mono">{row.cron} · {row.timezone}</small>
      </span>,
    },
    {
      key: "lastRunAt",
      header: "上次运行",
      sortValue: (row) => row.lastRunAt ?? "",
      render: (row) => <span className="cell-stack">
        <strong>{formatDateTime(row.lastRunAt)}</strong>
        <Pill tone={runStatusMeta[row.lastStatus].tone}>{runStatusMeta[row.lastStatus].label}</Pill>
      </span>,
    },
    {
      key: "nextRunAt",
      header: "下次运行",
      secondary: true,
      sortValue: (row) => row.nextRunAt ?? "",
      render: (row) => row.enabled
        ? <span className="cell-stack"><strong>{formatDateTime(row.nextRunAt)}</strong><small>{row.mode === "plan_only" ? "仅生成计划" : "自动执行"}</small></span>
        : <Pill tone="neutral">已暂停</Pill>,
    },
    {
      key: "runCount",
      header: "执行 / 失败",
      align: "right",
      secondary: true,
      sortValue: (row) => row.runCount,
      render: (row) => <span className="cell-stack right">
        <strong>{row.runCount}</strong>
        <small className={row.failureCount ? "text-danger" : ""}>{row.failureCount} 次失败</small>
      </span>,
    },
    {
      key: "actions",
      header: "操作",
      align: "right",
      render: (row) => <RowActions>
        <IconButton icon={Play} label="立即运行" onClick={() => runNow(row)} />
        <IconButton icon={row.enabled ? Timer : Clock} label={row.enabled ? "暂停" : "启用"} onClick={() => toggle(row, !row.enabled)} />
        <IconButton icon={PencilSimple} label="编辑" onClick={() => openEdit(row)} />
        <IconButton icon={Trash} label="删除" tone="danger" onClick={() => setPendingDelete(row)} />
      </RowActions>,
    },
  ];

  return <WorkspacePage
    active="schedules"
    note="把重复发生的工作注册为计划：填写任务目标与调度表达式，由 Supervisor 引擎按节奏执行。可以暂停、立即试跑并追踪每次执行结果。"
    notice={notice}
    onDismissNotice={clear}
    actions={<>
      <button type="button" onClick={() => push("计划状态已同步（示例数据）", "info")}><ArrowsClockwise />刷新</button>
      <button type="button" className="save action-btn" onClick={openCreate}><Plus />新建计划</button>
    </>}
  >
    <SampleBanner note="定时任务的持久化与调度触发尚未接入后端，计划与运行记录保存在浏览器本地存储中。" />

    <StatStrip items={metrics} />

    <Card
      icon={Clock}
      title="计划列表"
      note="支持按名称、目标或调度搜索，点击任意行查看运行详情"
      count={filtered.length}
      toolbar={<Toolbar>
        <SearchField value={query} onChange={setQuery} placeholder="搜索计划名称、任务目标或调度" />
        <div className="toolbar-filters">
          <FilterChips<StatusFilter>
            value={status}
            onChange={setStatus}
            options={[
              { id: "all", label: "全部" },
              { id: "enabled", label: "启用中" },
              { id: "paused", label: "已暂停" },
              { id: "error", label: "上次失败" },
            ]}
            counts={{
              all: items.length,
              enabled: items.filter((item) => item.enabled).length,
              paused: items.filter((item) => !item.enabled).length,
              error: items.filter((item) => item.lastStatus === "failed").length,
            }}
          />
          <SelectInput
            value={owner}
            onChange={setOwner}
            options={owners.map((item) => ({ value: item, label: item === "all" ? "全部负责人" : item }))}
          />
        </div>
      </Toolbar>}
    >
      {!ready
        ? <LoadingState label="正在读取本地计划…" />
        : <DataTable<Schedule>
          columns={columns}
          rows={filtered}
          rowKey={(row) => row.id}
          activeKey={detailId}
          onRowClick={(row) => setDetailId(row.id)}
          emptyTitle={items.length ? "没有匹配的计划" : "还没有定时任务"}
          emptyNote={items.length ? "试着调整筛选条件或搜索关键词。" : "创建第一条计划，让重复性工作自动跑起来。"}
          emptyAction={items.length
            ? <button type="button" className="ghost-action" onClick={() => { setQuery(""); setStatus("all"); setOwner("all"); }}>清除筛选</button>
            : <button type="button" className="primary-action action-btn" onClick={openCreate}><Plus />新建计划</button>}
        />}
    </Card>

    <Modal
      open={formOpen}
      onClose={() => setFormOpen(false)}
      title={editing ? `编辑计划 · ${editing.name}` : "新建定时任务"}
      description="任务目标会被原样发送给 Supervisor 引擎，请像写一条运行中心指令一样描述它。"
      footer={<>
        <button type="button" className="ghost-action" onClick={() => setFormOpen(false)}>取消</button>
        <button type="button" className="primary-action action-btn" onClick={submit}>{editing ? "保存更改" : "创建计划"}</button>
      </>}
    >
      <FormGrid>
        <Field label="计划名称" required error={errors.name}>
          <TextInput value={draft.name} onChange={(value) => setDraft((current) => ({ ...current, name: value }))} placeholder="例如：每日行业简报" invalid={Boolean(errors.name)} />
        </Field>
        <Field label="负责人">
          <TextInput value={draft.owner} onChange={(value) => setDraft((current) => ({ ...current, owner: value }))} />
        </Field>
      </FormGrid>

      <Field label="任务目标" required error={errors.objective} hint="写给 Planner 的完整指令，包含范围、输出格式与约束。">
        <TextArea value={draft.objective} onChange={(value) => setDraft((current) => ({ ...current, objective: value }))} rows={4} placeholder="例如：汇总过去 24 小时行业动态，产出带来源的简报草稿并标注待核实项。" />
      </Field>

      <FormGrid>
        <Field label="调度频率" required hint={draft.cron}>
          <SelectInput value={draft.cron} onChange={(value) => setDraft((current) => ({ ...current, cron: value }))} options={cronOptions} />
        </Field>
        <Field label="时区">
          <SelectInput
            value={draft.timezone}
            onChange={(value) => setDraft((current) => ({ ...current, timezone: value }))}
            options={[
              { value: "Asia/Shanghai", label: "Asia/Shanghai (UTC+8)" },
              { value: "UTC", label: "UTC" },
              { value: "Asia/Tokyo", label: "Asia/Tokyo (UTC+9)" },
            ]}
          />
        </Field>
        <Field label="运行模式" hint="仅生成计划不会真正调用工具与执行。">
          <SegmentedControl
            value={draft.mode}
            onChange={(value) => setDraft((current) => ({ ...current, mode: value }))}
            options={[{ id: "auto", label: "自动执行" }, { id: "plan_only", label: "仅生成计划" }]}
          />
        </Field>
        <Field label="风险等级" hint="高风险动作会在执行前暂停等待人工审批。">
          <SelectInput
            value={draft.riskLevel}
            onChange={(value) => setDraft((current) => ({ ...current, riskLevel: value }))}
            options={[
              { value: "low", label: "低风险" },
              { value: "medium", label: "中风险" },
              { value: "high", label: "高风险" },
            ]}
          />
        </Field>
      </FormGrid>

      <SwitchRow
        title="启用计划"
        note="关闭后保留配置但不再按调度触发"
        checked={draft.enabled}
        onChange={(value) => setDraft((current) => ({ ...current, enabled: value }))}
      />

      <Field label="通知策略">
        <SelectInput
          value={draft.notify}
          onChange={(value) => setDraft((current) => ({ ...current, notify: value }))}
          options={[
            { value: "none", label: "不通知" },
            { value: "on_failure", label: "仅失败时通知" },
            { value: "always", label: "每次执行后通知" },
          ]}
        />
      </Field>
    </Modal>

    <Modal
      open={Boolean(detail)}
      onClose={() => setDetailId(null)}
      variant="side"
      title={detail?.name ?? ""}
      description={detail ? `${cronLabels[detail.cron] ?? detail.cron} · ${detail.timezone}` : undefined}
      footer={detail && <>
        <button type="button" className="ghost-action" onClick={() => setDetailId(null)}>关闭</button>
        <button type="button" className="primary-action action-btn" onClick={() => { runNow(detail); setDetailId(null); }}>立即运行</button>
      </>}
    >
      {detail && <div className="detail-stack">
        <div className="detail-badges">
          <Pill tone={detail.enabled ? "ok" : "neutral"}>{detail.enabled ? "启用中" : "已暂停"}</Pill>
          <Pill tone={runStatusMeta[detail.lastStatus].tone}>{runStatusMeta[detail.lastStatus].label}</Pill>
          <Pill tone={detail.riskLevel === "high" ? "danger" : detail.riskLevel === "medium" ? "warn" : "info"}>
            {detail.riskLevel === "high" ? "高风险" : detail.riskLevel === "medium" ? "中风险" : "低风险"}
          </Pill>
        </div>

        <section className="detail-block">
          <h3>任务目标</h3>
          <p>{detail.objective}</p>
        </section>

        <section className="detail-block">
          <h3>调度信息</h3>
          <dl className="kv-list">
            <div><dt>表达式</dt><dd className="mono">{detail.cron}</dd></div>
            <div><dt>频率</dt><dd>{cronLabels[detail.cron] ?? "自定义"}</dd></div>
            <div><dt>上次运行</dt><dd>{formatDateTime(detail.lastRunAt)}</dd></div>
            <div><dt>下次运行</dt><dd>{detail.enabled ? formatDateTime(detail.nextRunAt) : "已暂停"}</dd></div>
          </dl>
        </section>

        <section className="detail-block">
          <h3>运行统计</h3>
          <dl className="kv-list">
            <div><dt>累计执行</dt><dd>{detail.runCount} 次</dd></div>
            <div><dt>失败次数</dt><dd>{detail.failureCount} 次</dd></div>
            <div><dt>成功率</dt><dd>{detail.runCount ? `${Math.round(((detail.runCount - detail.failureCount) / detail.runCount) * 100)}%` : "—"}</dd></div>
            <div><dt>负责人</dt><dd>{detail.owner}</dd></div>
            <div><dt>创建时间</dt><dd>{formatDateTime(detail.createdAt)}</dd></div>
          </dl>
        </section>

        <section className="detail-block">
          <h3>默认行为</h3>
          <FormGrid columns={2}>
            <Field label="运行模式"><div className="readonly-field">{detail.mode === "auto" ? "自动执行" : "仅生成计划"}</div></Field>
            <Field label="通知"><div className="readonly-field">{detail.notify === "none" ? "不通知" : detail.notify === "on_failure" ? "仅失败时" : "每次执行后"}</div></Field>
          </FormGrid>
        </section>

        <div className="detail-actions">
          <button type="button" className="ghost-action" onClick={() => toggle(detail, !detail.enabled)}>{detail.enabled ? "暂停计划" : "启用计划"}</button>
          <button type="button" className="ghost-action" onClick={() => { openEdit(detail); setDetailId(null); }}><PencilSimple />编辑</button>
          <button type="button" className="danger-action" onClick={() => { setPendingDelete(detail); setDetailId(null); }}><Trash />删除</button>
        </div>

        <p className="page-note"><CalendarBlank /> 运行记录来自本地示例数据，接入后端后将展示每次执行的完整事件流。</p>
      </div>}
    </Modal>

    <ConfirmDialog
      open={Boolean(pendingDelete)}
      title="删除定时任务"
      message={pendingDelete ? `「${pendingDelete.name}」及其运行记录将被移除。` : ""}
      onConfirm={() => {
        if (!pendingDelete) return;
        remove(pendingDelete.id);
        push(`已删除「${pendingDelete.name}」`);
      }}
      onClose={() => setPendingDelete(null)}
    />

    <p className="page-note">扩展点：接入后端调度器后，这里会展示真实的下次运行时间、每次执行的完整事件流与告警通知记录；「立即运行」将改为真实触发一次任务运行。</p>
  </WorkspacePage>;
}
