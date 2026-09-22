"use client";

import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { FileArrowUp } from "@phosphor-icons/react/dist/csr/FileArrowUp";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { PuzzlePiece } from "@phosphor-icons/react/dist/csr/PuzzlePiece";
import { Tag } from "@phosphor-icons/react/dist/csr/Tag";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, apiUrl, toErrorMessage } from "../../auth/api";
import { WorkspacePage } from "../ui/shell";
import {
  Card, ConfirmDialog, EmptyState, Field, FilterChips, LoadingState, Modal, Pill,
  SearchField, SelectInput, StatStrip, Switch, TextInput, Toolbar, useNotice,
} from "../ui/primitives";
import { DataTable, IconButton, RowActions, type Column } from "../ui/table";
import { formatDateTime } from "../ui/data";

type Skill = {
  skill_id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  author: string;
  source: string;
  triggers: string[];
  tools: string[];
  filename: string;
  size_kb: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  content: string;
};

const CATEGORIES = ["数据", "文档", "软件工程", "研究", "治理", "集成", "本地导入"];

/* Skill 中心：把上传的技能包解析入库，启用的技能正文会拼进任务上下文
   （见 apps/api/workspace.py 的 managed_context）——所以"启用"会真的改变运行结果，
   而不是只改一个勾选框。原始文件存在 data/skills/ 下。 */
