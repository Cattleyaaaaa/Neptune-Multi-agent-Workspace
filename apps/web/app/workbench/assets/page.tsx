"use client";

import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { CloudArrowUp } from "@phosphor-icons/react/dist/csr/CloudArrowUp";
import { DownloadSimple } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { FileZip } from "@phosphor-icons/react/dist/csr/FileZip";
import { HardDrives } from "@phosphor-icons/react/dist/csr/HardDrives";
import { ImageSquare } from "@phosphor-icons/react/dist/csr/ImageSquare";
import { Paperclip } from "@phosphor-icons/react/dist/csr/Paperclip";
import { Table } from "@phosphor-icons/react/dist/csr/Table";
import { Tag } from "@phosphor-icons/react/dist/csr/Tag";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import type { ChangeEvent } from "react";
import { useMemo, useState } from "react";
import { WorkspacePage } from "../ui/shell";
import {
  Card, ConfirmDialog, Field, FilterChips, FormGrid, LoadingState, Modal, Pill,
  ProgressMeter, SampleBanner, SearchField, SelectInput, StatStrip, TextInput, Toolbar, useNotice,
} from "../ui/primitives";
import { DataTable, IconButton, RowActions, type Column } from "../ui/table";
import { useCollection } from "../ui/store";
import { assetKindLabels, assetSeeds, formatBytes, formatDateTime, type Asset, type AssetKind } from "../ui/data";

type KindFilter = "all" | AssetKind;
type StatusFilter = "all" | Asset["status"];

const kindIcons = {
  document: FileText,
  image: ImageSquare,
  table: Table,
  archive: FileZip,
  code: FileText,
} as const;

const statusMeta: Record<Asset["status"], { label: string; tone: "ok" | "warn" | "danger" }> = {
  ready: { label: "可用", tone: "ok" },
  processing: { label: "解析中", tone: "warn" },
  failed: { label: "解析失败", tone: "danger" },
};

const STORAGE_QUOTA = 512 * 1024 * 1024;

function detectKind(name: string): AssetKind {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (["csv", "xlsx", "xls", "tsv"].includes(ext)) return "table";
  if (["zip", "tar", "gz", "7z", "rar"].includes(ext)) return "archive";
  if (["py", "ts", "tsx", "js", "jsx", "go", "rs", "java", "sql"].includes(ext)) return "code";
  return "document";
}

/* 附件资产: 工作台共享的文件池。任务上下文与 RAG 知识库都从这里取用材料，因此
   资产状态（可用 / 解析中 / 失败）会直接影响任务可用的证据范围。 */
