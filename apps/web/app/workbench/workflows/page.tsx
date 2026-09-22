"use client";

import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Copy } from "@phosphor-icons/react/dist/csr/Copy";
import { FlowArrow } from "@phosphor-icons/react/dist/csr/FlowArrow";
import { GitBranch } from "@phosphor-icons/react/dist/csr/GitBranch";
import { PencilSimple } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { useMemo, useState } from "react";
import { WorkspacePage } from "../ui/shell";
import {
  Card, ConfirmDialog, Field, FilterChips, FormGrid, LoadingState, Modal, Pill,
  SampleBanner, SearchField, SelectInput, StatStrip, TextArea, TextInput, Toolbar, useNotice,
} from "../ui/primitives";
import { DataTable, IconButton, RowActions, type Column } from "../ui/table";
import { useCollection } from "../ui/store";
import { formatDateTime, nodeKindLabels, workflowSeeds, type Workflow, type WorkflowNodeKind } from "../ui/data";

type StatusFilter = "all" | "published" | "draft" | "archived";

const statusMeta: Record<Workflow["status"], { label: string; tone: "ok" | "warn" | "neutral" }> = {
  published: { label: "已发布", tone: "ok" },
  draft: { label: "草稿", tone: "warn" },
  archived: { label: "已归档", tone: "neutral" },
};

const triggerLabels: Record<Workflow["trigger"], string> = {
  manual: "手动触发",
  schedule: "定时触发",
  api: "API 触发",
};

const nodeTone: Record<WorkflowNodeKind, string> = {
  trigger: "node-trigger",
  agent: "node-agent",
  tool: "node-tool",
  gate: "node-gate",
  verify: "node-verify",
  output: "node-output",
};

const emptyDraft = {
  name: "",
  description: "",
  status: "draft" as Workflow["status"],
  trigger: "manual" as Workflow["trigger"],
  tags: "",
};

/* 工作流编排: 把 Supervisor 的隐式编排结果固化成可复用的显式流程。页面上展示的
   节点链与运行中心的五阶段主线一一对应，避免两处对流程的描述互相矛盾。 */
