"use client";

import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { Cpu } from "@phosphor-icons/react/dist/csr/Cpu";
import { HardDrives } from "@phosphor-icons/react/dist/csr/HardDrives";
import { Toolbox } from "@phosphor-icons/react/dist/csr/Toolbox";
import { TreeStructure } from "@phosphor-icons/react/dist/csr/TreeStructure";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { Wrench } from "@phosphor-icons/react/dist/csr/Wrench";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import "../workbench.css";
import "../sidebar.css";
import "../../workspace-layout.css";
import { WorkbenchSidebar, findGroupLabel, findSectionLabel } from "../workbench-sidebar";
import { loadResource, peekCache } from "../resource-cache";
import { agentLabels } from "../runtime/shared";
import { apiFetch } from "../../auth/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";
const SYSTEM_KEY = "system-info";

type Capability = { agent: string; title: string; task_types: string[]; order: number };
type ToolDefinition = { name: string; description: string; allowed_agents: string[]; access: string };
type SystemInfo = {
  reasoning_provider: string;
  persistence: string;
  capabilities: Capability[];
  tools: ToolDefinition[];
};

/* The backend reports provider names like "local-structured" /
   "openai-responses" / "openai-responses-with-fallback". */
function providerLabel(name: string) {
  if (name.startsWith("local")) return { label: "本地规则推理", note: "无需密钥，适合离线与演示" };
  if (name.endsWith("-with-fallback")) return { label: "远程 + 本地回退", note: "远程失败时自动切回本地规则" };
  if (name.startsWith("openai")) return { label: "OpenAI Responses", note: "远程推理，按配置调用" };
  return { label: name, note: "自定义推理 Provider" };
}

/* 运行环境: the runtime truth behind the workbench — which reasoning provider is
   active, where state is persisted, which capabilities the Planner can choose
   from, and exactly which agent may call which tool. Extension points: switch
   provider online, per-tool health checks, and capability-level metrics. */
export default function SystemPage() {
  const [info, setInfo] = useState<SystemInfo | null>(() => peekCache<SystemInfo>(SYSTEM_KEY) ?? null);
  const [loaded, setLoaded] = useState(() => Boolean(peekCache<SystemInfo>(SYSTEM_KEY)));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (force = false) => {
    try {
      const data = await loadResource(SYSTEM_KEY, async () => {
        const response = await apiFetch(`${API_URL}/api/system`);
        if (!response.ok) throw new Error();
        return (await response.json()) as SystemInfo;
      }, { ttlMs: 5_000, force });
      setInfo(data);
      setError("");
    } catch {
      setError("无法读取运行环境信息，请确认 Agent API 已启动。");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }, [load]);

  const provider = info ? providerLabel(info.reasoning_provider) : null;
  const metrics = [
    ["推理 Provider", provider?.label ?? "读取中", provider?.note ?? "", Cpu],
    ["持久化", info?.persistence === "sqlite" ? "SQLite" : info?.persistence ?? "读取中", "任务、审批与事件落盘", HardDrives],
    ["能力项", String(info?.capabilities.length ?? 0), "Planner 可选择的专业能力", TreeStructure],
    ["工具", String(info?.tools.length ?? 0), "运行时注册并强制鉴权", Toolbox],
  ] as const;

  return <main className="control-shell">
    <WorkbenchSidebar active="system" />
    <section className="control-main">
      <header className="control-header">
        <div><p>{findGroupLabel("system")} / {findSectionLabel("system")}</p><h1>{findSectionLabel("system")}</h1></div>
        <div className="header-actions">
          <button onClick={() => void refresh()} disabled={refreshing}><ArrowsClockwise className={refreshing ? "spin" : undefined} />{refreshing ? "刷新中…" : "刷新"}</button>
          <Link className="small-action" href="/workbench#models"><Wrench />模型与工具</Link>
        </div>
      </header>
      {error && <div className="control-message error">{error}</div>}

      <div className="control-content">
        <p className="page-lead">这里展示运行时真实生效的配置：推理 Provider、持久化方式，以及 Planner 可选的能力注册表与工具权限边界。它与「模型与工具」页的愿望配置互为对照。</p>

        <div className="stat-strip">
          {metrics.map(([label, value, note, Icon]) => <div key={label}><small>{label}</small><strong>{value}</strong><p>{note}</p><Icon /></div>)}
        </div>

        <section className="control-card">
          <div className="card-title">
            <span><TreeStructure weight="duotone" /></span>
            <div><h2>能力注册表</h2><p>Planner 只能从这些已声明能力里组队，不能凭空造 Agent</p></div>
            <b className="card-count">{info?.capabilities.length ?? 0}</b>
          </div>
          {!loaded
            ? <div className="placeholder"><span className="spinner" /><p>正在读取能力注册表…</p></div>
            : info?.capabilities.length
              ? <div className="audit-list">{info.capabilities.map((item) => (
                <div className="audit-row static" key={item.agent}>
                  <TreeStructure weight="duotone" />
                  <span>
                    <strong>{agentLabels[item.agent] ?? item.agent}</strong>
                    <small>{item.agent} · {item.title}</small>
                    <small>适用任务：{(item.task_types ?? []).map((type) => type === "all" ? "全部" : type).join("、")}</small>
                  </span>
                  <b>顺序 {item.order}</b>
                </div>
              ))}</div>
              : <div className="placeholder"><Warning /><p>未读取到能力注册表。</p></div>}
        </section>

        <section className="control-card">
          <div className="card-title">
            <span><Toolbox weight="duotone" /></span>
            <div><h2>工具边界</h2><p>每个工具绑定允许调用的 Agent，越权直接抛错并写入审计</p></div>
            <b className="card-count">{info?.tools.length ?? 0}</b>
          </div>
          {!loaded
            ? <div className="placeholder"><span className="spinner" /><p>正在读取工具边界…</p></div>
            : info?.tools.length
              ? <div className="audit-list">{info.tools.map((tool) => (
                <div className="audit-row static" key={tool.name}>
                  <Toolbox weight="duotone" />
                  <span>
                    <strong>{tool.name}</strong>
                    <small>{tool.description}</small>
                    <small>允许：{(tool.allowed_agents ?? []).map((agent) => agentLabels[agent] ?? agent).join("、") || "系统授权"}</small>
                  </span>
                  <b className="access">{tool.access}</b>
                </div>
              ))}</div>
              : <div className="placeholder"><Warning /><p>未读取到工具定义。</p></div>}
        </section>

        <p className="page-note">扩展点：在线切换推理 Provider、工具健康检查、按能力维度统计调用量与失败率。</p>
      </div>
    </section>
  </main>;
}
