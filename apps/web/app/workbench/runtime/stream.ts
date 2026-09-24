"use client";

/* 运行中心的实时事件流：订阅后端 `/api/tasks/{id}/events`（SSE）。

   两条事实决定了这里的写法：
   1. SSE 的 `event:` 字段是后端自定义名（task.started / task.updated /
      approval.received / heartbeat），所以必须 addEventListener 逐个挂，
      默认的 "message" 事件收不到。
   2. 事件体只带 {phase, status}，够当"变了"的信号，不够渲染细节。所以收到事件后
      由调用方去拉一次任务详情 —— 这样阶段、计划、协作、工具调用都能实时长出来。
   认证靠 cookie：请求直连后端并带 withCredentials，这里不碰令牌。 */

import { useEffect, useRef, useState } from "react";

/* 流式不能走同源代理。
   dev 下 /api 由 next.config.ts 的 rewrites 转到后端，而那条代理会缓冲 SSE 响应体：
   curl 直连能立刻收到事件，浏览器里的 EventSource 却永远停在 CONNECTING（实测）。
   所以 SSE 单独取直连地址，并显式带 cookie。

   注意主机名不能写死 127.0.0.1：页面若开在 localhost，两者属于不同站点，
   SameSite=lax 的 cookie 不会被带上，SSE 直接 401。这里沿用页面自己的主机名。
   部署到同域反代时设 NEXT_PUBLIC_STREAM_URL 即可（要求反代不缓冲 SSE）。 */
function streamBase(): string {
  const configured =
    process.env.NEXT_PUBLIC_STREAM_URL?.replace(/\/$/, "") ||
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");
  if (configured) return configured;
  if (typeof window === "undefined") return "";
  return `${window.location.protocol}//${window.location.hostname}:8000`;
}

export type StreamStatus = "off" | "connecting" | "live" | "lost";

const EVENT_NAMES = ["task.started", "task.updated", "approval.received"] as const;
/* 终态：到了就把连接关掉，别让浏览器一直挂着已经结束的任务。 */
const TERMINAL = new Set(["completed", "failed", "rejected", "needs_human", "planned"]);

export function useTaskStream({
  enabled,
  taskIds,
  onEvent,
}: {
  enabled: boolean;
  taskIds: string[];
  onEvent: (taskId: string) => void;
}) {
  const [status, setStatus] = useState<StreamStatus>("off");
  const sources = useRef(new Map<string, EventSource>());
  const handler = useRef(onEvent);
  handler.current = onEvent;

  // 用字符串做依赖，避免每次渲染都重连（数组每次都是新引用）
  const key = taskIds.join(",");

  useEffect(() => {
    if (!enabled) {
      sources.current.forEach((source) => source.close());
      sources.current.clear();
      setStatus("off");
      return;
    }

    const wanted = key ? key.split(",") : [];
    setStatus((current) => (wanted.length ? (current === "live" ? current : "connecting") : "off"));

    for (const taskId of wanted) {
      if (sources.current.has(taskId)) continue;
      const source = new EventSource(`${streamBase()}/api/tasks/${taskId}/events`, {
        withCredentials: true,
      });
      sources.current.set(taskId, source);

      const relay = (event: MessageEvent) => {
        setStatus("live");
        try {
          const payload = JSON.parse(String(event.data)) as { status?: string };
          if (payload.status && TERMINAL.has(payload.status)) {
            source.close();
            sources.current.delete(taskId);
          }
        } catch {
          /* heartbeat 之类的空事件，忽略 */
        }
        handler.current(taskId);
      };

      for (const name of EVENT_NAMES) {
        source.addEventListener(name, relay as EventListener);
      }
      source.addEventListener("heartbeat", () => {
        setStatus((current) => (current === "off" ? current : "live"));
      });
      // EventSource 自带重连，这里只负责把状态如实报出去
      source.onerror = () => setStatus("lost");
    }

    for (const [taskId, source] of [...sources.current]) {
      if (!wanted.includes(taskId)) {
        source.close();
        sources.current.delete(taskId);
      }
    }
  }, [enabled, key]);

  useEffect(
    () => () => {
      sources.current.forEach((source) => source.close());
      sources.current.clear();
    },
    [],
  );

  return { status };
}

export function streamStatusText(status: StreamStatus): string {
  if (status === "live") return "实时连接中";
  if (status === "connecting") return "正在建立实时连接";
  if (status === "lost") return "实时连接中断，正在重连";
  return "实时推送已关闭";
}

/* 还没跑完的任务才需要订阅；终结态订阅没有意义。 */
export function isActiveTask(status: string): boolean {
  return !TERMINAL.has(status);
}
