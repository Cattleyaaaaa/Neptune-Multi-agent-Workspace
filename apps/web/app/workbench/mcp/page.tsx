"use client";

import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Key } from "@phosphor-icons/react/dist/csr/Key";
import { PlugsConnected } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import { Plugs } from "@phosphor-icons/react/dist/csr/Plugs";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { Toolbox } from "@phosphor-icons/react/dist/csr/Toolbox";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, apiUrl, toErrorMessage } from "../../auth/api";
import { WorkspacePage } from "../ui/shell";
import {
  Card, ConfirmDialog, Field, FilterChips, FormGrid, LoadingState, Modal, Pill,
  SearchField, SelectInput, StatStrip, Switch, TextArea, TextInput, Toolbar, useNotice,
} from "../ui/primitives";
import { DataTable, IconButton, RowActions, type Column } from "../ui/table";
import { formatDateTime } from "../ui/data";
import { agentLabels } from "../runtime/shared";

type Transport = "http" | "stdio" | "sse";
type ProbeStatus = "never" | "ok" | "failed" | "unsupported";
type McpServer = {
  server_id: string;
  name: string;
  transport: Transport;
  endpoint: string;
  allowed_agents: string[];
  note: string;
  enabled: boolean;
  server_name: string;
  server_version: string;
  tools: Array<{ name: string; description: string; access: string }>;
  latency_ms: number;
  last_probe_status: ProbeStatus;
  last_probe_detail: string;
  last_probe_at: string;
  has_auth: boolean;
  created_at: string;
  updated_at: string;
};

type StatusFilter = "all" | ProbeStatus;

const probeMeta: Record<ProbeStatus, { label: string; tone: "ok" | "danger" | "neutral" | "warn" }> = {
  ok: { label: "握手成功", tone: "ok" },
  failed: { label: "连接失败", tone: "danger" },
  unsupported: { label: "未探测", tone: "warn" },
  never: { label: "待探测", tone: "neutral" },
};

const transportLabels: Record<Transport, string> = {
  http: "HTTP 流式（可探测）",
  stdio: "stdio 本地进程（不探测）",
  sse: "SSE 长连接（不探测）",
};

const AGENT_IDS = ["research_agent", "data_agent", "code_agent", "document_agent", "review_agent"];

const emptyDraft = {
  name: "",
  transport: "http" as Transport,
  endpoint: "",
  auth_token: "",
  note: "",
  enabled: true,
};

/* MCP 中心：保存 MCP 服务器配置，并对 HTTP 端点做**真实的 MCP 握手**
   （initialize + tools/list），工具清单来自服务端自报，不是本地编的。

   边界说清楚：stdio / sse 传输不做探测——前者需要在服务器上拉起子进程，
   本机安全边界不允许由 HTTP 接口触发。另外，探测成功的工具目前**还没有**接入
   运行时工具注册表，这一步是后续工作，界面上不宣称已完成。 */
