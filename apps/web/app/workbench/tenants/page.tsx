"use client";

import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { Buildings } from "@phosphor-icons/react/dist/csr/Buildings";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { EnvelopeSimple } from "@phosphor-icons/react/dist/csr/EnvelopeSimple";
import { Prohibit } from "@phosphor-icons/react/dist/csr/Prohibit";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { UserCircle } from "@phosphor-icons/react/dist/csr/UserCircle";
import { UserPlus } from "@phosphor-icons/react/dist/csr/UserPlus";
import { useMemo, useState } from "react";
import { WorkspacePage } from "../ui/shell";
import {
  Card, ConfirmDialog, Field, FilterChips, FormGrid, LoadingState, Modal, Pill,
  ProgressMeter, SampleBanner, SearchField, SelectInput, StatStrip, SwitchRow, TextInput, Toolbar, useNotice,
} from "../ui/primitives";
import { DataTable, IconButton, RowActions, type Column } from "../ui/table";
import { useCollection } from "../ui/store";
import { formatDateTime, memberSeeds, roleLabels, rolePermissions, tenantSeeds, type Member, type MemberRole } from "../ui/data";

type RoleFilter = "all" | MemberRole;
type StatusFilter = "all" | Member["status"];

const statusMeta: Record<Member["status"], { label: string; tone: "ok" | "warn" | "danger" }> = {
  active: { label: "正常", tone: "ok" },
  invited: { label: "待接受邀请", tone: "warn" },
  suspended: { label: "已停用", tone: "danger" },
};

const planLabels: Record<string, string> = { free: "免费版", team: "团队版", enterprise: "企业版", trial: "试用中" };

/* 租户与成员: 工作区的组织边界。角色决定能改什么配置、能否审批高风险动作 ——
   这里的设置会直接约束运行中心的审批入口出现与否。 */
