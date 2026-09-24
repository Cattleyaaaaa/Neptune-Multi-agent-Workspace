"use client";

import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { Books } from "@phosphor-icons/react/dist/csr/Books";
import { CalendarBlank } from "@phosphor-icons/react/dist/csr/CalendarBlank";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { PencilSimple } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { Play } from "@phosphor-icons/react/dist/csr/Play";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { Timer } from "@phosphor-icons/react/dist/csr/Timer";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, apiUrl, toErrorMessage } from "../../auth/api";
import { WorkspacePage } from "../ui/shell";
import {
  Card, ConfirmDialog, ErrorState, Field, FilterChips, FormGrid, LoadingState, Modal,
  Pill, SearchField, SegmentedControl, SelectInput, StatStrip, SwitchRow, TextArea,
  TextInput, Toolbar, useNotice,
} from "../ui/primitives";
import { DataTable, IconButton, RowActions, type Column } from "../ui/table";
import { formatDateTime } from "../ui/data";
import { agentLabels } from "../runtime/shared";

/* 后端 /api/schedules 的真实模型：配置落 SQLite，后台循环每 30 秒检查到期
   并真的跑一次任务，跑出来的 task_id 会回写到 last_task_id。 */
type ScheduleView = {
  schedule_id: string;
  name: string;
  objective: string;
  cron: string;
  enabled: boolean;
  agent: string;
  use_knowledge_base: boolean;
  execution_mode: "auto" | "plan_only";
  run_mode: "graph" | "react";
  execution_target: Record<string, unknown> | null;
  last_run_at: string;
  last_task_id: string;
  next_run_at: string;
  created_at: string;
  updated_at: string;
};

type ScheduleDraft = Pick<ScheduleView,
  "name" | "objective" | "cron" | "enabled" | "agent" | "use_knowledge_base"
  | "execution_mode" | "run_mode">;

type StatusFilter = "all" | "enabled" | "paused" | "ran";

const emptyDraft: ScheduleDraft = {
  name: "",
  objective: "",
  cron: "0 9 * * *",
  enabled: true,
  agent: "auto",
  use_knowledge_base: true,
  execution_mode: "auto",
  run_mode: "graph",
};

/* 后端支持标准五段（分 时 日 月 周），字段允许通配、步长、数字与逗号列表。
   这里只给常用预设，输入框里可以填任意合法表达式。 */
const cronPresets = [
  { value: "*/30 * * * *", label: "每 30 分钟" },
  { value: "0 * * * *", label: "每小时整点" },
  { value: "0 9 * * *", label: "每天 9:00" },
  { value: "0 9 * * 1", label: "每周一 9:00" },
  { value: "0 8 1 * *", label: "每月 1 日 8:00" },
];

const CRON_HINT = "五段表达式：分 时 日 月 周，支持 *、*/n、数字与逗号列表";

const AGENT_IDS = ["research_agent", "data_agent", "code_agent", "document_agent", "review_agent"];

const agentOptions = [
  { value: "auto", label: "自动分派" },
  ...AGENT_IDS.map((id) => ({ value: id, label: agentLabels[id] ?? id })),
];

const executionModeLabels: Record<ScheduleView["execution_mode"], string> = {
  auto: "自动执行",
  plan_only: "仅生成计划",
};

const runModeLabels: Record<ScheduleView["run_mode"], string> = {
  graph: "图编排",
  react: "ReAct 循环",
};

function agentLabel(agent: string) {
  return agent === "auto" ? "自动分派" : agentLabels[agent] ?? agent;
}

/* 定时任务：计划配置由后端持久化，后台调度循环真的会按 cron 触发执行。
   本页只负责增删改查与「立即执行」，触发结果直接写回这条记录。 */
