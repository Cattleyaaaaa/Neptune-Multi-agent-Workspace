"use client";

/* 所有后端调用都经过这里，原因只有一个：访问令牌只有 30 分钟。
   拿 401 不代表未登录，多数时候只是该续期了——所以先静默续一次期，
   再原样重放请求，业务代码就完全不用关心令牌生命周期。

   浏览器侧令牌全部放在 httpOnly cookie 里，JS 拿不到也不需要拿：
   EventSource（SSE）和下载链接都会自动带上 cookie。 */

const API_URL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";

export const LOGIN_PATH = "/login";

/* 并发请求同时撞上过期时，只允许一次续期，其余请求共享同一个 Promise。 */
let renewal: Promise<boolean> | null = null;

export function apiUrl(path: string): string {
  return `${API_URL}${path}`;
}

/* 后端的错误有两种 detail 形状：业务错误是字符串，参数校验（422）是对象数组。
   直接把数组塞进 state 会变成 React 渲染对象而整页崩掉 —— 这里统一压成一句话。 */
export function toErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const detail = (payload as { detail?: unknown }).detail;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const entry = item as { loc?: unknown; msg?: unknown };
        const field =
          Array.isArray(entry.loc) && entry.loc.length
            ? String(entry.loc[entry.loc.length - 1])
            : "";
        const message = typeof entry.msg === "string" ? entry.msg : "";
        return field && message ? `${field}：${message}` : message;
      })
      .filter(Boolean);
    if (messages.length) return messages.join("；");
  }
  return fallback;
}

async function renewSession(): Promise<boolean> {
  if (!renewal) {
    renewal = fetch(apiUrl("/api/auth/refresh"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .then((response) => response.ok)
      .catch(() => false)
      .finally(() => {
        renewal = null;
      });
  }
  return renewal;
}

export function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  const { pathname, search, hash } = window.location;
  if (pathname === LOGIN_PATH) return;
  const next = `${pathname}${search}${hash}`;
  window.location.assign(`${LOGIN_PATH}?next=${encodeURIComponent(next)}`);
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const options: RequestInit = { ...init, credentials: "include" };
  const response = await fetch(input, options);
  if (response.status !== 401) return response;

  if (!(await renewSession())) {
    // 续期也失败，说明刷新令牌真的没用了——回登录页，并把当前地址带上。
    redirectToLogin();
    return response;
  }
  return fetch(input, options);
}

/* 主动续期的入口：AuthProvider 用它在访问令牌过期前刷新，
   这样正在轮询或开着 SSE 的页面不会先吃一次 401。 */
export { renewSession };
