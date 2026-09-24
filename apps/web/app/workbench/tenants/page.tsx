"use client";

import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Prohibit } from "@phosphor-icons/react/dist/csr/Prohibit";
import { ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { UserCircle } from "@phosphor-icons/react/dist/csr/UserCircle";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, apiUrl, toErrorMessage } from "../../auth/api";
import { WorkspacePage } from "../ui/shell";
import {
  Card, ErrorState, FilterChips, LoadingState, Pill, SampleBanner, SearchField,
  SelectInput, StatStrip, Toolbar,
} from "../ui/primitives";
import { DataTable, type Column } from "../ui/table";
import { formatDateTime } from "../ui/data";

/* 成员来自真实 users 表（GET /api/members）。后端没有成员的新增 / 改角色 / 删除
   接口，所以这一页是只读的：不提供任何会写入本地的按钮。 */
type Member = {
  user_id: string;
  username: string;
  display_name: string;
  role: string;
  must_change_password: boolean;
  disabled: boolean;
  last_login_at: string;
  created_at: string;
};

type RoleMeta = { role: string; label: string; scopes: string[] };

type MembersPayload = {
  members: Member[];
  roles: RoleMeta[];
  note: string;
};

/* 后端返回的作用域是机器可读的 key，这里只做展示翻译，未命中就原样显示。 */
const scopeLabels: Record<string, string> = {
  workspace: "工作区配置",
  agents: "Agent 与工具配置",
  governance: "治理与审批",
  runtime: "运行中心",
};

type StatusFilter = "all" | "active" | "pending" | "disabled";

/* 成员与角色：后端账号体系的只读视图。角色字段已入库，但还没有接到页面级
   授权上 —— 这一点由后端返回的 note 直接摆在页面上，不做任何粉饰。 */