export default function SkillsPage() {
  const { notice, push, clear } = useNotice();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [source, setSource] = useState<"all" | "local">("all");
  const [detail, setDetail] = useState<Skill | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Skill | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [overrideName, setOverrideName] = useState("");
  const [overrideCategory, setOverrideCategory] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await apiFetch(apiUrl("/api/skills"));
      if (!response.ok) throw new Error();
      setSkills((await response.json()) as Skill[]);
      setLoadError("");
    } catch {
      setLoadError("无法读取技能目录，请确认后端已启动。");
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return skills.filter((item) => {
      if (category !== "全部" && item.category !== category) return false;
      if (source !== "all" && item.source !== source) return false;
      if (!keyword) return true;
      return item.name.toLowerCase().includes(keyword)
        || item.description.toLowerCase().includes(keyword)
        || item.triggers.some((trigger) => trigger.toLowerCase().includes(keyword));
    });
  }, [skills, query, category, source]);

  const metrics = [
    { label: "已导入技能", value: skills.length, note: `${skills.filter((item) => item.enabled).length} 个已启用`, icon: PuzzlePiece },
    { label: "启用中", value: skills.filter((item) => item.enabled).length, note: "正文会拼进任务上下文", icon: CheckCircle },
    { label: "带触发词", value: skills.filter((item) => item.triggers.length).length, note: "触发词目前只用于展示与检索", icon: Tag },
    { label: "占用空间", value: `${skills.reduce((sum, item) => sum + item.size_kb, 0)} KB`, note: "原始文件存于 data/skills/", icon: FileText },
  ];

  async function openDetail(skill: Skill) {
    setDetail(skill);
    try {
      // 列表接口只回正文前 400 字，详情要取全文
      const response = await apiFetch(apiUrl(`/api/skills/${skill.skill_id}`));
      if (response.ok) setDetail((await response.json()) as Skill);
    } catch { /* 保留列表里的摘要 */ }
  }

  async function patch(skill: Skill, changes: Partial<Skill>) {
    try {
      const response = await apiFetch(apiUrl(`/api/skills/${skill.skill_id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      if (!response.ok) throw new Error();
      const updated = (await response.json()) as Skill;
      setSkills((state) => state.map((item) => item.skill_id === updated.skill_id ? updated : item));
      setDetail((state) => state?.skill_id === updated.skill_id ? updated : state);
      return true;
    } catch {
      push("更新失败，请稍后重试", "error");
      return false;
    }
  }

  async function upload() {
    if (!file) {
      setUploadError("请选择要导入的技能文件");
      return;
    }
    setUploading(true);
    setUploadError("");
    const form = new FormData();
    form.append("file", file);
    if (overrideName.trim()) form.append("name", overrideName.trim());
    if (overrideCategory) form.append("category", overrideCategory);
    try {
      const response = await apiFetch(apiUrl("/api/skills"), { method: "POST", body: form });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setUploadError(toErrorMessage(payload, "导入失败，请检查文件格式"));
        return;
      }
      const created = (await response.json()) as Skill;
      setSkills((state) => [created, ...state]);
      push(`已导入「${created.name}」，确认无误后启用`);
      closeUpload();
    } catch {
      setUploadError("无法连接后端服务，请确认 API 已启动");
    } finally {
      setUploading(false);
    }
  }

  function closeUpload() {
    setUploadOpen(false);
    setFile(null);
    setOverrideName("");
    setOverrideCategory("");
    setUploadError("");
  }

  async function remove(skill: Skill) {
    try {
      const response = await apiFetch(apiUrl(`/api/skills/${skill.skill_id}`), { method: "DELETE" });
      if (!response.ok) throw new Error();
      setSkills((state) => state.filter((item) => item.skill_id !== skill.skill_id));
      setDetail(null);
      push(`已卸载「${skill.name}」`);
    } catch {
      push("卸载失败，请稍后重试", "error");
    }
  }

  const columns: Array<Column<Skill>> = [
    {
      key: "name",
      header: "技能",
      sortValue: (row) => row.name,
      render: (row) => <span className="cell-title">
        <strong>{row.name}</strong>
        <small>{row.description}</small>
      </span>,
    },
    {
      key: "category",
      header: "分类",
      sortValue: (row) => row.category,
      render: (row) => <Pill tone="neutral">{row.category}</Pill>,
    },
    {
      key: "version",
      header: "版本",
      secondary: true,
      sortValue: (row) => row.version,
      render: (row) => <span className="mono">{row.version}</span>,
    },
    {
      key: "file",
      header: "来源文件",
      secondary: true,
      render: (row) => <span className="cell-stack">
        <strong className="mono">{row.filename || "—"}</strong>
        <small>{row.size_kb} KB</small>
      </span>,
    },
    {
      key: "triggers",
      header: "触发词",
      render: (row) => row.triggers.length
        ? <span className="chip-list">{row.triggers.slice(0, 4).map((trigger) => <b key={trigger}>{trigger}</b>)}</span>
        : <span className="muted-text">—</span>,
    },
    {
      key: "enabled",
      header: "启用",
      align: "right",
      render: (row) => <RowActions>
        <Switch
          checked={row.enabled}
          onChange={(value) => {
            void patch(row, { enabled: value }).then((ok) => {
              if (ok) push(value ? `已启用「${row.name}」` : `已停用「${row.name}」`);
            });
          }}
          label={`启用 ${row.name}`}
        />
      </RowActions>,
    },
    {
      key: "actions",
      header: "操作",
      align: "right",
      render: (row) => <RowActions>
        <IconButton icon={Trash} label="卸载" tone="danger" onClick={() => setPendingDelete(row)} />
      </RowActions>,
    },
  ];

  return <WorkspacePage
    active="skills"
    note="上传 .md / .json / .zip 技能包：Markdown 的 frontmatter 会被解析成元数据，zip 里找 SKILL.md。启用的技能正文会拼进任务上下文，所以「启用」会真的影响运行结果。"
    notice={notice}
    onDismissNotice={clear}
    actions={<>
      <button type="button" onClick={() => void load()} disabled={refreshing}>
        <ArrowsClockwise className={refreshing ? "spin" : undefined} />{refreshing ? "同步中…" : "刷新目录"}
      </button>
      <button type="button" className="save action-btn" onClick={() => setUploadOpen(true)}>
        <FileArrowUp />上传技能
      </button>
    </>}
  >
    <StatStrip items={metrics} />

    {loadError && <p className="detail-note"><Warning />{loadError}</p>}

    <Card
      icon={PuzzlePiece}
      title="技能目录"
      note="点击任意行查看解析出的正文、触发词与来源文件"
      count={filtered.length}
      toolbar={<Toolbar>
        <SearchField value={query} onChange={setQuery} placeholder="搜索技能名称、说明或触发词" />
        <div className="toolbar-filters">
          <FilterChips<string>
            value={category}
            onChange={setCategory}
            options={["全部", ...CATEGORIES].map((item) => ({ id: item, label: item }))}
          />
          <SelectInput
            value={source}
            onChange={setSource}
            options={[{ value: "all", label: "全部来源" }, { value: "local", label: "本地导入" }]}
          />
        </div>
      </Toolbar>}
    >
      {!loaded
        ? <LoadingState label="正在读取技能目录…" />
        : <DataTable<Skill>
          columns={columns}
          rows={filtered}
          rowKey={(row) => row.skill_id}
          activeKey={detail?.skill_id ?? null}
          onRowClick={(row) => void openDetail(row)}
          emptyTitle={skills.length ? "没有匹配的技能" : "还没有导入技能"}
          emptyNote={skills.length
            ? "试着更换分类或清空搜索关键词。"
            : "上传一个 SKILL.md：带 frontmatter 会解析出名称、说明与触发词。"}
          emptyAction={skills.length
            ? <button type="button" className="ghost-action" onClick={() => { setQuery(""); setCategory("全部"); setSource("all"); }}>清除筛选</button>
            : <button type="button" className="primary-action action-btn" onClick={() => setUploadOpen(true)}><FileArrowUp />上传技能</button>}
        />}
    </Card>

    <Modal
      open={uploadOpen}
      onClose={closeUpload}
      title="上传技能"
      description="支持 .md（可带 --- frontmatter）、.json、.txt 与包含 SKILL.md / skill.json 的 .zip，单文件不超过 2 MB。导入后默认停用。"
      footer={<>
        <button type="button" className="ghost-action" onClick={closeUpload}>取消</button>
        <button type="button" className="primary-action action-btn" disabled={uploading} onClick={() => void upload()}>
          {uploading ? "正在解析…" : "导入"}
        </button>
      </>}
    >
      <Field label="技能文件" required hint="SKILL.md 里写了 name / description / triggers 就自动解析，不用手填">
        <input
          className="ui-input"
          type="file"
          accept=".md,.markdown,.txt,.json,.zip"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </Field>

      {file && <p className="detail-note">
        <FileText />已选择 {file.name} · {Math.max(1, Math.round(file.size / 1024))} KB
      </p>}

      <Field label="覆盖名称" hint="留空则用文件里解析出的名称">
        <TextInput value={overrideName} onChange={setOverrideName} placeholder="例如：指标口径核对" />
      </Field>
      <Field label="覆盖分类">
        <SelectInput
          value={overrideCategory}
          onChange={setOverrideCategory}
          options={[{ value: "", label: "沿用文件里的分类" }, ...CATEGORIES.map((item) => ({ value: item, label: item }))]}
        />
      </Field>

      {uploadError && <p className="detail-note danger"><Warning />{uploadError}</p>}
    </Modal>

    <Modal
      open={Boolean(detail)}
      onClose={() => setDetail(null)}
      variant="side"
      title={detail?.name ?? ""}
      description={detail ? `${detail.version} · ${detail.author} · ${detail.category}` : undefined}
      footer={detail && <>
        <button type="button" className="ghost-action" onClick={() => setDetail(null)}>关闭</button>
        <button type="button" className="primary-action action-btn" onClick={() => {
          void patch(detail, { enabled: !detail.enabled }).then((ok) => {
            if (ok) push(detail.enabled ? `已停用「${detail.name}」` : `已启用「${detail.name}」`);
          });
        }}>{detail.enabled ? "停用技能" : "启用技能"}</button>
      </>}
    >
      {detail && <div className="detail-stack">
        <div className="detail-badges">
          <Pill tone={detail.enabled ? "ok" : "neutral"}>{detail.enabled ? "已启用" : "已停用"}</Pill>
          <Pill tone="warn">本地导入</Pill>
          <Pill tone="neutral">{detail.category}</Pill>
        </div>

        <section className="detail-block">
          <h3>技能说明</h3>
          <p>{detail.description || "文件里没有提供说明。"}</p>
        </section>

        <section className="detail-block">
          <h3>触发词</h3>
          <div className="chip-list padded">
            {detail.triggers.length
              ? detail.triggers.map((trigger) => <b key={trigger}><Tag />{trigger}</b>)
              : <span className="muted-text">未配置触发词</span>}
          </div>
        </section>

        <section className="detail-block">
          <h3>解析出的正文</h3>
          <pre className="skill-content">{detail.content || "（空）"}</pre>
          <p className="detail-note">
            启用的技能会把正文（最多 2000 字）拼进任务上下文；正文为空则不会注入。
          </p>
        </section>

        <section className="detail-block">
          <h3>元数据</h3>
          <dl className="kv-list">
            <div><dt>标识</dt><dd className="mono">{detail.skill_id}</dd></div>
            <div><dt>版本</dt><dd className="mono">{detail.version}</dd></div>
            <div><dt>来源文件</dt><dd className="mono">{detail.filename || "—"}</dd></div>
            <div><dt>包大小</dt><dd>{detail.size_kb} KB</dd></div>
            <div><dt>导入时间</dt><dd>{formatDateTime(detail.created_at)}</dd></div>
            <div><dt>更新时间</dt><dd>{formatDateTime(detail.updated_at)}</dd></div>
          </dl>
        </section>

        <div className="detail-actions">
          <button type="button" className="danger-action" onClick={() => { setPendingDelete(detail); }}><Trash />卸载技能</button>
        </div>
      </div>}
    </Modal>

    <ConfirmDialog
      open={Boolean(pendingDelete)}
      title="卸载技能"
      message={pendingDelete
        ? `「${pendingDelete.name}」与它的原始文件会一起删除，进行中的任务不受影响。`
        : ""}
      confirmLabel="确认卸载"
      onConfirm={() => { if (pendingDelete) void remove(pendingDelete); }}
      onClose={() => setPendingDelete(null)}
    />

    {!skills.length && loaded && !loadError && <EmptyState
      title="技能目录是空的"
      note="上传第一个技能包试试：一个带 frontmatter 的 SKILL.md 就够了。"
    />}
  </WorkspacePage>;
}
