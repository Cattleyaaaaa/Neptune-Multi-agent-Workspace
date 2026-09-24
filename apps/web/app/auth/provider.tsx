"use client";

/* 会话只在这里维护。组件不直接碰令牌——令牌在 httpOnly cookie 里，
   前端能看到的只有"当前是谁"和两个到期时间。 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { clearCache } from "../workbench/resource-cache";
import { apiFetch, apiUrl, redirectToLogin, renewSession } from "./api";

export type AuthUser = {
  user_id: string;
  username: string;
  display_name: string;
  role: "admin" | "member" | "guest";
  must_change_password: boolean;
};

type Me = {
  user: AuthUser;
  access_expires_at: string;
  refresh_expires_at: string;
};

type AuthStatus = "loading" | "authenticated" | "anonymous";

type AuthContextValue = {
  user: AuthUser | null;
  status: AuthStatus;
  /* 访客是只读会话：后端会拒绝写操作，界面据此禁用入口并说明原因。 */
  isGuest: boolean;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  reload: () => Promise<void>;
  logout: () => Promise<void>;
};

/* 访问令牌过期前多久开始续期。留足一次网络往返的余量。 */
const RENEW_LEAD_MS = 90_000;
/* 回到前台时，剩余寿命低于这个值就先续期，避免用户看到一屏 401。 */
const STALE_ON_FOCUS_MS = 5 * 60_000;

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");

  const reload = useCallback(async () => {
    try {
      const response = await apiFetch(apiUrl("/api/auth/me"));
      if (!response.ok) {
        setMe(null);
        setStatus("anonymous");
        return;
      }
      setMe((await response.json()) as Me);
      setStatus("authenticated");
    } catch {
      setMe(null);
      setStatus("anonymous");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 到期前主动续期：轮询和 SSE 就不会先撞上一次 401。
  useEffect(() => {
    if (status !== "authenticated" || !me) return;
    const expiresAt = Date.parse(me.access_expires_at);
    if (!Number.isFinite(expiresAt)) return;
    const timer = window.setTimeout(
      () => {
        void renewSession().then((ok) => (ok ? void reload() : redirectToLogin()));
      },
      Math.max(5_000, expiresAt - Date.now() - RENEW_LEAD_MS),
    );
    return () => window.clearTimeout(timer);
  }, [status, me, reload]);

  // 标签页在后台放久了，定时器可能被浏览器掐掉——回到前台时补一次。
  useEffect(() => {
    if (status !== "authenticated" || !me) return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const expiresAt = Date.parse(me.access_expires_at);
      if (Number.isFinite(expiresAt) && expiresAt - Date.now() < STALE_ON_FOCUS_MS) {
        void renewSession().then((ok) => (ok ? void reload() : redirectToLogin()));
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [status, me, reload]);

  const logout = useCallback(async () => {
    try {
      await fetch(apiUrl("/api/auth/logout"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } catch {
      // 后端没回应也要把本地状态清掉；cookie 由下次 /refresh 的 401 兜底清除。
      console.warn("登出请求失败，本地会话状态已清除");
    }
    // 缓存里是上一个账号的任务数据，必须清掉，否则会闪给下一个人看。
    clearCache();
    setMe(null);
    setStatus("anonymous");
    window.location.assign("/login");
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: me?.user ?? null,
      status,
      isGuest: me?.user.role === "guest",
      accessExpiresAt: me?.access_expires_at ?? "",
      refreshExpiresAt: me?.refresh_expires_at ?? "",
      reload,
      logout,
    }),
    [me, status, reload, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth 必须在 AuthProvider 内使用");
  return value;
}
