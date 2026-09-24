"use client";

// Direct module paths keep the bundler from walking the full icon barrel on
// every compile, which is what slows down dev navigation.
import { Brain } from "@phosphor-icons/react/dist/csr/Brain";
import { Buildings } from "@phosphor-icons/react/dist/csr/Buildings";
import { ChartLineUp } from "@phosphor-icons/react/dist/csr/ChartLineUp";
import { CirclesFour } from "@phosphor-icons/react/dist/csr/CirclesFour";
import { ClipboardText } from "@phosphor-icons/react/dist/csr/ClipboardText";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { Coins } from "@phosphor-icons/react/dist/csr/Coins";
import { Database } from "@phosphor-icons/react/dist/csr/Database";
import { DesktopTower } from "@phosphor-icons/react/dist/csr/DesktopTower";
import { FlowArrow } from "@phosphor-icons/react/dist/csr/FlowArrow";
import { GearSix } from "@phosphor-icons/react/dist/csr/GearSix";
import { Lightning } from "@phosphor-icons/react/dist/csr/Lightning";
import { Paperclip } from "@phosphor-icons/react/dist/csr/Paperclip";
import { PlugsConnected } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import { PuzzlePiece } from "@phosphor-icons/react/dist/csr/PuzzlePiece";
import { ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { LockSimple } from "@phosphor-icons/react/dist/csr/LockSimple";
import { SignOut } from "@phosphor-icons/react/dist/csr/SignOut";
import { UsersThree } from "@phosphor-icons/react/dist/csr/UsersThree";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { Wrench } from "@phosphor-icons/react/dist/csr/Wrench";
import Link from "next/link";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { ComponentType } from "react";
import { useAuth } from "../auth/provider";
import { BrandMark } from "../brand-mark";

type NavIcon = ComponentType<{ weight?: "thin" | "light" | "regular" | "bold" | "fill" | "duotone" }>;

/* Sections are hash-switched inside /workbench and can be swapped in place;
   routes are their own pages. The sidebar is data-driven so adding a page is a
   one-line change here instead of a new branch in the markup. */
export type WorkspaceSection =
  | "overview"
  | "agents"
  | "rag"
  | "context"
  | "models"
  | "governance";

export type RouteId =
  | "runtime"
  | "audit"
  | "schedules"
  | "workflows"
  | "mcp"
  | "skills"
  | "assets"
  | "observability"
  | "usage"
  | "system"
  | "tenants"
  | "settings";

export type WorkbenchLocation = WorkspaceSection | RouteId;

type SectionItem = { kind: "section"; id: WorkspaceSection; label: string; icon: NavIcon };
type RouteItem = { kind: "route"; id: RouteId; label: string; icon: NavIcon; href: string; badge?: string };
export type NavItem = SectionItem | RouteItem;
export type NavGroup = { id: string; label: string; items: NavItem[] };

export const navGroups: NavGroup[] = [
  {
    id: "run",
    label: "运行工作台",
    items: [
      { kind: "route", id: "runtime", label: "运行中心", icon: Lightning, href: "/workbench/runtime" },
      { kind: "route", id: "audit", label: "运行审计", icon: ClipboardText, href: "/workbench/audit" },
      { kind: "route", id: "schedules", label: "定时任务", icon: Clock, href: "/workbench/schedules" },
    ],
  },
  {
    id: "build",
    label: "能力构建",
    items: [
      { kind: "section", id: "overview", label: "编排总览", icon: CirclesFour },
      { kind: "section", id: "agents", label: "Agent 管理", icon: UsersThree },
      { kind: "route", id: "workflows", label: "工作流编排", icon: FlowArrow, href: "/workbench/workflows" },
      { kind: "section", id: "rag", label: "RAG 知识库", icon: Database },
      { kind: "route", id: "mcp", label: "MCP 中心", icon: PlugsConnected, href: "/workbench/mcp" },
      { kind: "route", id: "skills", label: "Skill 中心", icon: PuzzlePiece, href: "/workbench/skills" },
      { kind: "route", id: "assets", label: "附件资产", icon: Paperclip, href: "/workbench/assets" },
      { kind: "section", id: "context", label: "上下文管理", icon: Brain },
      { kind: "section", id: "models", label: "模型与工具", icon: Wrench },
    ],
  },
  {
    id: "govern",
    label: "治理与观测",
    items: [
      { kind: "section", id: "governance", label: "治理策略", icon: ShieldCheck },
      { kind: "route", id: "observability", label: "可观测性", icon: ChartLineUp, href: "/workbench/observability" },
      { kind: "route", id: "usage", label: "Token 用量", icon: Coins, href: "/workbench/usage" },
      { kind: "route", id: "system", label: "运行环境", icon: DesktopTower, href: "/workbench/system" },
    ],
  },
  {
    id: "workspace",
    label: "工作区设置",
    items: [
      { kind: "route", id: "tenants", label: "成员与角色", icon: Buildings, href: "/workbench/tenants" },
      { kind: "route", id: "settings", label: "账号设置", icon: GearSix, href: "/workbench/settings" },
    ],
  },
];

/* Backwards-compatible shape used by the orchestration page for hash routing. */
export const workspaceSections = navGroups
  .flatMap((group) => group.items)
  .filter((item): item is SectionItem => item.kind === "section")
  .map((item) => ({ id: item.id, label: item.label, icon: item.icon }));

const allItems = navGroups.flatMap((group) => group.items);

/* Points at the FastAPI docs.
   没配 NEXT_PUBLIC_API_URL 时用**相对路径**，由 next.config.ts 把 /docs 同源代理到后端 ——
   写死 http://localhost:8000 的话，部署到域名后这个链接指向访客自己的本机，必然打不开。 */
const API_DOCS_URL = process.env.NEXT_PUBLIC_API_URL
  ? `${process.env.NEXT_PUBLIC_API_URL.replace(/\/$/, "")}/docs`
  : "/docs";

export function findSectionLabel(location: WorkbenchLocation) {
  return allItems.find((item) => item.id === location)?.label ?? "编排总览";
}

export function findGroupLabel(location: WorkbenchLocation) {
  return navGroups.find((group) => group.items.some((item) => item.id === location))?.label ?? "控制台";
}

/* Every route item declared above, as pathname → id. Kept derived from
   navGroups so a new page only ever needs one edit. */
const routeByPath = new Map<string, RouteId>(
  navGroups
    .flatMap((group) => group.items)
    .filter((item): item is RouteItem => item.kind === "route")
    .map((item) => [item.href, item.id]),
);

/* The /workbench route segment owns a loading.tsx that wraps every nested page,
   so its fallback cannot receive the destination as a prop. Resolving the
   highlight from the pathname keeps the sidebar honest while a page streams in
   instead of flashing the hard-coded "编排总览". */
export function locationFromPathname(pathname: string): RouteId | null {
  return routeByPath.get(pathname) ?? null;
}

/* When the orchestration page is already mounted, its sections are switched in
   place. A hash link would go through Next's client router, which uses
   pushState and therefore never fires `hashchange` — the page would silently
   ignore the click. Passing a handler keeps the switch local and instant, while
   the URL still tracks the section so a reload or shared link works. */
/* 当前账号。侧边栏在 rail 最底部固定展示，所以退出登录在任何页面都点得到，
   不必再塞一个重复的「账号设置」入口——设置页本身就在导航里。 */
/* 侧边栏的滚动位置。
   它在每个页面里各自渲染，路由一换就整个重建，组件内的状态会跟着消失 —— 所以存到
   sessionStorage（整页刷新也还在），挂载时在绘制前还原。useLayoutEffect 在绘制前执行，
   不会先闪一下顶部；服务端渲染阶段没有 window，退回 useEffect。 */
const NAV_SCROLL_KEY = "neptune.workbench.v1.navScroll";

function readNavScroll(): number {
  if (typeof window === "undefined") return 0;
  const value = Number(window.sessionStorage.getItem(NAV_SCROLL_KEY) ?? "0");
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function writeNavScroll(value: number): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(NAV_SCROLL_KEY, String(Math.max(0, Math.round(value))));
  } catch {
    /* 隐私模式写不进去，退化成"不记忆"，不影响使用 */
  }
}
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/* 角色文案：访客必须单独标出来 —— 它确实只能看，说成"成员"是错的。 */
function roleText(role: string) {
  if (role === "admin") return "管理员";
  if (role === "guest") return "访客（只读）";
  return "成员";
}

