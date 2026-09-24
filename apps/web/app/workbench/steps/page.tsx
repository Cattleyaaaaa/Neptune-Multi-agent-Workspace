"use client";

import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import "../workbench.css";
import "../sidebar.css";
import "../../workspace-layout.css";
import { apiFetch } from "../../auth/api";
import { WorkbenchSidebar, findGroupLabel } from "../workbench-sidebar";
import { loadResource } from "../resource-cache";
import { Task, agentLabels, knowledgeSummary, statusText, statusTone } from "../runtime/shared";
import { TaskDetail } from "../runtime/task-detail";

const API_URL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";
const TASKS_KEY = "task-list";

/* 「运行步骤」独立界面：对话页只负责说话，步骤、计划、协作、工具调用与交付物
   都放在这里，避免一边聊天一边还要读一张巨大的详情表。
   路由是 /workbench/runtime/<taskId>，所以可以直接分享某一次运行的步骤。 */
/* 步骤页：静态路由 + 查询参数。
   本机 dev 环境下命中动态路由段的请求会让 Next 的渲染 worker 崩溃
   （webpack 与 turbopack 都一样），而这一页不需要任何服务端渲染，
   所以改成 /workbench/steps?task=<id>；旧的 /workbench/runtime/<id>
   由 next.config.ts 的 redirect 兜住，分享出去的链接不会失效。 */
function StepsView() {
  const search = useSearchParams();
  const taskId = search.get("task") ?? "";
  const [task, setTask] = useState<Task | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const tasks = await loadResource<Task[]>(
        TASKS_KEY,
        async () => {
          const response = await apiFetch(`${API_URL}/api/tasks`);
          if (!response.ok) throw new Error();
          return (await response.json()) as Task[];
        },
        { ttlMs: 1_000, force: true },
      );
      setTask(tasks.find((item) => item.task_id === taskId));
      setError("");
    } catch {
      setError("无法连接 Agent API，请确认后端已启动。");
    } finally {
      setLoaded(true);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(decision: "approve" | "reject") {
    if (!task) return;
    setBusy(true);
    try {
      const response = await apiFetch(`${API_URL}/api/tasks/${task.task_id}/approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          approver_id: "workspace-owner",
          note: "已核对任务计划与风险",
        }),
      });
      if (!response.ok) throw new Error();
      await load();
    } catch {
      setError("审批失败，请刷新任务状态后重试。");
    } finally {
      setBusy(false);
    }
  }

  const title = task ? task.objective : loaded ? "未找到这次运行" : "正在读取步骤…";

  return <main className="control-shell">
    <WorkbenchSidebar active="runtime" />
    <section className="control-main">
      <header className="control-header">
        <div>
          <p>{findGroupLabel("runtime")} / 运行步骤</p>
          <h1>{title}</h1>
        </div>
        <div className="header-actions">
          <Link className="tool-btn" href="/workbench/runtime"><ArrowLeft />返回对话</Link>
          <button type="button" className="tool-btn" onClick={() => void load()}>
            <ArrowsClockwise />刷新
          </button>
        </div>
      </header>

      <div className="steps-shell">
        {error && <div className="inline-error"><Warning /><span>{error}</span></div>}
        {!loaded && <div className="placeholder"><span className="spinner" /><p>正在读取步骤…</p></div>}
        {loaded && !task && <div className="placeholder">
          <Warning />
          <p>没有找到这次运行的记录</p>
          <small>它可能已被关闭或清理，回到对话页可以重新发起。</small>
        </div>}
        {task && <>
          <div className="steps-meta">
            <span><b>状态</b>{statusText(task.status)}</span>
            <span><b>运行模式</b>{task.execution_mode === "plan_only" ? "仅生成计划" : "自动执行"}</span>
            <span><b>运行 Agent</b>{task.requested_agent && task.requested_agent !== "auto"
              ? agentLabels[task.requested_agent] ?? task.requested_agent
              : "自动组队"}</span>
            <span><b>知识库</b>{knowledgeSummary(task.knowledge)}</span>
            <span><b>风险</b>{task.risk_level === "high" ? "高" : task.risk_level === "medium" ? "中" : "低"}</span>
            <i className={`dot ${statusTone(task.status)}`} />
          </div>
          <div className="steps-body">
            <TaskDetail
              task={task}
              busy={busy}
              onDecide={(value) => void decide(value)}
              apiUrl={API_URL}
              initialStep={search.get("step")}
            />
          </div>
        </>}
      </div>
    </section>
  </main>;
}

export default function StepsPage() {
  return <Suspense fallback={<main className="control-shell">
    <div className="placeholder"><span className="spinner" /><p>正在读取步骤…</p></div>
  </main>}>
    <StepsView />
  </Suspense>;
}