export default function TenantsPage() {
  const { items, ready, create, update, remove } = useCollection<Member>("members", memberSeeds);
  const { notice, push, clear } = useNotice();

  const [tenantId, setTenantId] = useState("all");
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<RoleFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invite, setInvite] = useState({ name: "", email: "", role: "builder" as MemberRole, tenantId: tenantSeeds[0].id, tenantWide: true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<Member | null>(null);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return items.filter((item) => {
      if (tenantId !== "all" && item.tenantId !== tenantId) return false;
      if (role !== "all" && item.role !== role) return false;
      if (status !== "all" && item.status !== status) return false;
      if (!keyword) return true;
      return item.name.toLowerCase().includes(keyword) || item.email.toLowerCase().includes(keyword);
    });
  }, [items, query, role, status, tenantId]);

  const tenants = tenantSeeds.map((tenant) => ({
    ...tenant,
    usedSeats: items.filter((item) => item.tenantId === tenant.id).length,
  }));

  const metrics = [
    { label: "租户", value: tenantSeeds.length, note: `${tenants.filter((item) => item.status === "trial").length} 个试用中`, icon: Buildings },
    { label: "成员", value: items.length, note: `${items.filter((item) => item.status === "active").length} 人正常`, icon: UserCircle },
    { label: "席位占用", value: `${items.length} / ${tenants.reduce((sum, item) => sum + item.seats, 0)}`, note: "跨全部租户", icon: CheckCircle },
    { label: "待处理", value: items.filter((item) => item.status === "invited").length, note: "已邀请未接受", icon: EnvelopeSimple },
  ];

  function submitInvite() {
    const next: Record<string, string> = {};
    if (!invite.name.trim()) next.name = "请填写成员姓名";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invite.email.trim())) next.email = "请输入有效的邮箱地址";
    else if (items.some((item) => item.email.toLowerCase() === invite.email.trim().toLowerCase())) next.email = "该邮箱已在成员列表中";
    setErrors(next);
    if (Object.keys(next).length) return;

    create({
      name: invite.name.trim(),
      email: invite.email.trim(),
      role: invite.role,
      status: "invited",
      tenantId: invite.tenantId,
      lastActiveAt: null,
      joinedAt: new Date().toISOString(),
      approvals: 0,
      tasks: 0,
    });
    push(`已向 ${invite.email} 发送邀请`);
    setInviteOpen(false);
    setInvite({ name: "", email: "", role: "builder", tenantId: tenantSeeds[0].id, tenantWide: true });
  }

  const columns: Array<Column<Member>> = [
    {
      key: "name",
      header: "成员",
      sortValue: (row) => row.name,
      render: (row) => <span className="cell-title with-icon">
        <i className="avatar-badge">{row.name.slice(0, 1)}</i>
        <span><strong>{row.name}</strong><small>{row.email}</small></span>
      </span>,
    },
    {
      key: "role",
      header: "角色",
      sortValue: (row) => row.role,
      render: (row) => <SelectInput
        value={row.role}
        onChange={(value) => {
          update(row.id, { role: value });
          push(`已将 ${row.name} 的角色改为${roleLabels[value]}`);
        }}
        options={(Object.keys(roleLabels) as MemberRole[]).map((item) => ({ value: item, label: roleLabels[item] }))}
      />,
    },
    {
      key: "tenantId",
      header: "所属租户",
      secondary: true,
      sortValue: (row) => row.tenantId,
      render: (row) => tenantSeeds.find((item) => item.id === row.tenantId)?.name ?? row.tenantId,
    },
    {
      key: "status",
      header: "状态",
      sortValue: (row) => row.status,
      render: (row) => <Pill tone={statusMeta[row.status].tone}>{statusMeta[row.status].label}</Pill>,
    },
    {
      key: "lastActiveAt",
      header: "最近活跃",
      secondary: true,
      sortValue: (row) => row.lastActiveAt ?? "",
      render: (row) => <span className="cell-stack"><strong>{formatDateTime(row.lastActiveAt)}</strong><small>加入于 {formatDateTime(row.joinedAt)}</small></span>,
    },
    {
      key: "stats",
      header: "审批 / 任务",
      align: "right",
      secondary: true,
      sortValue: (row) => row.tasks,
      render: (row) => <span className="cell-stack right"><strong>{row.approvals} / {row.tasks}</strong><small>累计</small></span>,
    },
    {
      key: "actions",
      header: "操作",
      align: "right",
      render: (row) => <RowActions>
        <IconButton
          icon={row.status === "suspended" ? CheckCircle : Prohibit}
          label={row.status === "suspended" ? "恢复成员" : "停用成员"}
          onClick={() => {
            const next = row.status === "suspended" ? "active" : "suspended";
            update(row.id, { status: next });
            push(next === "active" ? `已恢复 ${row.name}` : `已停用 ${row.name}`);
          }}
        />
        <IconButton icon={Trash} label="移除成员" tone="danger" onClick={() => setPendingDelete(row)} />
      </RowActions>,
    },
  ];

  return <WorkspacePage
    active="tenants"
    note="工作区的组织边界：租户、席位与角色。角色决定成员能修改哪些配置、能否审批高风险动作，因此这里的改动会直接反映到运行中心的审批入口。"
    notice={notice}
    onDismissNotice={clear}
    actions={<>
      <button type="button" onClick={() => push("成员列表已刷新（示例数据）", "info")}><ArrowsClockwise />刷新</button>
      <button type="button" className="save action-btn" onClick={() => { setErrors({}); setInviteOpen(true); }}><UserPlus />邀请成员</button>
    </>}
  >
    <SampleBanner note="租户与成员尚未接入后端账号体系，角色与状态保存在浏览器本地存储中。" />

    <StatStrip items={metrics} />

    <Card
      icon={Buildings}
      title="租户"
      note="点击卡片筛选该租户的成员"
      action={<SelectInput
        value={tenantId}
        onChange={setTenantId}
        options={[{ value: "all", label: "全部租户" }, ...tenantSeeds.map((item) => ({ value: item.id, label: item.name }))]}
      />}
    >
      <div className="tenant-grid">
        {tenants.map((tenant) => <article key={tenant.id} className={`tenant-card ${tenantId === tenant.id ? "active" : ""}`}>
          <button type="button" onClick={() => setTenantId(tenantId === tenant.id ? "all" : tenant.id)}>
            <header>
              <span className="tenant-mark"><Buildings weight="duotone" /></span>
              <div><strong>{tenant.name}</strong><small>{tenant.region} · 创建于 {formatDateTime(tenant.createdAt)}</small></div>
              <Pill tone={tenant.status === "trial" ? "warn" : "ok"}>{planLabels[tenant.plan]}</Pill>
            </header>
            <div className="tenant-seats">
              <span>席位 {tenant.usedSeats} / {tenant.seats}</span>
              <ProgressMeter value={tenant.usedSeats} max={tenant.seats} tone={tenant.usedSeats >= tenant.seats ? "danger" : "ok"} compact />
            </div>
          </button>
        </article>)}
      </div>
    </Card>

    <Card
      icon={UserCircle}
      title="成员列表"
      note="角色可直接在行内调整，变更会立即生效"
      count={filtered.length}
      toolbar={<Toolbar>
        <SearchField value={query} onChange={setQuery} placeholder="搜索姓名或邮箱" />
        <div className="toolbar-filters">
          <SelectInput
            value={role}
            onChange={setRole}
            options={[{ value: "all", label: "全部角色" }, ...(Object.keys(roleLabels) as MemberRole[]).map((item) => ({ value: item, label: roleLabels[item] }))]}
          />
          <FilterChips<StatusFilter>
            value={status}
            onChange={setStatus}
            options={[
              { id: "all", label: "全部" },
              { id: "active", label: "正常" },
              { id: "invited", label: "待接受" },
              { id: "suspended", label: "已停用" },
            ]}
          />
        </div>
      </Toolbar>}
    >
      {!ready
        ? <LoadingState label="正在读取成员列表…" />
        : <DataTable<Member>
          columns={columns}
          rows={filtered}
          rowKey={(row) => row.id}
          pageSize={8}
          emptyTitle={items.length ? "没有匹配的成员" : "该工作区还没有成员"}
          emptyNote={items.length ? "试着清空搜索或更换筛选条件。" : "邀请第一位成员加入工作区。"}
          emptyAction={items.length
            ? <button type="button" className="ghost-action" onClick={() => { setQuery(""); setRole("all"); setStatus("all"); setTenantId("all"); }}>清除筛选</button>
            : <button type="button" className="primary-action action-btn" onClick={() => setInviteOpen(true)}><UserPlus />邀请成员</button>}
        />}
    </Card>

    <Card icon={CheckCircle} title="角色权限矩阵" note="所有角色都必须遵守工具级权限与审计，矩阵只描述配置与审批范围">
      <div className="permission-grid">
        {rolePermissions.map((entry) => <article key={entry.role}>
          <header><strong>{roleLabels[entry.role]}</strong><Pill tone="neutral">{items.filter((item) => item.role === entry.role).length} 人</Pill></header>
          <ul>{entry.scopes.map((scope) => <li key={scope}><CheckCircle weight="fill" />{scope}</li>)}</ul>
        </article>)}
      </div>
    </Card>

    <Modal
      open={inviteOpen}
      onClose={() => setInviteOpen(false)}
      title="邀请成员"
      description="被邀请人会收到一封邮件，接受后按所选角色加入。"
      footer={<>
        <button type="button" className="ghost-action" onClick={() => setInviteOpen(false)}>取消</button>
        <button type="button" className="primary-action action-btn" onClick={submitInvite}>发送邀请</button>
      </>}
    >
      <FormGrid>
        <Field label="姓名" required error={errors.name}>
          <TextInput value={invite.name} onChange={(value) => setInvite((current) => ({ ...current, name: value }))} placeholder="例如：徐汀" invalid={Boolean(errors.name)} />
        </Field>
        <Field label="邮箱" required error={errors.email}>
          <TextInput value={invite.email} onChange={(value) => setInvite((current) => ({ ...current, email: value }))} placeholder="name@example.com" invalid={Boolean(errors.email)} />
        </Field>
        <Field label="角色" hint={rolePermissions.find((item) => item.role === invite.role)?.scopes.join("、")}>
          <SelectInput
            value={invite.role}
            onChange={(value) => setInvite((current) => ({ ...current, role: value }))}
            options={(Object.keys(roleLabels) as MemberRole[]).map((item) => ({ value: item, label: roleLabels[item] }))}
          />
        </Field>
        <Field label="所属租户">
          <SelectInput
            value={invite.tenantId}
            onChange={(value) => setInvite((current) => ({ ...current, tenantId: value }))}
            options={tenantSeeds.map((item) => ({ value: item.id, label: item.name }))}
          />
        </Field>
      </FormGrid>
      <SwitchRow
        title="同时授予工作区默认配置的查看权限"
        note="仅影响只读范围，不会授予审批权"
        checked={invite.tenantWide}
        onChange={(value) => setInvite((current) => ({ ...current, tenantWide: value }))}
      />
    </Modal>

    <ConfirmDialog
      open={Boolean(pendingDelete)}
      title="移除成员"
      message={pendingDelete ? `${pendingDelete.name}（${pendingDelete.email}）将失去该工作区的全部访问权限。` : ""}
      confirmLabel="确认移除"
      onConfirm={() => {
        if (!pendingDelete) return;
        remove(pendingDelete.id);
        push(`已移除 ${pendingDelete.name}`);
      }}
      onClose={() => setPendingDelete(null)}
    />
  </WorkspacePage>;
}
