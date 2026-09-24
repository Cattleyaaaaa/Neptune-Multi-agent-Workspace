import type { Metadata } from "next";
import { AuthProvider } from "./auth/provider";
import "./globals.css";
import "./tools.css";
// workspace-layout.css is imported by each route after its own styles,
// so it stays the final authority for shell spacing and magnification.

export const metadata: Metadata = {
  title: "Neptune · 通用 Agent 工作台",
  description: "Supervisor 驱动的通用多 Agent 任务工作台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // AuthProvider 挂在根布局：侧边栏、设置页、以及所有 apiFetch 都依赖同一个会话状态。
  return <html lang="zh-CN"><body><AuthProvider>{children}</AuthProvider></body></html>;
}