export default function WorkflowsPage() {
  const { items, ready, create, update, remove, insert } = useCollection<Workflow>("workflows", workflowSeeds);
  const { notice, push, clear } = useNotice();

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [trigger, setTrigger] = useState<"all" | Workflow["trigger"]>("all");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Workflow | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<Workflow | null>(null);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return items.filter((item) => {
      if (status !== "all" && item.status !== status) return false;
      if (trigger !== "all" && item.trigger !== trigger) return false;
      if (!keyword) return true;
      return item.name.toLowerCase().includes(keyword)
        || item.description.toLowerCase().includes(keyword)
        || item.tags.some((tag) => tag.toLowerCase().includes(keyword));
    });
  }, [items, query, status, trigger]);

  const detail = items.find((item) => item.id === detailId) ?? null;

  const metrics = [
    { label: "工作流总数", value: items.length, note: `${items.filter((item) => item.status === "published").length} 条已发布`, icon: GitBranch },
    { label: "累计运行", value: items.reduce((sum, item) => sum + item.runCount, 0), note: "来自运行中心的调用", icon: FlowArrow },
    { label: "平均成功率", value: `${items.length ? Math.round(items.reduce((sum, item) => sum + item.successRate, 0) / items.length) : 0}%`, note: "近 30 日滚动", icon: CheckCircle },
    { label: "包含人工门禁", value: items.filter((item) => item.nodes.some((node) => node.kind === "gate")).length, note: "高风险动作需要放行", icon: CheckCircle },
  ];

  function openCreate() {
    setEditing(null);
    setDraft({ ...emptyDraft });
    setErrors({});
    setFormOpen(true);
  }

  function openEdit(workflow: Workflow) {
    setEditing(workflow);
    setDraft({
      name: workflow.name,
      description: workflow.description,
      status: workflow.status,
      trigger: workflow.trigger,
      tags: workflow.tags.join("、"),
    });
    setErrors({});
    setFormOpen(true);
  }

  function submit() {
    const next: Record<string, string> = {};
    if (!draft.name.trim()) next.name = "请填写工作流名称";
    if (draft.description.trim().length < 8) next.description = "请补充至少 8 个字符的说明，便于团队理解适用范围";
    setErrors(next);
    if (Object.keys(next).length) return;

    const tags = draft.tags.split(/[、,，\s]+/).map((item) => item.trim()).filter(Boolean);
    if (editing) {
      update(editing.id, { ...draft, tags });
      push(`已更新「${draft.name}」`);
    } else {
      const created = create({
        ...draft,
        tags,
        version: "v0.1.0",
        updatedAt: new Date().toISOString(),
        owner: "陈立",
        runCount: 0,
        successRate: 0,
        nodes: [
          { id: "n1", kind: "trigger", title: triggerLabels[draft.trigger], note: "由所选方式发起" },
          { id: "n2", kind: "agent", title: "任务理解", agent: "intake_agent", note: "分类任务并评估风险等级" },
          { id: "n3", kind: "output", title: "交付物编排", agent: "document_agent", note: "输出结构化交付物" },
        ],
      });
      push(`已创建「${created.name}」，可在详情中继续补充节点`);
    }
    setFormOpen(false);
  }

  function duplicate(workflow: Workflow) {
    const copy: Workflow = {
      ...workflow,
      id: "",
      name: `${workflow.name} 副本`,
      status: "draft",
      version: "v0.1.0",
      runCount: 0,
      successRate: 0,
      updatedAt: new Date().toISOString(),
      nodes: workflow.nodes.map((node) => ({ ...node })),
    };
    insert({ ...copy, id: `wf-${Math.random().toString(36).slice(2, 10)}` });
    push(`已复制为「${copy.name}」`);
  }

  const columns: Array<Column<Workflow>> = [
    {
      key: "name",
      header: "工作流",
      sortValue: (row) => row.name,
      render: (row) => <span className="cell-title">
        <strong>{row.name}</strong>
        <small>{row.description}</small>
      </span>,
    },
    {
      key: "status",
      header: "状态",
      sortValue: (row) => row.status,
      render: (row) => <Pill tone={statusMeta[row.status].tone}>{statusMeta[row.status].label}</Pill>,
    },
    {
      key: "trigger",
      header: "触发方式",
      secondary: true,
      sortValue: (row) => row.trigger,
      render: (row) => <span className="cell-stack">
        <strong>{triggerLabels[row.trigger]}</strong>
        <small>{row.tags.join(" · ") || "无标签"}</small>
      </span>,
    },
    {
      key: "nodes",
      header: "节点",
      align: "right",
      secondary: true,
      sortValue: (row) => row.nodes.length,
      render: (row) => <span className="cell-stack right">
        <strong>{row.nodes.length}</strong>
        <small>{row.version}</small>
      </span>,
    },
    {
      key: "runCount",
      header: "运行 / 成功率",
      align: "right",
      sortValue: (row) => row.runCount,
      render: (row) => <span className="cell-stack right">
        <strong>{row.runCount}</strong>
        <small>{row.successRate}%</small>
      </span>,
    },
    {
      key: "updatedAt",
      header: "更新时间",
      secondary: true,
      sortValue: (row) => row.updatedAt,
      render: (row) => formatDateTime(row.updatedAt),
    },
    {
      key: "actions",
      header: "操作",
      align: "right",
      render: (row) => <RowActions>
        <IconButton icon={Copy} label="复制为草稿" onClick={() => duplicate(row)} />
        <IconButton icon={PencilSimple} label="编辑" onClick={() => openEdit(row)} />
        <IconButton icon={Trash} label="删除" tone="danger" onClick={() => setPendingDelete(row)} />
      </RowActions>,
    },
  ];

  return <WorkspacePage
    active="workflows"
    note="把可复用的编排固化下来：触发方式、参与的 Agent、调用的工具、人工门禁与最终交付物。发布后可在运行中心按此流程发起任务。"
    notice={notice}
    onDismissNotice={clear}
    actions={<>
      <button type="button" onClick={() => push("已重新载入工作流定义（示例数据）", "info")}><ArrowsClockwise />刷新</button>
      <button type="button" className="save action-btn" onClick={openCreate}><Plus />新建工作流</button>
    </>}
  >
    <SampleBanner note="工作流定义保存在浏览器本地存储中，尚未与后端编排引擎连通。" />

    <StatStrip items={metrics} />

    <Card
      icon={FlowArrow}
      title="工作流定义"
      note="点击任意行查看节点链与运行统计"
      count={filtered.length}
      toolbar={<Toolbar>
        <SearchField value={query} onChange={setQuery} placeholder="搜索名称、说明或标签" />
        <div className="toolbar-filters">
          <FilterChips<StatusFilter>
            value={status}
            onChange={setStatus}
            options={[
              { id: "all", label: "全部" },
              { id: "published", label: "已发布" },
              { id: "draft", label: "草稿" },
              { id: "archived", label: "已归档" },
            ]}
            counts={{
              all: items.length,
              published: items.filter((item) => item.status === "published").length,
              draft: items.filter((item) => item.status === "draft").length,
              archived: items.filter((item) => item.status === "archived").length,
            }}
          />
          <SelectInput
            value={trigger}
            onChange={setTrigger}
            options={[
              { value: "all", label: "全部触发方式" },
              { value: "manual", label: "手动触发" },
              { value: "schedule", label: "定时触发" },
              { value: "api", label: "API 触发" },
            ]}
          />
        </div>
      </Toolbar>}
    >
      {!ready
        ? <LoadingState label="正在读取工作流定义…" />
        : <DataTable<Workflow>
          columns={columns}
          rows={filtered}
          rowKey={(row) => row.id}
          activeKey={detailId}
          onRowClick={(row) => setDetailId(row.id)}
          emptyTitle={items.length ? "没有匹配的工作流" : "还没有工作流"}
          emptyNote={items.length ? "试着切换状态或清空搜索关键词。" : "新建一条工作流，把重复的编排固化下来。"}
          emptyAction={items.length
            ? <button type="button" className="ghost-action" onClick={() => { setQuery(""); setStatus("all"); setTrigger("all"); }}>清除筛选</button>
            : <button type="button" className="primary-action action-btn" onClick={openCreate}><Plus />新建工作流</button>}
        />}
    </Card>

    <Modal
      open={formOpen}
      onClose={() => setFormOpen(false)}
      title={editing ? `编辑工作流 · ${editing.name}` : "新建工作流"}
      description="新建后会生成一条默认节点链（触发 → 任务理解 → 交付物编排），可在详情中逐步调整。"
      footer={<>
        <button type="button" className="ghost-action" onClick={() => setFormOpen(false)}>取消</button>
        <button type="button" className="primary-action action-btn" onClick={submit}>{editing ? "保存更改" : "创建工作流"}</button>
      </>}
    >
      <Field label="工作流名称" required error={errors.name}>
        <TextInput value={draft.name} onChange={(value) => setDraft((current) => ({ ...current, name: value }))} placeholder="例如：研究简报流水线" invalid={Boolean(errors.name)} />
      </Field>
      <Field label="说明" required error={errors.description} hint="描述适用场景与产出，会显示在列表与运行中心。">
        <TextArea value={draft.description} onChange={(value) => setDraft((current) => ({ ...current, description: value }))} rows={3} />
      </Field>
      <FormGrid>
        <Field label="状态">
          <SelectInput
            value={draft.status}
            onChange={(value) => setDraft((current) => ({ ...current, status: value }))}
            options={[
              { value: "draft", label: "草稿" },
              { value: "published", label: "已发布" },
              { value: "archived", label: "已归档" },
            ]}
          />
        </Field>
        <Field label="触发方式">
          <SelectInput
            value={draft.trigger}
            onChange={(value) => setDraft((current) => ({ ...current, trigger: value }))}
            options={[
              { value: "manual", label: "手动触发" },
              { value: "schedule", label: "定时触发" },
              { value: "api", label: "API 触发" },
            ]}
          />
        </Field>
      </FormGrid>
      <Field label="标签" hint="用「、」或逗号分隔，便于筛选。">
        <TextInput value={draft.tags} onChange={(value) => setDraft((current) => ({ ...current, tags: value }))} placeholder="研究、文档" />
      </Field>
    </Modal>

    <Modal
      open={Boolean(detail)}
      onClose={() => setDetailId(null)}
      variant="side"
      title={detail?.name ?? ""}
      description={detail ? `${detail.version} · ${detail.owner} · 更新于 ${formatDateTime(detail.updatedAt)}` : undefined}
      footer={detail && <>
        <button type="button" className="ghost-action" onClick={() => setDetailId(null)}>关闭</button>
        <button type="button" className="primary-action action-btn" onClick={() => { openEdit(detail); setDetailId(null); }}><PencilSimple />编辑</button>
      </>}
    >
      {detail && <div className="detail-stack">
        <div className="detail-badges">
          <Pill tone={statusMeta[detail.status].tone}>{statusMeta[detail.status].label}</Pill>
          <Pill tone="info">{triggerLabels[detail.trigger]}</Pill>
          {detail.tags.map((tag) => <Pill key={tag} tone="neutral">{tag}</Pill>)}
        </div>

        <section className="detail-block">
          <h3>说明</h3>
          <p>{detail.description}</p>
        </section>

        <section className="detail-block">
          <h3>节点链</h3>
          <ol className="workflow-chain">
            {detail.nodes.map((node, index) => <li key={node.id} className={nodeTone[node.kind]}>
              <span className="chain-index">{String(index + 1).padStart(2, "0")}</span>
              <div>
                <strong>{node.title}</strong>
                <small>{nodeKindLabels[node.kind]}{node.agent ? ` · ${node.agent}` : ""}</small>
                <p>{node.note}</p>
              </div>
            </li>)}
          </ol>
        </section>

        <section className="detail-block">
          <h3>运行统计</h3>
          <dl className="kv-list">
            <div><dt>累计运行</dt><dd>{detail.runCount} 次</dd></div>
            <div><dt>成功率</dt><dd>{detail.successRate}%</dd></div>
            <div><dt>节点数量</dt><dd>{detail.nodes.length} 个</dd></div>
            <div><dt>人工门禁</dt><dd>{detail.nodes.filter((node) => node.kind === "gate").length} 处</dd></div>
          </dl>
        </section>

        <div className="detail-actions">
          <button type="button" className="ghost-action" onClick={() => {
            update(detail.id, { status: detail.status === "published" ? "draft" : "published", updatedAt: new Date().toISOString() });
            push(detail.status === "published" ? `已下架「${detail.name}」` : `已发布「${detail.name}」`);
          }}>{detail.status === "published" ? "下架为草稿" : "发布"}</button>
          <button type="button" className="ghost-action" onClick={() => duplicate(detail)}><Copy />复制</button>
          <button type="button" className="danger-action" onClick={() => { setPendingDelete(detail); setDetailId(null); }}><Trash />删除</button>
        </div>

        <p className="page-note">节点链与运行中心的「任务规划 / 执行计划 / Agent 协作」阶段保持同一套语义，发布后可在此直接发起一次试运行。</p>
      </div>}
    </Modal>

    <ConfirmDialog
      open={Boolean(pendingDelete)}
      title="删除工作流"
      message={pendingDelete ? `「${pendingDelete.name}」将被移除，已产生的运行记录不受影响。` : ""}
      onConfirm={() => {
        if (!pendingDelete) return;
        remove(pendingDelete.id);
        push(`已删除「${pendingDelete.name}」`);
      }}
      onClose={() => setPendingDelete(null)}
    />
  </WorkspacePage>;
}