export default function MembersPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<RoleMeta[]>([]);
  const [note, setNote] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [query, setQuery] = useState("");
  const [role, setRole] = useState("all");
  const [status, setStatus] = useState<StatusFilter>("all");

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await apiFetch(apiUrl("/api/members"));
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(toErrorMessage(payload, "无法读取成员列表"));
      }
      const payload = (await response.json()) as MembersPayload;
      setMembers(payload.members ?? []);
      setRoles(payload.roles ?? []);
      setNote(payload.note ?? "");
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "无法读取成员列表，请确认后端已启动。");
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const roleMeta = useMemo(
    () => new Map(roles.map((item) => [item.role, item.label])),
    [roles],
  );

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return members.filter((item) => {
      if (role !== "all" && item.role !== role) return false;
      if (status === "active" && (item.disabled || item.must_change_password)) return false;
      if (status === "pending" && !item.must_change_password) return false;
      if (status === "disabled" && !item.disabled) return false;
      if (!keyword) return true;
      return item.display_name.toLowerCase().includes(keyword)
        || item.username.toLowerCase().includes(keyword);
    });
  }, [members, query, role, status]);

  const metrics = [
    { label: "成员", value: members.length, note: "来自 users 表", icon: UserCircle },
    {
      label: "管理员",
      value: members.filter((item) => item.role === "admin").length,
      note: roleMeta.get("admin") ?? "admin",
      icon: ShieldCheck,
    },
    { label: "待改初始密码", value: members.filter((item) => item.must_change_password).length, note: "首次登录后应尽快修改", icon: Warning },
    { label: "已停用", value: members.filter((item) => item.disabled).length, note: "无法登录", icon: Prohibit },
  ];

  const columns: Array<Column<Member>> = [
    {
      key: "name",
      header: "成员",
      sortValue: (row) => row.display_name || row.username,
      render: (row) => <span className="cell-title with-icon">
        <i className="avatar-badge">{(row.display_name || row.username).slice(0, 1)}</i>
        <span>
          <strong>{row.display_name || row.username}</strong>
          <small className="mono">{row.username}</small>
        </span>
      </span>,
    },
    {
      key: "role",
      header: "角色",
      sortValue: (row) => row.role,
      render: (row) => <Pill tone={row.role === "admin" ? "accent" : "neutral"}>{roleMeta.get(row.role) ?? row.role}</Pill>,
    },
    {
      key: "status",
      header: "状态",
      sortValue: (row) => (row.disabled ? "2" : row.must_change_password ? "1" : "0"),
      render: (row) => <span className="cell-stack">
        <Pill tone={row.disabled ? "danger" : row.must_change_password ? "warn" : "ok"}>
          {row.disabled ? "已停用" : row.must_change_password ? "待改初始密码" : "正常"}
        </Pill>
      </span>,
    },
    {
      key: "last_login_at",
      header: "最近登录",
      sortValue: (row) => row.last_login_at,
      render: (row) => row.last_login_at
        ? formatDateTime(row.last_login_at)
        : <span className="muted-text">尚未登录过</span>,
    },
    {
      key: "created_at",
      header: "创建时间",
      secondary: true,
      sortValue: (row) => row.created_at,
      render: (row) => formatDateTime(row.created_at),
    },
    {
      key: "user_id",
      header: "用户 ID",
      secondary: true,
      sortValue: (row) => row.user_id,
      render: (row) => <span className="mono">{row.user_id}</span>,
    },
  ];

  return <WorkspacePage
    active="tenants"
    note="工作区账号的只读视图：成员直接来自后端 users 表，包含角色、是否仍在使用初始密码以及最近登录时间。后端暂未提供成员的新增、改角色与删除接口，因此这里不做任何写入。"
    actions={<button type="button" onClick={() => void load()} disabled={refreshing}>
      <ArrowsClockwise className={refreshing ? "spin" : undefined} />{refreshing ? "同步中…" : "刷新"}
    </button>}
  >
    {note && <p className="detail-note"><Warning />{note}</p>}

    <StatStrip items={metrics} />

    <Card
      icon={UserCircle}
      title="成员列表"
      note="只读：按姓名、用户名或角色筛选"
      count={filtered.length}
      toolbar={<Toolbar>
        <SearchField value={query} onChange={setQuery} placeholder="搜索姓名或用户名" />
        <div className="toolbar-filters">
          <SelectInput
            value={role}
            onChange={setRole}
            options={[{ value: "all", label: "全部角色" }, ...roles.map((item) => ({ value: item.role, label: item.label }))]}
          />
          <FilterChips<StatusFilter>
            value={status}
            onChange={setStatus}
            options={[
              { id: "all", label: "全部" },
              { id: "active", label: "正常" },
              { id: "pending", label: "待改密码" },
              { id: "disabled", label: "已停用" },
            ]}
            counts={{
              all: members.length,
              active: members.filter((item) => !item.disabled && !item.must_change_password).length,
              pending: members.filter((item) => item.must_change_password).length,
              disabled: members.filter((item) => item.disabled).length,
            }}
          />
        </div>
      </Toolbar>}
    >
      {!loaded
        ? <LoadingState label="正在读取成员列表…" />
        : loadError
          ? <ErrorState message={loadError} onRetry={() => void load()} />
          : <DataTable<Member>
            columns={columns}
            rows={filtered}
            rowKey={(row) => row.user_id}
            pageSize={8}
            emptyTitle={members.length ? "没有匹配的成员" : "还没有成员"}
            emptyNote={members.length ? "试着清空搜索或更换筛选条件。" : "账号体系中还没有任何用户记录。"}
            emptyAction={members.length
              ? <button type="button" className="ghost-action" onClick={() => { setQuery(""); setRole("all"); setStatus("all"); }}>清除筛选</button>
              : undefined}
          />}
    </Card>

    <SampleBanner note="下方角色作用域矩阵属于规划信息：后端目前只返回角色定义与作用域清单，尚未用于页面级授权 —— 现在的页面不会因为角色不同而隐藏入口或拦截操作。" />

    <Card
      icon={ShieldCheck}
      title="角色作用域（规划中，尚未生效）"
      note="后端 /api/members 返回的 roles 字段，当前只做展示"
    >
      <div className="permission-grid">
        {roles.map((entry) => <article key={entry.role}>
          <header>
            <strong>{entry.label}</strong>
            <Pill tone="neutral">{members.filter((item) => item.role === entry.role).length} 人</Pill>
          </header>
          <ul>{entry.scopes.map((scope) => <li key={scope}><CheckCircle weight="fill" />{scopeLabels[scope] ?? scope}</li>)}</ul>
        </article>)}
      </div>
      {!roles.length && <p className="detail-note">后端还没有返回任何角色定义。</p>}
    </Card>
  </WorkspacePage>;
}
