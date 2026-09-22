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
import { SignOut } from "@phosphor-icons/react/dist/csr/SignOut";
import { Sparkle } from "@phosphor-icons/react/dist/csr/Sparkle";
import { UsersThree } from "@phosphor-icons/react/dist/csr/UsersThree";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { Wrench } from "@phosphor-icons/react/dist/csr/Wrench";
import Link from "next/link";
import type { ComponentType } from "react";
import { useAuth } from "../auth/provider";

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
      { kind: "route", id: "tenants", label: "租户与成员", icon: Buildings, href: "/workbench/tenants" },
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

/* Points at the FastAPI docs. Mirrors the rewrite target in next.config.ts so
   the link stays correct when NEXT_PUBLIC_API_URL is overridden. */
const API_DOCS_URL = `${(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/$/, "")}/docs`;

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
function AccountBlock() {
  const { user, status, logout } = useAuth();
  const initial =
    user?.display_name.trim().slice(0, 1) || user?.username.slice(0, 1) || "·";
  return <div className="control-user">
    <div className="control-user-top">
      <span className="control-user-avatar" aria-hidden="true">{initial}</span>
      <div className="control-user-text">
        <strong>{user?.display_name ?? (status === "loading" ? "读取中…" : "未登录")}</strong>
        <small>{user ? `@${user.username} · ${user.role === "admin" ? "管理员" : "成员"}` : "—"}</small>
      </div>
    </div>
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
  return <aside className="control-rail">
    <Link className="control-logo" href="/workbench/runtime"><span><Sparkle weight="fill" /></span><div><strong>Nexus</strong><small>CONTROL PLANE</small></div></Link>
    <div className="control-status"><i /><span><strong>工作区在线</strong><small>SQLite · 本地持久化</small></span></div>
    <nav className="nav-groups">
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