export default function SchedulesPage() {
  const { notice, push, clear } = useNotice();
  const [items, setItems] = useState<ScheduleView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [detail, setDetail] = useState<ScheduleView | null>(null);
  const [editing, setEditing] = useState<ScheduleView | null>(null);
  const [draft, setDraft] = useState<ScheduleDraft>(emptyDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [running, setRunning] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ScheduleView | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await apiFetch(apiUrl("/api/schedules"));
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(toErrorMessage(payload, "无法读取定时任务"));
      }
      setItems((await response.json()) as ScheduleView[]);
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "无法读取定时任务，请确认后端已启动。");
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return items.filter((item) => {
      if (status === "enabled" && !item.enabled) return false;
      if (status === "paused" && item.enabled) return false;
      if (status === "ran" && !item.last_task_id) return false;
      if (!keyword) return true;
      return item.name.toLowerCase().includes(keyword)
        || item.objective.toLowerCase().includes(keyword)
        || item.cron.toLowerCase().includes(keyword);
    });
  }, [items, query, status]);

  const metrics = useMemo(() => {
    const enabled = items.filter((item) => item.enabled).length;
    const ran = items.filter((item) => item.last_task_id).length;
    const stamps = items.map((item) => item.last_run_at).filter(Boolean).sort();
    return [
      { label: "计划总数", value: items.length, note: `${enabled} 条已启用`, icon: Clock },
      { label: "启用中", value: enabled, note: `${items.length - enabled} 条已暂停`, icon: Timer },
      { label: "已产生任务", value: ran, note: "后端回写过 task_id", icon: Play },
      { label: "上次执行", value: stamps.length ? formatDateTime(stamps[stamps.length - 1]) : "—", note: "由后端调度器触发", icon: CalendarBlank },
    ];
  }, [items]);

  function applyUpdate(updated: ScheduleView) {
    setItems((state) => state.map((item) => item.schedule_id === updated.schedule_id ? updated : item));
    setDetail((state) => state?.schedule_id === updated.schedule_id ? updated : state);
  }

  function openCreate() {
    setEditing(null);
    setDraft({ ...emptyDraft });
    setErrors({});
    setFormError("");
    setFormOpen(true);
  }

  function openEdit(schedule: ScheduleView) {
    setEditing(schedule);
    setDraft({
      name: schedule.name,
      objective: schedule.objective,
      cron: schedule.cron,
      enabled: schedule.enabled,
      agent: schedule.agent,
      use_knowledge_base: schedule.use_knowledge_base,
      execution_mode: schedule.execution_mode,
      run_mode: schedule.run_mode,
    });
    setErrors({});
    setFormError("");
    setFormOpen(true);
  }

  async function submit() {
    const next: Record<string, string> = {};
    if (!draft.name.trim()) next.name = "请填写计划名称";
    if (draft.objective.trim().length < 3) next.objective = "任务目标至少 3 个字符";
    if (draft.cron.trim().split(/\s+/).length !== 5) next.cron = "cron 需要五段：分 时 日 月 周";
    setErrors(next);
    if (Object.keys(next).length) return;

    const body = { ...draft, name: draft.name.trim(), objective: draft.objective.trim(), cron: draft.cron.trim() };
    setFormError("");
    try {
      const response = await apiFetch(apiUrl(editing ? `/api/schedules/${editing.schedule_id}` : "/api/schedules"), {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setFormError(toErrorMessage(payload, "保存失败，请检查计划配置"));
        return;
      }
      const saved = (await response.json()) as ScheduleView;
      if (editing) {
        applyUpdate(saved);
        push(`已更新计划「${saved.name}」`);
      } else {
        setItems((state) => [...state, saved]);
        push(`已创建计划「${saved.name}」，下次触发 ${formatDateTime(saved.next_run_at)}`);
      }
      setFormOpen(false);
    } catch {
      setFormError("无法连接后端服务，请确认 API 已启动。");
    }
  }

  /* PUT 只送白名单字段：后端会忽略其余键，cron 变了由后端自己重算 next_run_at。 */
  async function patch(schedule: ScheduleView, changes: Record<string, unknown>) {
    try {
      const response = await apiFetch(apiUrl(`/api/schedules/${schedule.schedule_id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        push(toErrorMessage(payload, "更新失败，请稍后重试"), "error");
        return null;
      }
      const updated = (await response.json()) as ScheduleView;
      applyUpdate(updated);
      return updated;
    } catch {
      push("无法连接后端服务，请确认 API 已启动。", "error");
      return null;
    }
  }

  async function toggle(schedule: ScheduleView, enabled: boolean) {
    const updated = await patch(schedule, { enabled });
    if (!updated) return;
    push(enabled
      ? `已启用「${updated.name}」，下次触发 ${formatDateTime(updated.next_run_at)}`
      : `已暂停「${updated.name}」`);
  }

  /* 立即执行一次：不改变 cron，也不改下次触发时间，后端会真的建一个任务。 */
  async function runNow(schedule: ScheduleView) {
    setRunning(schedule.schedule_id);
    try {
      const response = await apiFetch(apiUrl(`/api/schedules/${schedule.schedule_id}/run`), { method: "POST" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        push(toErrorMessage(payload, "执行失败，请稍后重试"), "error");
        return;
      }
      const updated = (await response.json()) as ScheduleView;
      applyUpdate(updated);
      push(updated.last_task_id
        ? `已立即执行「${updated.name}」，任务 ${updated.last_task_id} 已提交`
        : `已立即执行「${updated.name}」`);
    } catch {
      push("无法连接后端服务，请确认 API 已启动。", "error");
    } finally {
      setRunning("");
    }
  }

  async function remove(schedule: ScheduleView) {
    try {
      const response = await apiFetch(apiUrl(`/api/schedules/${schedule.schedule_id}`), { method: "DELETE" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        push(toErrorMessage(payload, "删除失败，请稍后重试"), "error");
        return;
      }
      setItems((state) => state.filter((item) => item.schedule_id !== schedule.schedule_id));
      setDetail(null);
      push(`已删除「${schedule.name}」`);
    } catch {
      push("无法连接后端服务，请确认 API 已启动。", "error");
    }
  }

  const columns: Array<Column<ScheduleView>> = [
    {
      key: "name",
      header: "计划",
      sortValue: (row) => row.name,
      render: (row) => <span className="cell-title">
        <strong>{row.name}{row.enabled ? <Pill tone="ok">启用中</Pill> : <Pill tone="neutral">已暂停</Pill>}</strong>
        <small>{row.objective}</small>
      </span>,
    },
    {
      key: "cron",
      header: "调度",
      sortValue: (row) => row.cron,
      render: (row) => <span className="cell-stack">
        <strong className="mono">{row.cron}</strong>
        <small>{agentLabel(row.agent)} · {executionModeLabels[row.execution_mode] ?? row.execution_mode}</small>
      </span>,
    },
    {
      key: "last_run_at",
      header: "上次执行",
      sortValue: (row) => row.last_run_at,
      render: (row) => <span className="cell-stack">
        <strong>{formatDateTime(row.last_run_at)}</strong>
        {row.last_task_id
          ? <a className="cell-link" href={`/workbench/steps?task=${row.last_task_id}`}>查看任务 {row.last_task_id.slice(0, 8)}</a>
          : <small className="muted-text">尚无执行记录</small>}
      </span>,
    },
    {
      key: "next_run_at",
      header: "下次触发",
      secondary: true,
      sortValue: (row) => row.next_run_at,
      render: (row) => row.enabled
        ? <span className="cell-stack">
          <strong>{formatDateTime(row.next_run_at)}</strong>
          <small>{runModeLabels[row.run_mode] ?? row.run_mode}{row.use_knowledge_base ? " · 用知识库" : ""}</small>
        </span>
        : <Pill tone="neutral">不会触发</Pill>,
    },
    {
      key: "actions",
      header: "操作",
      align: "right",
      render: (row) => <RowActions>
        <IconButton icon={Play} label="立即执行" disabled={running === row.schedule_id} onClick={() => void runNow(row)} />
        <IconButton
          icon={row.enabled ? Timer : Clock}
          label={row.enabled ? "暂停" : "启用"}
          onClick={() => void toggle(row, !row.enabled)}
        />
        <IconButton icon={PencilSimple} label="编辑" onClick={() => openEdit(row)} />
        <IconButton icon={Trash} label="删除" tone="danger" onClick={() => setPendingDelete(row)} />
      </RowActions>,
    },
  ];

  return <WorkspacePage
    active="schedules"
    note="把重复发生的工作注册为计划：填写任务目标与 cron 表达式，后端调度循环每 30 秒检查一次到期计划，到期就用任务服务真的跑一次，并把生成的 task_id 回写到这条计划上。"
    notice={notice}
    onDismissNotice={clear}
    actions={<>
      <button type="button" onClick={() => void load()} disabled={refreshing}>
        <ArrowsClockwise className={refreshing ? "spin" : undefined} />{refreshing ? "同步中…" : "刷新"}
      </button>
      <button type="button" className="save action-btn" onClick={openCreate}><Plus />新建计划</button>
    </>}
  >
    <StatStrip items={metrics} />

    <Card
      icon={Clock}
      title="计划列表"
      note="点击任意行查看执行详情；上次执行的任务可以直接跳到运行步骤"
      count={filtered.length}
      toolbar={<Toolbar>
        <SearchField value={query} onChange={setQuery} placeholder="搜索计划名称、任务目标或 cron" />
        <div className="toolbar-filters">
          <FilterChips<StatusFilter>
            value={status}
            onChange={setStatus}
            options={[
              { id: "all", label: "全部" },
              { id: "enabled", label: "启用中" },
              { id: "paused", label: "已暂停" },
              { id: "ran", label: "已执行过" },
            ]}
            counts={{
              all: items.length,
              enabled: items.filter((item) => item.enabled).length,
              paused: items.filter((item) => !item.enabled).length,
              ran: items.filter((item) => item.last_task_id).length,
            }}
          />
        </div>
      </Toolbar>}
    >
      {!loaded
        ? <LoadingState label="正在读取定时任务…" />
        : loadError
          ? <ErrorState message={loadError} onRetry={() => void load()} />
          : <DataTable<ScheduleView>
            columns={columns}
            rows={filtered}
            rowKey={(row) => row.schedule_id}
            activeKey={detail?.schedule_id ?? null}
            onRowClick={(row) => setDetail(row)}
            emptyTitle={items.length ? "没有匹配的计划" : "还没有定时任务"}
            emptyNote={items.length ? "试着调整筛选条件或搜索关键词。" : "创建第一条计划，后端会按 cron 真的触发执行。"}
            emptyAction={items.length
              ? <button type="button" className="ghost-action" onClick={() => { setQuery(""); setStatus("all"); }}>清除筛选</button>
              : <button type="button" className="primary-action action-btn" onClick={openCreate}><Plus />新建计划</button>}
          />}
    </Card>

    <Modal
      open={formOpen}
      onClose={() => setFormOpen(false)}
      title={editing ? `编辑计划 · ${editing.name}` : "新建定时任务"}
      description="任务目标会被原样交给任务服务执行，请像写一条运行中心指令一样描述它。"
      footer={<>
        <button type="button" className="ghost-action" onClick={() => setFormOpen(false)}>取消</button>
        <button type="button" className="primary-action action-btn" onClick={() => void submit()}>{editing ? "保存更改" : "创建计划"}</button>
      </>}
    >
      {formError && <p className="detail-note danger"><Warning />{formError}</p>}

      <FormGrid>
        <Field label="计划名称" required error={errors.name}>
          <TextInput
            value={draft.name}
            onChange={(value) => setDraft((current) => ({ ...current, name: value }))}
            placeholder="例如：每日行业简报"
            invalid={Boolean(errors.name)}
          />
        </Field>
        <Field label="运行 Agent" hint="auto 由 Planner 按目标组建团队">
          <SelectInput
            value={draft.agent}
            onChange={(value) => setDraft((current) => ({ ...current, agent: value }))}
            options={agentOptions}
          />
        </Field>
      </FormGrid>

      <Field label="任务目标" required error={errors.objective} hint="写给 Planner 的完整指令，包含范围、输出格式与约束。">
        <TextArea
          value={draft.objective}
          onChange={(value) => setDraft((current) => ({ ...current, objective: value }))}
          rows={4}
          placeholder="例如：汇总过去 24 小时行业动态，产出带来源的简报草稿并标注待核实项。"
        />
      </Field>

      <Field label="cron 表达式" required error={errors.cron} hint={CRON_HINT}>
        <div className="stack-field">
          <TextInput
            value={draft.cron}
            onChange={(value) => setDraft((current) => ({ ...current, cron: value }))}
            placeholder="0 9 * * *"
            invalid={Boolean(errors.cron)}
          />
          <div className="chip-list padded">
            {cronPresets.map((preset) => <button
              type="button"
              key={preset.value}
              className={`filter-chip ${draft.cron === preset.value ? "active" : ""}`}
              onClick={() => setDraft((current) => ({ ...current, cron: preset.value }))}
            >{preset.label}</button>)}
          </div>
        </div>
      </Field>

      <FormGrid>
        <Field label="执行模式" hint="仅生成计划不会真正执行工具与写入。">
          <SegmentedControl
            value={draft.execution_mode}
            onChange={(value) => setDraft((current) => ({ ...current, execution_mode: value }))}
            options={[{ id: "auto", label: "自动执行" }, { id: "plan_only", label: "仅生成计划" }]}
          />
        </Field>
        <Field label="运行模式">
          <SegmentedControl
            value={draft.run_mode}
            onChange={(value) => setDraft((current) => ({ ...current, run_mode: value }))}
            options={[{ id: "graph", label: "图编排" }, { id: "react", label: "ReAct 循环" }]}
          />
        </Field>
      </FormGrid>

      <SwitchRow
        title="启用计划"
        note="关闭后保留配置，但调度循环不再触发它"
        checked={draft.enabled}
        onChange={(value) => setDraft((current) => ({ ...current, enabled: value }))}
      />
      <SwitchRow
        title="使用知识库"
        note="执行时检索工作区知识库作为上下文"
        checked={draft.use_knowledge_base}
        onChange={(value) => setDraft((current) => ({ ...current, use_knowledge_base: value }))}
      />
    </Modal>

    <Modal
      open={Boolean(detail)}
      onClose={() => setDetail(null)}
      variant="side"
      title={detail?.name ?? ""}
      description={detail ? `${detail.cron} · ${agentLabel(detail.agent)}` : undefined}
      footer={detail && <>
        <button type="button" className="ghost-action" onClick={() => setDetail(null)}>关闭</button>
        <button
          type="button"
          className="primary-action action-btn"
          disabled={running === detail.schedule_id}
          onClick={() => void runNow(detail)}
        >{running === detail.schedule_id ? "执行中…" : "立即执行"}</button>
      </>}
    >
      {detail && <div className="detail-stack">
        <div className="detail-badges">
          <Pill tone={detail.enabled ? "ok" : "neutral"}>{detail.enabled ? "启用中" : "已暂停"}</Pill>
          <Pill tone="info">{executionModeLabels[detail.execution_mode] ?? detail.execution_mode}</Pill>
          <Pill tone="neutral">{runModeLabels[detail.run_mode] ?? detail.run_mode}</Pill>
          {detail.use_knowledge_base && <Pill tone="accent"><Books />知识库</Pill>}
        </div>

        <section className="detail-block">
          <h3>任务目标</h3>
          <p>{detail.objective}</p>
        </section>

        <section className="detail-block">
          <h3>调度信息</h3>
          <dl className="kv-list">
            <div><dt>cron 表达式</dt><dd className="mono">{detail.cron}</dd></div>
            <div><dt>运行 Agent</dt><dd>{agentLabel(detail.agent)}</dd></div>
            <div><dt>上次执行</dt><dd>{formatDateTime(detail.last_run_at)}</dd></div>
            <div><dt>下次触发</dt><dd>{detail.enabled ? formatDateTime(detail.next_run_at) : "已暂停，不触发"}</dd></div>
          </dl>
        </section>

        <section className="detail-block">
          <h3>最近一次任务</h3>
          {detail.last_task_id
            ? <p>
              <a className="cell-link" href={`/workbench/steps?task=${detail.last_task_id}`}>{detail.last_task_id}</a>
              <small className="muted-text"> 打开后可看到完整执行步骤与产物。</small>
            </p>
            : <p className="detail-note">这条计划还没有被调度器或手动执行过。</p>}
        </section>

        <section className="detail-block">
          <h3>记录信息</h3>
          <dl className="kv-list">
            <div><dt>计划 ID</dt><dd className="mono">{detail.schedule_id}</dd></div>
            <div><dt>创建时间</dt><dd>{formatDateTime(detail.created_at)}</dd></div>
            <div><dt>更新时间</dt><dd>{formatDateTime(detail.updated_at)}</dd></div>
          </dl>
        </section>

        <div className="detail-actions">
          <button type="button" className="ghost-action" onClick={() => void toggle(detail, !detail.enabled)}>
            {detail.enabled ? "暂停计划" : "启用计划"}
          </button>
          <button type="button" className="ghost-action" onClick={() => { openEdit(detail); setDetail(null); }}><PencilSimple />编辑</button>
          <button type="button" className="danger-action" onClick={() => setPendingDelete(detail)}><Trash />删除</button>
        </div>
      </div>}
    </Modal>

    <ConfirmDialog
      open={Boolean(pendingDelete)}
      title="删除定时任务"
      message={pendingDelete ? `「${pendingDelete.name}」的配置会被删除，调度循环不再触发它；已经跑出来的任务记录不受影响。` : ""}
      onConfirm={() => { if (pendingDelete) void remove(pendingDelete); }}
      onClose={() => setPendingDelete(null)}
    />
  </WorkspacePage>;
}