export default function AssetsPage() {
  const { items, ready, create, update, remove } = useCollection<Asset>("assets", assetSeeds);
  const { notice, push, clear } = useNotice();

  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [scope, setScope] = useState<"all" | Asset["scope"]>("all");
  const [tag, setTag] = useState("all");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Asset | null>(null);
  const [renaming, setRenaming] = useState<Asset | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const tags = useMemo(() => ["all", ...Array.from(new Set(items.flatMap((item) => item.tags)))], [items]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return items.filter((item) => {
      if (kind !== "all" && item.kind !== kind) return false;
      if (status !== "all" && item.status !== status) return false;
      if (scope !== "all" && item.scope !== scope) return false;
      if (tag !== "all" && !item.tags.includes(tag)) return false;
      if (!keyword) return true;
      return item.name.toLowerCase().includes(keyword)
        || item.owner.toLowerCase().includes(keyword)
        || item.tags.some((item2) => item2.toLowerCase().includes(keyword));
    });
  }, [items, query, kind, status, scope, tag]);

  const detail = items.find((item) => item.id === detailId) ?? null;
  const used = items.reduce((sum, item) => sum + item.size, 0);

  const metrics = [
    { label: "资产数量", value: items.length, note: `${items.filter((item) => item.scope === "workspace").length} 个工作区级`, icon: Paperclip },
    { label: "占用空间", value: formatBytes(used), note: `配额 ${formatBytes(STORAGE_QUOTA)}`, icon: HardDrives },
    { label: "引用中", value: items.filter((item) => item.usedBy.length).length, note: "被任务或知识库引用", icon: Tag },
    { label: "待处理", value: items.filter((item) => item.status !== "ready").length, note: "解析中或失败", icon: CloudArrowUp },
  ];

  function onUpload(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    if (!selected.length) return;
    const accepted = selected.filter((file) => file.size <= 32 * 1024 * 1024);
    if (accepted.length !== selected.length) push("已跳过超过 32 MB 的文件", "error");
    accepted.forEach((file) => create({
      name: file.name,
      kind: detectKind(file.name),
      mime: file.type || "application/octet-stream",
      size: file.size,
      tags: ["上传"],
      owner: "陈立",
      uploadedAt: new Date().toISOString(),
      scope: "workspace",
      status: "ready",
      usedBy: [],
    }));
    if (accepted.length) push(`已上传 ${accepted.length} 个文件`);
    event.target.value = "";
  }

  const columns: Array<Column<Asset>> = [
    {
      key: "name",
      header: "文件",
      sortValue: (row) => row.name,
      render: (row) => {
        const Icon = kindIcons[row.kind];
        return <span className="cell-title with-icon">
          <i className="file-badge"><Icon weight="duotone" /></i>
          <span><strong>{row.name}</strong><small>{assetKindLabels[row.kind]} · {formatBytes(row.size)}</small></span>
        </span>;
      },
    },
    {
      key: "status",
      header: "状态",
      sortValue: (row) => row.status,
      render: (row) => <Pill tone={statusMeta[row.status].tone}>{statusMeta[row.status].label}</Pill>,
    },
    {
      key: "tags",
      header: "标签",
      secondary: true,
      render: (row) => <span className="chip-list">{row.tags.map((item) => <b key={item}>{item}</b>)}</span>,
    },
    {
      key: "usedBy",
      header: "被引用",
      secondary: true,
      sortValue: (row) => row.usedBy.length,
      render: (row) => row.usedBy.length
        ? <span className="cell-stack"><strong>{row.usedBy.length} 处</strong><small>{row.usedBy.join(" · ")}</small></span>
        : <span className="muted-text">未被引用</span>,
    },
    {
      key: "owner",
      header: "上传者",
      secondary: true,
      sortValue: (row) => row.owner,
      render: (row) => <span className="cell-stack"><strong>{row.owner}</strong><small>{formatDateTime(row.uploadedAt)}</small></span>,
    },
    {
      key: "actions",
      header: "操作",
      align: "right",
      render: (row) => <RowActions>
        <IconButton icon={DownloadSimple} label="下载" onClick={() => push(`已开始下载「${row.name}」（示例）`, "info")} />
        <IconButton icon={Trash} label="删除" tone="danger" onClick={() => setPendingDelete(row)} />
      </RowActions>,
    },
  ];

  return <WorkspacePage
    active="assets"
    note="工作台的共享材料池：上传的文档、表格与图片会被任务上下文和 RAG 知识库引用。这里可以查看引用关系、解析状态与占用空间。"
    notice={notice}
    onDismissNotice={clear}
    actions={<>
      <button type="button" onClick={() => push("资产列表已刷新（示例数据）", "info")}><ArrowsClockwise />刷新</button>
      <label className="save action-btn upload-action">
        <CloudArrowUp />上传文件
        <input type="file" multiple onChange={onUpload} />
      </label>
    </>}
  >
    <SampleBanner note="文件不会真正上传到服务器，元数据记录在浏览器本地存储中，用于演示资产管理交互。" />

    <StatStrip items={metrics} />

    <div className="split-grid">
      <Card icon={HardDrives} title="存储用量" note="演示配额为 512 MB，可在治理策略中调整">
        <div className="storage-block">
          <ProgressMeter value={used} max={STORAGE_QUOTA} tone={used / STORAGE_QUOTA > 0.8 ? "danger" : "ok"} />
          <dl className="kv-list">
            <div><dt>已使用</dt><dd>{formatBytes(used)}</dd></div>
            <div><dt>剩余</dt><dd>{formatBytes(Math.max(STORAGE_QUOTA - used, 0))}</dd></div>
            <div><dt>最大单文件</dt><dd>{formatBytes(32 * 1024 * 1024)}</dd></div>
          </dl>
        </div>
      </Card>

      <Card icon={Tag} title="按类型分布" note="点击分类可快速筛选下方列表">
        <ul className="kind-breakdown">
          {(Object.keys(assetKindLabels) as AssetKind[]).map((item) => {
            const Icon = kindIcons[item];
            const count = items.filter((asset) => asset.kind === item).length;
            return <li key={item}>
              <button type="button" className={kind === item ? "active" : ""} onClick={() => setKind(kind === item ? "all" : item)}>
                <Icon weight="duotone" />
                <span>{assetKindLabels[item]}</span>
                <b>{count}</b>
              </button>
            </li>;
          })}
        </ul>
      </Card>
    </div>

    <Card
      icon={Paperclip}
      title="资产列表"
      note="点击任意行查看引用关系与解析详情"
      count={filtered.length}
      toolbar={<Toolbar>
        <SearchField value={query} onChange={setQuery} placeholder="搜索文件名、上传者或标签" />
        <div className="toolbar-filters">
          <FilterChips<StatusFilter>
            value={status}
            onChange={setStatus}
            options={[
              { id: "all", label: "全部状态" },
              { id: "ready", label: "可用" },
              { id: "processing", label: "解析中" },
              { id: "failed", label: "失败" },
            ]}
          />
          <SelectInput
            value={scope}
            onChange={setScope}
            options={[
              { value: "all", label: "全部范围" },
              { value: "workspace", label: "工作区级" },
              { value: "task", label: "任务级" },
            ]}
          />
          <SelectInput
            value={tag}
            onChange={setTag}
            options={tags.map((item) => ({ value: item, label: item === "all" ? "全部标签" : item }))}
          />
        </div>
      </Toolbar>}
    >
      {!ready
        ? <LoadingState label="正在读取资产列表…" />
        : <DataTable<Asset>
          columns={columns}
          rows={filtered}
          rowKey={(row) => row.id}
          activeKey={detailId}
          onRowClick={(row) => setDetailId(row.id)}
          emptyTitle={items.length ? "没有匹配的资产" : "还没有上传任何文件"}
          emptyNote={items.length ? "试着更换标签、类型或状态筛选。" : "上传文档或数据表，供任务上下文与知识库引用。"}
          emptyAction={items.length
            ? <button type="button" className="ghost-action" onClick={() => { setQuery(""); setKind("all"); setStatus("all"); setScope("all"); setTag("all"); }}>清除筛选</button>
            : <label className="primary-action action-btn upload-action"><CloudArrowUp />上传文件<input type="file" multiple onChange={onUpload} /></label>}
        />}
    </Card>

    <Modal
      open={Boolean(detail)}
      onClose={() => setDetailId(null)}
      variant="side"
      title={detail?.name ?? ""}
      description={detail ? `${assetKindLabels[detail.kind]} · ${formatBytes(detail.size)}` : undefined}
      footer={detail && <>
        <button type="button" className="ghost-action" onClick={() => setDetailId(null)}>关闭</button>
        <button type="button" className="primary-action action-btn" onClick={() => push(`已开始下载「${detail.name}」（示例）`, "info")}><DownloadSimple />下载</button>
      </>}
    >
      {detail && <div className="detail-stack">
        <div className="detail-badges">
          <Pill tone={statusMeta[detail.status].tone}>{statusMeta[detail.status].label}</Pill>
          <Pill tone="neutral">{detail.scope === "workspace" ? "工作区级" : "任务级"}</Pill>
          {detail.tags.map((item) => <Pill key={item} tone="info">{item}</Pill>)}
        </div>

        <section className="detail-block">
          <h3>文件信息</h3>
          <dl className="kv-list">
            <div><dt>文件名</dt><dd>{detail.name}</dd></div>
            <div><dt>类型</dt><dd className="mono">{detail.mime}</dd></div>
            <div><dt>大小</dt><dd>{formatBytes(detail.size)}</dd></div>
            <div><dt>上传者</dt><dd>{detail.owner}</dd></div>
            <div><dt>上传时间</dt><dd>{formatDateTime(detail.uploadedAt)}</dd></div>
          </dl>
        </section>

        <section className="detail-block">
          <h3>引用关系</h3>
          {detail.usedBy.length
            ? <ul className="usage-list">{detail.usedBy.map((item) => <li key={item}><Paperclip />{item}</li>)}</ul>
            : <p className="detail-note">该资产尚未被任何任务或知识库引用。</p>}
        </section>

        <section className="detail-block">
          <h3>解析状态</h3>
          {detail.status === "ready" && <p className="detail-note">已完成解析，可被任务上下文与 RAG 检索直接取用。</p>}
          {detail.status === "processing" && <p className="detail-note">正在解析内容并切片，稍后会自动变为可用。</p>}
          {detail.status === "failed" && <p className="detail-note error-text">解析失败：文件可能已损坏或格式不受支持，建议重新上传。</p>}
        </section>

        <div className="detail-actions">
          <button type="button" className="ghost-action" onClick={() => { setRenaming(detail); setRenameValue(detail.name); }}>重命名</button>
          <button type="button" className="ghost-action" onClick={() => {
            const value = detail.scope === "workspace" ? "task" : "workspace";
            update(detail.id, { scope: value });
            push(`已切换为${value === "workspace" ? "工作区级" : "任务级"}资产`);
          }}>切换范围</button>
          <button type="button" className="danger-action" onClick={() => { setPendingDelete(detail); setDetailId(null); }}><Trash />删除</button>
        </div>
      </div>}
    </Modal>

    <Modal
      open={Boolean(renaming)}
      onClose={() => setRenaming(null)}
      title="重命名资产"
      description="重命名不会影响已有的引用关系。"
      footer={<>
        <button type="button" className="ghost-action" onClick={() => setRenaming(null)}>取消</button>
        <button type="button" className="primary-action action-btn" onClick={() => {
          if (!renaming) return;
          if (!renameValue.trim()) { push("文件名不能为空", "error"); return; }
          update(renaming.id, { name: renameValue.trim() });
          push("已重命名资产");
          setRenaming(null);
        }}>保存</button>
      </>}
    >
      <FormGrid columns={1}>
        <Field label="文件名">
          <TextInput value={renameValue} onChange={setRenameValue} />
        </Field>
      </FormGrid>
    </Modal>

    <ConfirmDialog
      open={Boolean(pendingDelete)}
      title="删除资产"
      message={pendingDelete
        ? `「${pendingDelete.name}」将被删除${pendingDelete.usedBy.length ? `，它当前被 ${pendingDelete.usedBy.length} 处引用` : ""}。`
        : ""}
      onConfirm={() => {
        if (!pendingDelete) return;
        remove(pendingDelete.id);
        push(`已删除「${pendingDelete.name}」`);
      }}
      onClose={() => setPendingDelete(null)}
    />
  </WorkspacePage>;
}
