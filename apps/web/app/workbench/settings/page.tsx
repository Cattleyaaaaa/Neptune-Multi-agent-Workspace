"use client";

import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Copy } from "@phosphor-icons/react/dist/csr/Copy";
import { DesktopTower } from "@phosphor-icons/react/dist/csr/DesktopTower";
import { Eye } from "@phosphor-icons/react/dist/csr/Eye";
import { GearSix } from "@phosphor-icons/react/dist/csr/GearSix";
import { Key } from "@phosphor-icons/react/dist/csr/Key";
import { Lock } from "@phosphor-icons/react/dist/csr/Lock";
import { ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { SignOut } from "@phosphor-icons/react/dist/csr/SignOut";
import { UserCircle } from "@phosphor-icons/react/dist/csr/UserCircle";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { useCallback, useEffect, useState } from "react";
import { WorkspacePage } from "../ui/shell";
import { Card, ConfirmDialog, EmptyState, Field, FilterChips, FormGrid, KeyValueList, LoadingState, Modal, Pill, SampleBanner, SegmentedControl, SelectInput, StatStrip, SwitchRow, TextInput, Toolbar, useNotice } from "../ui/primitives";
import { DataTable, IconButton, RowActions, type Column } from "../ui/table";
import { useCollection, useRecord } from "../ui/store";
import { apiKeySeeds, defaultProfile, formatDateTime, type AccountProfile } from "../ui/data";
import { useAuth } from "../../auth/provider";
import { apiFetch, apiUrl, toErrorMessage } from "../../auth/api";
import { clearCache } from "../resource-cache";

type Section = "profile" | "defaults" | "notify" | "security" | "keys";

type ApiKey = (typeof apiKeySeeds)[number];

/* 真实会话：每条对应数据库里一个刷新令牌。 */
type AuthSession = {
  session_id: string;
  user_agent: string;
  client_ip: string;
  issued_at: string;
  expires_at: string;
  current: boolean;
};

/* 只是把 User-Agent 归个类，方便"认不认得这台设备"——不是指纹识别。 */
function deviceLabel(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  if (!ua) return "未知客户端";
  if (ua.includes("edg/")) return "Microsoft Edge";
  if (ua.includes("chrome/")) return "Chrome";
  if (ua.includes("firefox/")) return "Firefox";
  if (ua.includes("safari/")) return "Safari";
  if (ua.includes("python") || ua.includes("curl") || ua.includes("httpx")) return "脚本客户端";
  return "其它浏览器";
}

function formatExpiry(value: string): string {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "—";
  const minutes = Math.round((at - Date.now()) / 60_000);
  if (minutes <= 0) return "已过期";
  if (minutes < 60) return `${minutes} 分钟后`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} 小时后`;
  return `${Math.round(minutes / (60 * 24))} 天后`;
}

const sectionLabels: Array<{ id: Section; label: string }> = [
  { id: "profile", label: "个人资料" },
  { id: "defaults", label: "工作台默认值" },
  { id: "notify", label: "通知" },
  { id: "security", label: "安全" },
  { id: "keys", label: "API 密钥" },
];

const digestLabels: Record<AccountProfile["digest"], string> = {
  off: "不发送",
  daily: "每日摘要",
  weekly: "每周摘要",
};

/* 账号设置: 个人层面的偏好与凭据。这里的默认值只影响「新建任务」时的初始状态，
   不会覆盖已经创建的任务，因此可以放心调整。 */
export default function SettingsPage() {
  const { value: profile, patch, reset, ready } = useRecord<AccountProfile>("account-profile", defaultProfile);
  const keys = useCollection<ApiKey>("api-keys", apiKeySeeds);
  const { notice, push, clear } = useNotice();
  const { user, status: authStatus, accessExpiresAt, refreshExpiresAt } = useAuth();

  const [section, setSection] = useState<Section>("profile");
  const [saved, setSaved] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [keyFilter, setKeyFilter] = useState<"all" | "active" | "expired">("all");
  const [newKeyOpen, setNewKeyOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyScope, setNewKeyScope] = useState("read");
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<ApiKey | null>(null);
  const [pendingSignOut, setPendingSignOut] = useState<AuthSession | null>(null);

  // --- 安全：修改密码 + 真实活跃会话 -----------------------------------
  const [pwd, setPwd] = useState({ current: "", next: "", confirm: "" });
  const [pwdErrors, setPwdErrors] = useState<Record<string, string>>({});
  const [changing, setChanging] = useState(false);
  const [authSessions, setAuthSessions] = useState<AuthSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState("");

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const response = await apiFetch(apiUrl("/api/auth/sessions"));
      if (!response.ok) throw new Error();
      const data = (await response.json()) as { sessions: AuthSession[] };
      setAuthSessions(data.sessions);
      setSessionsError("");
    } catch {
      setSessionsError("无法读取活跃会话，请确认后端已启动。");
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  async function submitPassword() {
    const next: Record<string, string> = {};
    if (!pwd.current) next.current = "请输入当前密码";
    if (pwd.next.length < 8) next.next = "新密码至少 8 位";
    if (pwd.next !== pwd.confirm) next.confirm = "两次输入的新密码不一致";
    setPwdErrors(next);
    if (Object.keys(next).length) return;

    setChanging(true);
    try {
      const response = await apiFetch(apiUrl("/api/auth/change-password"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: pwd.current, new_password: pwd.next }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        // 422 的 detail 是对象数组，不能直接当字符串渲染
        setPwdErrors({ current: toErrorMessage(payload, "修改失败，请稍后重试") });
        return;
      }
      // 后端会吊销全部会话（含当前这条），所以这里没有"继续保持登录"的选项。
      clearCache();
      window.location.assign("/login?changed=1");
    } catch {
      setPwdErrors({ current: "无法连接后端服务，请确认 API 已启动" });
    } finally {
      setChanging(false);
    }
  }

  async function revokeSession(session: AuthSession) {
    try {
      const response = await apiFetch(apiUrl(`/api/auth/sessions/${session.session_id}`), {
        method: "DELETE",
      });
      if (!response.ok) throw new Error();
      if (session.current) {
        // 注销的是自己：后端已清 cookie，直接回登录页。
        clearCache();
        window.location.assign("/login");
        return;
      }
      push(`已注销 ${deviceLabel(session.user_agent)}`);
      await loadSessions();
    } catch {
      push("注销失败，请稍后重试", "error");
    }
  }

  function change(next: Partial<AccountProfile>) {
    patch(next);
    setSaved(false);
  }

  function save() {
    const next: Record<string, string> = {};
    if (!profile.displayName.trim()) next.displayName = "称呼不能为空";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email.trim())) next.email = "请输入有效的邮箱地址";
    setErrors(next);
    if (Object.keys(next).length) {
      push("请先修正表单中的错误", "error");
      return;
    }
    setSaved(true);
    push("账号设置已保存到本地");
  }

  const visibleKeys = keys.items.filter((item) => {
    const expired = new Date(item.expiresAt).getTime() < new Date("2026-09-18T17:00:00+08:00").getTime();
    if (keyFilter === "expired" && !expired) return false;
    if (keyFilter === "active" && expired) return false;
    if (search.trim() && !item.name.toLowerCase().includes(search.trim().toLowerCase()) && !item.prefix.includes(search.trim())) return false;
    return true;
  });

  const keyColumns: Array<Column<ApiKey>> = [
    {
      key: "name",
      header: "密钥",
      sortValue: (row) => row.name,
      render: (row) => <span className="cell-title"><strong>{row.name}</strong><small className="mono">{row.prefix}••••••••</small></span>,
    },
    {
      key: "scopes",
      header: "权限范围",
      render: (row) => <span className="chip-list">{row.scopes.map((scope) => <b key={scope}>{scope}</b>)}</span>,
    },
    {
      key: "createdAt",
      header: "创建时间",
      secondary: true,
      sortValue: (row) => row.createdAt,
      render: (row) => formatDateTime(row.createdAt),
    },
    {
      key: "lastUsedAt",
      header: "最近使用",
      secondary: true,
      sortValue: (row) => row.lastUsedAt ?? "",
      render: (row) => formatDateTime(row.lastUsedAt),
    },
    {
      key: "expiresAt",
      header: "到期",
      sortValue: (row) => row.expiresAt,
      render: (row) => {
        const expired = new Date(row.expiresAt).getTime() < new Date("2026-09-18T17:00:00+08:00").getTime();
        return <span className="cell-stack">
          <strong>{formatDateTime(row.expiresAt)}</strong>
          <Pill tone={expired ? "danger" : "ok"}>{expired ? "已过期" : "有效"}</Pill>
        </span>;
      },
    },
    {
      key: "actions",
      header: "操作",
      align: "right",
      render: (row) => <RowActions>
        <IconButton icon={Copy} label="复制前缀" onClick={() => push(`已复制 ${row.prefix}`, "info")} />
        <IconButton icon={SignOut} label="吊销密钥" tone="danger" onClick={() => setPendingRevoke(row)} />
      </RowActions>,
    },
  ];

  return <WorkspacePage
    active="settings"
    note="个人层面的偏好与凭据：显示名称、默认运行模式、通知策略、登录安全与 API 密钥。"
    notice={notice}
    onDismissNotice={clear}
    actions={<>
      <button type="button" onClick={() => { reset(); setSaved(true); push("已恢复默认设置", "info"); }}><ArrowsClockwise />恢复默认</button>
      <button type="button" className="save action-btn" disabled={saved} onClick={save}>
        <CheckCircle weight="fill" />{saved ? "已保存" : "保存更改"}
      </button>
    </>}
  >
    <SampleBanner note="个人资料、通知策略与 API 密钥仍是本地示例数据；「安全」一节（修改密码、活跃会话）已接入后端账号体系，改动会真正影响登录状态。" />

    <StatStrip items={[
      { label: "显示名称", value: profile.displayName || "未设置", note: profile.jobTitle || "未填写职务", icon: UserCircle },
      { label: "默认运行模式", value: profile.defaultExecutionMode === "auto" ? "自动执行" : "仅生成计划", note: "新建任务时的初始值", icon: GearSix },
      { label: "通知渠道", value: [profile.notifyEmail && "邮件", profile.notifyInApp && "站内"].filter(Boolean).join(" + ") || "未开启", note: digestLabels[profile.digest], icon: Warning },
      { label: "活跃会话", value: sessionsLoading ? "…" : authSessions.length, note: sessionsError ? "读取失败" : "每个对应一个刷新令牌", icon: Lock },
    ]} />

    <Toolbar>
      <SegmentedControl<Section> value={section} onChange={setSection} options={sectionLabels} />
      {!ready && <span className="toolbar-hint">正在读取本地设置…</span>}
    </Toolbar>

    {section === "profile" && <Card icon={UserCircle} title="个人资料" note="这些信息会出现在审批记录与审计日志中">
      <FormGrid>
        <Field label="显示名称" required error={errors.displayName}>
          <TextInput value={profile.displayName} onChange={(value) => change({ displayName: value })} invalid={Boolean(errors.displayName)} />
        </Field>
        <Field label="邮箱" required error={errors.email} hint="用于接收审批与异常通知">
          <TextInput value={profile.email} onChange={(value) => change({ email: value })} invalid={Boolean(errors.email)} />
        </Field>
        <Field label="职务">
          <TextInput value={profile.jobTitle} onChange={(value) => change({ jobTitle: value })} placeholder="例如：工作台负责人" />
        </Field>
        <Field label="部门">
          <TextInput value={profile.department} onChange={(value) => change({ department: value })} placeholder="例如：智能应用组" />
        </Field>
        <Field label="时区" hint="影响定时任务与审计时间显示">
          <SelectInput
            value={profile.timezone}
            onChange={(value) => change({ timezone: value })}
            options={[
              { value: "Asia/Shanghai", label: "Asia/Shanghai (UTC+8)" },
              { value: "UTC", label: "UTC" },
              { value: "Asia/Tokyo", label: "Asia/Tokyo (UTC+9)" },
            ]}
          />
        </Field>
        <Field label="界面语言">
          <SelectInput
            value={profile.language}
            onChange={(value) => change({ language: value })}
            options={[
              { value: "zh-CN", label: "简体中文" },
              { value: "en-US", label: "English (US)" },
            ]}
          />
        </Field>
      </FormGrid>
    </Card>}

    {section === "defaults" && <Card icon={GearSix} title="工作台默认值" note="只影响新建任务时的初始状态，不会改动已创建的任务">
      <FormGrid columns={2}>
        <Field label="默认运行模式" hint="可在运行中心随时临时切换">
          <SegmentedControl
            value={profile.defaultExecutionMode}
            onChange={(value) => change({ defaultExecutionMode: value })}
            options={[{ id: "auto", label: "自动执行" }, { id: "plan_only", label: "仅生成计划" }]}
          />
        </Field>
        <Field label="界面主题" hint="当前版本固定为浅色主题">
          <SelectInput
            value={profile.theme}
            onChange={(value) => change({ theme: value })}
            options={[
              { value: "system", label: "跟随系统" },
              { value: "light", label: "浅色" },
              { value: "dark", label: "深色" },
            ]}
          />
        </Field>
      </FormGrid>
      <SwitchRow
        title="新建任务时提示风险等级"
        note="在提交前展示识别到的任务类型与风险等级，便于确认"
        checked={profile.defaultRiskNotice}
        onChange={(value) => change({ defaultRiskNotice: value })}
      />
    </Card>}

    {section === "notify" && <Card icon={Warning} title="通知策略" note="通知仅在本地记录，接入后端后会通过邮件或站内消息推送">
      <SwitchRow
        title="邮件通知"
        note={`发送到 ${profile.email}`}
        checked={profile.notifyEmail}
        onChange={(value) => change({ notifyEmail: value })}
      />
      <SwitchRow
        title="站内通知"
        note="在工作台顶部显示未读提示"
        checked={profile.notifyInApp}
        onChange={(value) => change({ notifyInApp: value })}
      />
      <SwitchRow
        title="审批请求即时提醒"
        note="有任务暂停等待人工审批时立刻通知"
        checked={profile.notifyOnApproval}
        onChange={(value) => change({ notifyOnApproval: value })}
      />
      <FormGrid columns={1}>
        <Field label="摘要频率" hint="汇总任务运行、失败与用量情况">
          <SelectInput
            value={profile.digest}
            onChange={(value) => change({ digest: value })}
            options={[
              { value: "off", label: "不发送摘要" },
              { value: "daily", label: "每日摘要（09:00）" },
              { value: "weekly", label: "每周摘要（周一 09:00）" },
            ]}
          />
        </Field>
      </FormGrid>
    </Card>}

    {section === "security" && <>
      <Card icon={Lock} title="修改密码" note={`当前账号：${user?.username ?? "—"}。密码以 PBKDF2 加盐哈希存储，不保存明文`}>
        <FormGrid columns={1}>
          <Field label="当前密码" required error={pwdErrors.current}>
            <TextInput
              type="password"
              autoComplete="current-password"
              value={pwd.current}
              onChange={(value) => setPwd((state) => ({ ...state, current: value }))}
              invalid={Boolean(pwdErrors.current)}
            />
          </Field>
          <Field label="新密码" required error={pwdErrors.next} hint="至少 8 位，建议混合大小写与符号">
            <TextInput
              type="password"
              autoComplete="new-password"
              value={pwd.next}
              onChange={(value) => setPwd((state) => ({ ...state, next: value }))}
              invalid={Boolean(pwdErrors.next)}
            />
          </Field>
          <Field label="确认新密码" required error={pwdErrors.confirm}>
            <TextInput
              type="password"
              autoComplete="new-password"
              value={pwd.confirm}
              onChange={(value) => setPwd((state) => ({ ...state, confirm: value }))}
              invalid={Boolean(pwdErrors.confirm)}
            />
          </Field>
        </FormGrid>
        <p className="detail-note">
          <Warning />
          改密码会吊销该账号的全部刷新令牌（含当前这条），所有设备都需要用新密码重新登录——这是为了在凭据可能泄露时能立刻止损。
        </p>
        <button type="button" className="primary-action action-btn" disabled={changing} onClick={() => void submitPassword()}>
          <Key weight="fill" />{changing ? "正在提交…" : "修改密码"}
        </button>
      </Card>

      <Card icon={ShieldCheck} title="当前会话有效期" note="双令牌：访问令牌短时效、无状态校验；刷新令牌长时效、可吊销且每次刷新都会轮换">
        <KeyValueList rows={[
          {
            label: "访问令牌到期",
            value: authStatus === "authenticated" ? formatExpiry(accessExpiresAt) : "—",
          },
          {
            label: "刷新令牌到期",
            value: authStatus === "authenticated" ? formatExpiry(refreshExpiresAt) : "—",
          },
          {
            label: "续期方式",
            value: "访问令牌到期前 90 秒由前端静默续期，不打断使用",
          },
        ]} />
      </Card>

      <Card icon={DesktopTower} title="活跃会话" note="每条对应数据库里的一个刷新令牌；发现不认识的设备请立即注销" count={sessionsLoading ? undefined : authSessions.length}>
        {sessionsError && <p className="detail-note"><Warning />{sessionsError}</p>}
        {sessionsLoading
          ? <LoadingState label="正在读取活跃会话…" />
          : authSessions.length === 0
            ? <EmptyState title="没有活跃会话" note="当前登录状态可能已经失效，请重新登录。" />
            : <ul className="session-list">
              {authSessions.map((item) => <li key={item.session_id}>
                <span className="session-icon"><DesktopTower weight="duotone" /></span>
                <div>
                  <strong>{deviceLabel(item.user_agent)}{item.current && <Pill tone="ok">当前设备</Pill>}</strong>
                  <small>{item.client_ip || "内网地址"} · 签发于 {formatDateTime(item.issued_at)} · {formatExpiry(item.expires_at)}到期</small>
                </div>
                {item.current
                  ? <Pill tone="info">正在使用</Pill>
                  : <button type="button" className="ghost-action" onClick={() => setPendingSignOut(item)}><SignOut />注销</button>}
              </li>)}
            </ul>}
      </Card>
    </>}

    {section === "keys" && <Card
      icon={Key}
      title="API 密钥"
      note="用于在 CI 或脚本中调用工作台接口；密钥只显示一次，请妥善保存"
      count={visibleKeys.length}
      action={<button type="button" className="small-action action-btn" onClick={() => { setNewKeyName(""); setNewKeyScope("read"); setCreatedSecret(null); setNewKeyOpen(true); }}><Key />新建密钥</button>}
      toolbar={<Toolbar>
        <label className="task-search">
          <Eye />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索密钥名称或前缀" />
        </label>
        <FilterChips<"all" | "active" | "expired">
          value={keyFilter}
          onChange={setKeyFilter}
          options={[
            { id: "all", label: "全部" },
            { id: "active", label: "有效" },
            { id: "expired", label: "已过期" },
          ]}
        />
      </Toolbar>}
    >
      <DataTable<ApiKey>
        columns={keyColumns}
        rows={visibleKeys}
        rowKey={(row) => row.id}
        pageSize={6}
        emptyTitle={keys.items.length ? "没有匹配的密钥" : "还没有创建 API 密钥"}
        emptyNote={keys.items.length ? "试试更换筛选条件。" : "创建密钥以便在自动化流程中调用工作台接口。"}
      />
    </Card>}

    <Modal
      open={newKeyOpen}
      onClose={() => setNewKeyOpen(false)}
      title={createdSecret ? "密钥已创建" : "新建 API 密钥"}
      description={createdSecret ? "请立即复制并妥善保存，关闭后将无法再次查看完整密钥。" : "密钥的权限范围遵循最小授权原则，建议只勾选必要的读权限。"}
      footer={createdSecret
        ? <>
          <button type="button" className="ghost-action" onClick={() => setNewKeyOpen(false)}>我已保存</button>
          <button type="button" className="primary-action action-btn" onClick={() => push("密钥已复制到剪贴板", "info")}><Copy />复制密钥</button>
        </>
        : <>
          <button type="button" className="ghost-action" onClick={() => setNewKeyOpen(false)}>取消</button>
          <button type="button" className="primary-action action-btn" onClick={() => {
            if (!newKeyName.trim()) { push("请填写密钥用途名称", "error"); return; }
            const prefix = `nx_live_${Math.random().toString(36).slice(2, 6)}`;
            keys.create({
              name: newKeyName.trim(),
              prefix,
              scopes: newKeyScope === "read" ? ["tasks:read", "audit:read"] : ["tasks:read", "tasks:write", "audit:read"],
              createdAt: new Date().toISOString(),
              lastUsedAt: null,
              expiresAt: "2027-09-18T00:00:00+08:00",
            });
            setCreatedSecret(`${prefix}_${Math.random().toString(36).slice(2, 14)}${Math.random().toString(36).slice(2, 14)}`);
            push(`已创建密钥「${newKeyName}」`);
          }}>生成密钥</button>
        </>}
    >
      {createdSecret
        ? <div className="secret-block">
          <code>{createdSecret}</code>
          <p className="detail-note"><Warning /> 该密钥拥有 {newKeyScope === "read" ? "只读" : "读写"} 权限，请勿提交到代码仓库。</p>
        </div>
        : <>
          <Field label="用途名称" required hint="建议写明调用方，便于日后审计与吊销">
            <TextInput value={newKeyName} onChange={setNewKeyName} placeholder="例如：报表导出脚本" />
          </Field>
          <Field label="权限范围" hint="只读密钥无法发起任务或修改配置">
            <SegmentedControl
              value={newKeyScope}
              onChange={setNewKeyScope}
              options={[{ id: "read", label: "只读" }, { id: "write", label: "读写" }]}
            />
          </Field>
        </>}
    </Modal>

    <ConfirmDialog
      open={Boolean(pendingRevoke)}
      title="吊销 API 密钥"
      message={pendingRevoke ? `「${pendingRevoke.name}」将立即失效，使用该密钥的调用会返回 401。` : ""}
      confirmLabel="确认吊销"
      onConfirm={() => {
        if (!pendingRevoke) return;
        keys.remove(pendingRevoke.id);
        push(`已吊销密钥「${pendingRevoke.name}」`);
      }}
      onClose={() => setPendingRevoke(null)}
    />

    <ConfirmDialog
      open={Boolean(pendingSignOut)}
      title="注销会话"
      message={pendingSignOut ? `${deviceLabel(pendingSignOut.user_agent)}（${pendingSignOut.client_ip || "内网地址"}）将立即失效，需要重新登录。` : ""}
      confirmLabel="确认注销"
      onConfirm={() => {
        if (pendingSignOut) void revokeSession(pendingSignOut);
      }}
      onClose={() => setPendingSignOut(null)}
    />

    <p className="page-note">扩展点：接入 SSO / OIDC、给账号加角色级授权（当前 <code>role</code> 字段已入库但尚未用于页面级控制），以及把登录与改密事件写入运行审计。</p>
  </WorkspacePage>;
}