function AccountBlock() {
  const { user, status, logout } = useAuth();
  const initial =
    user?.display_name.trim().slice(0, 1) || user?.username.slice(0, 1) || "·";
  return <div className="control-user">
    <div className="control-user-top">
      <span className="control-user-avatar" aria-hidden="true">{initial}</span>
      <div className="control-user-text">
        <strong>{user?.display_name ?? (status === "loading" ? "读取中…" : "未登录")}</strong>
        <small>{user ? `@${user.username} · ${roleText(user.role)}` : "—"}</small>
      </div>
    </div>
    {user?.role === "guest" && <p className="control-user-guest">
      <LockSimple />访客是只读会话：可以浏览，不能发起任务、审批或改动配置
    </p>}
    {user?.must_change_password && <p className="control-user-warn">
      <Warning />仍在使用初始密码，请到「账号设置」修改
    </p>}
    <div className="control-user-actions">
      <button type="button" onClick={() => void logout()}><SignOut />退出登录</button>
    </div>
  </div>;
}

export function WorkbenchSidebar({
  active,
  onSelectSection,
}: {
  active: WorkbenchLocation;
  onSelectSection?: (id: WorkspaceSection) => void;
}) {
  const navRef = useRef<HTMLElement | null>(null);

  useIsomorphicLayoutEffect(() => {
    const node = navRef.current;
    const remembered = readNavScroll();
    if (node && remembered > 0) node.scrollTop = remembered;
  }, []);

  return <aside className="control-rail">
    <Link className="control-logo" href="/workbench/runtime"><span><BrandMark /></span><div><strong>Neptune</strong><small>CONTROL PLANE</small></div></Link>
    <div className="control-status"><i /><span><strong>工作区在线</strong><small>SQLite · 本地持久化</small></span></div>
    <nav
      className="nav-groups"
      ref={navRef}
      onScroll={(event) => {
        writeNavScroll(event.currentTarget.scrollTop);
      }}
    >
      {navGroups.map((group) => (
        <div className="nav-group" key={group.id}>
          <p className="nav-label">{group.label}</p>
          <div className="section-nav">
            {group.items.map((item) => item.kind === "section" ? (
              onSelectSection ? (
                <button
                  type="button"
                  className={`section-link ${active === item.id ? "active" : ""}`}
                  key={item.id}
                  aria-current={active === item.id ? "page" : undefined}
                  onClick={() => onSelectSection(item.id)}
                >
                  <item.icon />{item.label}
                </button>
              ) : (
                <Link
                  className={`section-link ${active === item.id ? "active" : ""}`}
                  href={`/workbench#${item.id}`}
                  key={item.id}
                  aria-current={active === item.id ? "page" : undefined}
                ><item.icon />{item.label}</Link>
              )
            ) : (
              <Link
                className={`section-link ${active === item.id ? "active" : ""}`}
                href={item.href}
                key={item.id}
                aria-current={active === item.id ? "page" : undefined}
              ><item.icon />{item.label}</Link>
            ))}
          </div>
        </div>
      ))}
    </nav>
    {/* Bottom regions: like the brand block they never scroll with the nav. */}
    <AccountBlock />
    <footer className="control-foot">
      <span>v0.1.0</span>
      <a href={API_DOCS_URL} target="_blank" rel="noreferrer">API 文档</a>
    </footer>
  </aside>;
}