export default function McpPage() {
  const { notice, push, clear } = useNotice();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [detail, setDetail] = useState<McpServer | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [draftAgents, setDraftAgents] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<McpServer | null>(null);
  const [probing, setProbing] = useState<string>("");

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await apiFetch(apiUrl("/api/mcp"));
      if (!response.ok) throw new Error();
      setServers((await response.json()) as McpServer[]);
      setLoadError("");
    } catch {
      setLoadError("无法读取 MCP 配置，请确认后端已启动。");
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return servers.filter((item) => {
      if (status !== "all" && item.last_probe_status !== status) return false;
      if (!keyword) return true;
      return item.name.toLowerCase().includes(keyword)
        || item.endpoint.toLowerCase().includes(keyword)
        || item.tools.some((tool) => tool.name.toLowerCase().includes(keyword));
    });
  }, [servers, query, status]);

  const toolCount = servers.reduce((sum, item) => sum + item.tools.length, 0);
  const metrics = [
    { label: "已注册服务", value: servers.length, note: `${servers.filter((item) => item.enabled).length} 个已启用`, icon: PlugsConnected },
    { label: "握手成功", value: servers.filter((item) => item.last_probe_status === "ok").length, note: "经真实 initialize 验证", icon: CheckCircle },
    { label: "服务端自报工具", value: toolCount, note: "来自 tools/list", icon: Toolbox },
    { label: "待验证 / 失败", value: servers.filter((item) => item.last_probe_status !== "ok").length, note: "未探测或连接失败", icon: WarningCircle },
  ];

  function openCreate() {
    setDraft({ ...emptyDraft });
    setDraftAgents([]);
    setErrors({});
    setFormOpen(true);
  }

  function toggleAgent(id: string) {
    setDraftAgents((state) => state.includes(id) ? state.filter((item) => item !== id) : [...state, id]);
  }

  function applyUpdate(updated: McpServer) {
    setServers((state) => state.map((item) => item.server_id === updated.server_id ? updated : item));
    setDetail((state) => state?.server_id === updated.server_id ? updated : state);
  }

  async function submit() {
    const next: Record<string, string> = {};
    if (!draft.name.trim()) next.name = "请填写服务名称";
    if (!draft.endpoint.trim()) next.endpoint = "请填写服务地址或启动命令";
    else if (draft.transport === "http" && !/^https?:\/\//.test(draft.endpoint.trim())) {
      next.endpoint = "HTTP 传输需要以 http(s):// 开头";
    } else if (draft.transport !== "http" && !draft.endpoint.trim()) {
      next.endpoint = "stdio 填启动命令，SSE 填服务地址";
    }
    setErrors(next);
    if (Object.keys(next).length) return;

    try {
      const response = await apiFetch(apiUrl("/api/mcp"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, name: draft.name.trim(), endpoint: draft.endpoint.trim(), allowed_agents: draftAgents }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setErrors({ endpoint: toErrorMessage(payload, "保存失败，请检查配置") });
        return;
      }
      const created = (await response.json()) as McpServer;
      setServers((state) => [...state, created]);
      push(`已保存「${created.name}」，点「测试连接」做一次真实握手`);
      setFormOpen(false);
    } catch {
      setErrors({ endpoint: "无法连接后端服务，请确认 API 已启动" });
    }
  }

  async function probe(server: McpServer) {
    setProbing(server.server_id);
    try {
      const response = await apiFetch(apiUrl(`/api/mcp/${server.server_id}/probe`), { method: "POST" });
      if (!response.ok) throw new Error();
      const updated = (await response.json()) as McpServer;
      applyUpdate(updated);
      const tone = updated.last_probe_status === "ok" ? "success" : updated.last_probe_status === "failed" ? "error" : "info";
      push(`${updated.name}：${updated.last_probe_detail}`, tone);
    } catch {
      push("探测请求失败，请稍后重试", "error");
    } finally {
      setProbing("");
    }
  }

  async function patch(server: McpServer, changes: Record<string, unknown>) {
    try {
      const response = await apiFetch(apiUrl(`/api/mcp/${server.server_id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      if (!response.ok) throw new Error();
      applyUpdate((await response.json()) as McpServer);
      return true;
    } catch {
      push("更新失败，请稍后重试", "error");
      return false;
    }
  }

  async function remove(server: McpServer) {
    try {
      const response = await apiFetch(apiUrl(`/api/mcp/${server.server_id}`), { method: "DELETE" });
      if (!response.ok) throw new Error();
      setServers((state) => state.filter((item) => item.server_id !== server.server_id));
      setDetail(null);
      push(`已删除「${server.name}」`);
    } catch {
      push("删除失败，请稍后重试", "error");
    }
  }

  const columns: Array<Column<McpServer>> = [
    {
      key: "name",
      header: "服务",
      sortValue: (row) => row.name,
      render: (row) => <span className="cell-title">
        <strong>{row.name}{row.has_auth && <Pill tone="info">已配鉴权</Pill>}</strong>
        <small className="mono">{row.endpoint}</small>
      </span>,
    },
    {
      key: "transport",
      header: "传输",
      sortValue: (row) => row.transport,
      render: (row) => <Pill tone="neutral">{row.transport}</Pill>,
    },
    {
      key: "probe",
      header: "连接状态",
      sortValue: (row) => row.last_probe_status,
      render: (row) => <span className="cell-stack">
        <Pill tone={probeMeta[row.last_probe_status].tone}>{probeMeta[row.last_probe_status].label}</Pill>
        <small>{row.last_probe_status === "ok" && row.latency_ms ? `${row.latency_ms} ms` : row.last_probe_at ? formatDateTime(row.last_probe_at) : "尚未探测"}</small>
      </span>,
    },
    {
      key: "tools",
      header: "工具",
      secondary: true,
      sortValue: (row) => row.tools.length,
      render: (row) => row.tools.length
        ? <span className="mono">{row.tools.length} 个</span>
        : <span className="muted-text">—</span>,
    },
    {
      key: "agents",
      header: "允许的 Agent",
      secondary: true,
      render: (row) => row.allowed_agents.length
        ? <span className="chip-list">{row.allowed_agents.slice(0, 3).map((id) => <b key={id}>{agentLabels[id] ?? id}</b>)}</span>
        : <span className="muted-text">未限制</span>,
    },
    {
      key: "enabled",
      header: "启用",
      align: "right",
      render: (row) => <RowActions>
        <Switch
          checked={row.enabled}
          onChange={(value) => { void patch(row, { enabled: value }); }}
          label={`启用 ${row.name}`}
        />
      </RowActions>,
    },
    {
      key: "actions",
      header: "操作",
      align: "right",
      render: (row) => <RowActions>
        <IconButton
          icon={Plugs}
          label="测试连接"
          onClick={() => void probe(row)}
        />
        <IconButton icon={Trash} label="删除" tone="danger" onClick={() => setPendingDelete(row)} />
      </RowActions>,
    },
  ];

  return <WorkspacePage
    active="mcp"
    note="维护外部 MCP 工具来源。「测试连接」会按 MCP 流式 HTTP 做一次真实握手（initialize + tools/list），工具清单来自服务端自报；stdio / sse 传输只保存配置，不做探测。"
    notice={notice}
    onDismissNotice={clear}
    actions={<>
      <button type="button" onClick={() => void load()} disabled={refreshing}>
        <ArrowsClockwise className={refreshing ? "spin" : undefined} />{refreshing ? "同步中…" : "刷新"}
      </button>
      <button type="button" className="save action-btn" onClick={openCreate}><Plus />新增服务</button>
    </>}
  >
    <p className="detail-note">
      <Warning />
      启用且探测成功的 http 服务，其工具会接入运行时工具注册表，Agent 会真正调用它们：
      只读工具按这里配置的「授权 Agent」可用，写入类工具只交给执行 Agent 且仍需审批门禁。
      未探测（没有工具清单）的服务不会接入 —— 不知道入参 schema 就无法构造调用。
    </p>

    <StatStrip items={metrics} />

    {loadError && <p className="detail-note danger"><Warning />{loadError}</p>}

    <Card
      icon={PlugsConnected}
      title="MCP 服务"
      note="点击任意行查看握手详情与服务端自报的工具清单"
      count={filtered.length}
      toolbar={<Toolbar>
        <SearchField value={query} onChange={setQuery} placeholder="搜索服务名称、地址或工具名" />
        <div className="toolbar-filters">
          <FilterChips<StatusFilter>
            value={status}
            onChange={setStatus}
            options={[
              { id: "all", label: "全部" },
              { id: "ok", label: "握手成功" },
              { id: "failed", label: "连接失败" },
              { id: "unsupported", label: "未探测" },
              { id: "never", label: "待探测" },
            ]}
          />
        </div>
      </Toolbar>}
    >
      {!loaded
        ? <LoadingState label="正在读取 MCP 配置…" />
        : <DataTable<McpServer>
          columns={columns}
          rows={filtered}
          rowKey={(row) => row.server_id}
          activeKey={detail?.server_id ?? null}
          onRowClick={(row) => setDetail(row)}
          emptyTitle={servers.length ? "没有匹配的服务" : "还没有配置 MCP 服务"}
          emptyNote={servers.length
            ? "试着更换状态筛选或清空搜索关键词。"
            : "如果本地跑了一个 MCP 服务，填上它的 HTTP 端点就能验证连通性。"}
          emptyAction={servers.length
            ? <button type="button" className="ghost-action" onClick={() => { setQuery(""); setStatus("all"); }}>清除筛选</button>
            : <button type="button" className="primary-action action-btn" onClick={openCreate}><Plus />新增服务</button>}
        />}
    </Card>

    <Modal
      open={formOpen}
      onClose={() => setFormOpen(false)}
      title="新增 MCP 服务"
      description="HTTP 传输填服务端点（例如 http://127.0.0.1:9100/mcp）；stdio 填启动命令，但服务端不会去拉起进程。"
      footer={<>
        <button type="button" className="ghost-action" onClick={() => setFormOpen(false)}>取消</button>
        <button type="button" className="primary-action action-btn" onClick={() => void submit()}>保存配置</button>
      </>}
    >
      <FormGrid>
        <Field label="服务名称" required error={errors.name}>
          <TextInput value={draft.name} onChange={(value) => setDraft((state) => ({ ...state, name: value }))} placeholder="例如：本地文件系统" invalid={Boolean(errors.name)} />
        </Field>
        <Field label="传输方式">
          <SelectInput
            value={draft.transport}
            onChange={(value) => setDraft((state) => ({ ...state, transport: value as Transport }))}
            options={(Object.keys(transportLabels) as Transport[]).map((item) => ({ value: item, label: transportLabels[item] }))}
          />
        </Field>
      </FormGrid>
      <Field label={draft.transport === "stdio" ? "启动命令" : "服务端点"} required error={errors.endpoint}>
        <TextInput
          value={draft.endpoint}
          onChange={(value) => setDraft((state) => ({ ...state, endpoint: value }))}
          placeholder={draft.transport === "stdio" ? "npx @modelcontextprotocol/server-filesystem ./workspace" : "http://127.0.0.1:9100/mcp"}
          invalid={Boolean(errors.endpoint)}
        />
      </Field>
      <Field label="鉴权令牌" hint={draft.auth_token ? "将以 Authorization: Bearer 发送" : "留空则不带鉴权头；已保存的令牌不会回显"}>
        <TextInput value={draft.auth_token} onChange={(value) => setDraft((state) => ({ ...state, auth_token: value }))} placeholder="可选" />
      </Field>
      <Field label="允许调用的 Agent" hint="留空表示不限制。这是权限边界配置，不会改变探测行为。">
        <div className="chip-list padded">
          {AGENT_IDS.map((id) => <button
            type="button"
            key={id}
            className={`filter-chip ${draftAgents.includes(id) ? "active" : ""}`}
            onClick={() => toggleAgent(id)}
          >{agentLabels[id] ?? id}</button>)}
        </div>
      </Field>
      <Field label="备注">
        <TextArea value={draft.note} onChange={(value) => setDraft((state) => ({ ...state, note: value }))} rows={2} placeholder="例如：限定工作区目录，越界访问直接拒绝。" />
      </Field>
    </Modal>

    <Modal
      open={Boolean(detail)}
      onClose={() => setDetail(null)}
      variant="side"
      title={detail?.name ?? ""}
      description={detail ? `${transportLabels[detail.transport]} · ${detail.endpoint}` : undefined}
      footer={detail && <>
        <button type="button" className="ghost-action" onClick={() => setDetail(null)}>关闭</button>
        <button
          type="button"
          className="primary-action action-btn"
          disabled={probing === detail.server_id || detail.transport !== "http"}
          onClick={() => void probe(detail)}
        >
          {probing === detail.server_id ? "正在握手…" : "测试连接"}
        </button>
      </>}
    >
      {detail && <div className="detail-stack">
        <div className="detail-badges">
          <Pill tone={probeMeta[detail.last_probe_status].tone}>{probeMeta[detail.last_probe_status].label}</Pill>
          <Pill tone="neutral">{detail.transport}</Pill>
          {detail.has_auth && <Pill tone="info"><Key />已配鉴权</Pill>}
          {detail.enabled ? <Pill tone="ok">已启用</Pill> : <Pill tone="neutral">已停用</Pill>}
        </div>

        <section className="detail-block">
          <h3>握手详情</h3>
          <p>{detail.last_probe_detail || "还没有做过握手探测。"}</p>
          {detail.server_name && <dl className="kv-list">
            <div><dt>服务端自报</dt><dd className="mono">{detail.server_name} {detail.server_version}</dd></div>
            <div><dt>握手耗时</dt><dd>{detail.latency_ms} ms</dd></div>
          </dl>}
          {detail.transport !== "http" && <p className="detail-note">
            <Warning />该传输不做服务端探测：stdio 需要在服务器上拉起子进程，sse 的传输方式不同。
          </p>}
        </section>

        <section className="detail-block">
          <h3>服务端自报的工具</h3>
          {detail.tools.length
            ? <ul className="tool-inventory">
              {detail.tools.map((tool) => <li key={tool.name}>
                <Toolbox />
                <div><strong className="mono">{tool.name}</strong><small>{tool.description || "无描述"}</small></div>
                <Pill tone={tool.access === "read" ? "info" : "warn"}>{tool.access === "read" ? "只读" : "写入"}</Pill>
              </li>)}
            </ul>
            : <p className="detail-note">还没有读到工具清单。做一次「测试连接」即可拉取；失败时这里会保持为空。</p>}
        </section>

        <section className="detail-block">
          <h3>权限边界</h3>
          <div className="chip-list padded">
            {detail.allowed_agents.length
              ? detail.allowed_agents.map((id) => <b key={id}>{agentLabels[id] ?? id}</b>)
              : <span className="muted-text">未限制调用方</span>}
          </div>
          {detail.note && <p className="detail-note">{detail.note}</p>}
        </section>

        <section className="detail-block">
          <h3>配置信息</h3>
          <dl className="kv-list">
            <div><dt>标识</dt><dd className="mono">{detail.server_id}</dd></div>
            <div><dt>最近探测</dt><dd>{detail.last_probe_at ? formatDateTime(detail.last_probe_at) : "—"}</dd></div>
            <div><dt>创建时间</dt><dd>{formatDateTime(detail.created_at)}</dd></div>
          </dl>
        </section>

        <div className="detail-actions">
          <button type="button" className="danger-action" onClick={() => setPendingDelete(detail)}><Trash />删除服务</button>
        </div>
      </div>}
    </Modal>

    <ConfirmDialog
      open={Boolean(pendingDelete)}
      title="删除 MCP 服务"
      message={pendingDelete ? `「${pendingDelete.name}」的配置会被删除，已探测到的工具清单一并清除。` : ""}
      confirmLabel="确认删除"
      onConfirm={() => { if (pendingDelete) void remove(pendingDelete); }}
      onClose={() => setPendingDelete(null)}
    />
  </WorkspacePage>;
}
