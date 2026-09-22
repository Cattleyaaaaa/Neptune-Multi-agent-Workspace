"use client";

import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Eye } from "@phosphor-icons/react/dist/csr/Eye";
import { EyeSlash } from "@phosphor-icons/react/dist/csr/EyeSlash";
import { ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { Sparkle } from "@phosphor-icons/react/dist/csr/Sparkle";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { useEffect, useState } from "react";
import { apiUrl, toErrorMessage } from "../auth/api";
import "../workspace-layout.css";

type Mode = "login" | "register";
type Phase = "idle" | "submitting";

/* 只接受站内路径：挡掉 /login?next=https://evil.example 这种开放重定向。 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/workbench/runtime";
  return raw;
}

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;

/* 左侧展示的是运行时固定链路，不是实时数据——所以只标节点职责，
   不摆"connected/standby"这类由假状态驱动的灯。审批门禁是高风险任务才插入的一环。 */
const PIPELINE = [
  { step: "01", name: "受理", note: "识别任务与风险", gate: false },
  { step: "02", name: "编排", note: "按能力挑 Agent", gate: false },
  { step: "03", name: "执行", note: "专职 Agent 协作", gate: false },
  { step: "04", name: "审批", note: "仅高风险任务", gate: true },
  { step: "05", name: "交付", note: "留痕并导出", gate: false },
];

const PILLARS = [
  { step: "01", title: "多 Agent 动态组队", note: "从能力注册表按任务类型挑人，注册表之外的不会被派工" },
  { step: "02", title: "高风险人工审批", note: "删除、外发这类动作先停下来等你确认，批准后才执行并回查" },
  { step: "03", title: "全链路可追溯", note: "工具调用与 Agent 交接全部留痕，可回放、可导出" },
];

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>("login");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reveal, setReveal] = useState(false);
  const [next, setNext] = useState("/workbench/runtime");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);

  const [signUpName, setSignUpName] = useState("");
  const [signUpPassword, setSignUpPassword] = useState("");
  const [signUpConfirm, setSignUpConfirm] = useState("");
  const [signUpDisplay, setSignUpDisplay] = useState("");
  const [signUpErrors, setSignUpErrors] = useState<Record<string, string>>({});

  // 用 window.location 而不是 useSearchParams：后者需要 Suspense 包裹才能构建。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNext(safeNext(params.get("next")));
    if (params.get("changed") === "1") setNotice("密码已修改，所有设备都已注销。请用新密码重新登录。");
  }, []);

  async function post(path: string, body: Record<string, unknown>) {
    setPhase("submitting");
    setError("");
    setNotice("");
    try {
      const response = await fetch(apiUrl(path), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(toErrorMessage(payload, "请求失败，请稍后重试。"));
        setPhase("idle");
        return false;
      }
      return true;
    } catch {
      setError("无法连接后端服务，请确认 API 已启动。");
      setPhase("idle");
      return false;
    }
  }

  async function submitLogin(event: React.FormEvent) {
    event.preventDefault();
    if (phase === "submitting") return;
    // 表单加了 noValidate（浏览器原生的英文提示体验差），所以空值在这里拦。
    if (!username.trim() || !password) {
      setError("请输入用户名和密码。");
      return;
    }
    if (await post("/api/auth/login", { username: username.trim(), password, remember })) {
      setNotice("登录成功，正在进入工作台…");
      window.location.assign(next);
    }
  }

  function validateSignUp(): boolean {
    const problems: Record<string, string> = {};
    if (!USERNAME_PATTERN.test(signUpName.trim())) {
      problems.username = "3–32 位，只能用字母、数字、点、下划线和连字符";
    }
    if (signUpPassword.length < 8) problems.password = "至少 8 位";
    if (signUpPassword !== signUpConfirm) problems.confirm = "两次输入的密码不一致";
    setSignUpErrors(problems);
    return Object.keys(problems).length === 0;
  }

  async function submitRegister(event: React.FormEvent) {
    event.preventDefault();
    if (phase === "submitting") return;
    if (!validateSignUp()) return;
    const ok = await post("/api/auth/register", {
      username: signUpName.trim(),
      password: signUpPassword,
      display_name: signUpDisplay.trim() || null,
    });
    if (ok) {
      setNotice("注册成功，正在进入工作台…");
      window.location.assign(next);
    }
  }

  function switchMode(target: Mode) {
    setMode(target);
    setError("");
    setNotice("");
    setSignUpErrors({});
  }

  return <main className="login-shell">
    <section className="login-intro">
      <header className="login-brand">
        <span className="login-mark"><Sparkle weight="fill" /></span>
        <div><strong>Nexus</strong><small>AGENT CONTROL PLANE</small></div>
      </header>

      <div className="login-hero">
        <p className="login-kicker">GENERAL AGENT CONTROL PLANE</p>
        <h1 className="login-title">让 Agent 自己组队，<br />每一步都有据可查。</h1>
        <p className="login-tagline">
          在一个可控工作台里调度研究、数据、软件、文档与审查 Agent。
          高风险动作停在审批门禁，每次运行都留下可追溯的链路与工具记录。
        </p>
      </div>

      <div className="login-pipeline">
        <div className="pipeline-head">
          <i />
          <span>SUPERVISOR PIPELINE</span>
          <em>固定链路</em>
        </div>
        <div className="pipeline-track">
          {PIPELINE.map((node, index) => <div className="pipeline-cell" key={node.step}>
            <div className={`pipeline-node${node.gate ? " gate" : ""}`}>
              <b>{node.step}</b>
              <strong>{node.name}</strong>
              <small>{node.note}</small>
            </div>
            {index < PIPELINE.length - 1 && <span className="pipeline-link" aria-hidden="true" />}
          </div>)}
        </div>
        <p className="pipeline-foot">tool_trace · agent_trace · 审批记录 — 每次运行都可回放</p>
      </div>

      <div className="login-pillars">
        {PILLARS.map((pillar) => <div className="pillar" key={pillar.step}>
          <b>{pillar.step}</b>
          <strong>{pillar.title}</strong>
          <small>{pillar.note}</small>
        </div>)}
      </div>
    </section>

    <section className="login-side">
      <div className="login-card">
        <p className="login-kicker-side">{mode === "login" ? "WELCOME BACK" : "GET STARTED"}</p>
        <h2 className="login-heading">{mode === "login" ? "登录控制台" : "注册控制台"}</h2>
        <p className="login-lead">
          {mode === "login"
            ? "进入你的工作区，继续管理运行中的 Agent 任务。"
            : "创建一个成员账号，注册成功后直接进入工作区。"}
        </p>

        {mode === "login" ? <form onSubmit={(event) => void submitLogin(event)} noValidate>
          <label className="login-field">
            <span>用户名</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              placeholder="admin"
              required
            />
          </label>

          <label className="login-field">
            <span>密码</span>
            <span className="login-input">
              <input
                type={reveal ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                placeholder="请输入密码"
                required
              />
              <button
                type="button"
                className="login-reveal"
                aria-label={reveal ? "隐藏密码" : "显示密码"}
                onClick={() => setReveal((value) => !value)}
              >{reveal ? <EyeSlash /> : <Eye />}</button>
            </span>
          </label>

          <label className="login-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <span>记住我<small>刷新令牌 14 天，不勾选 1 天</small></span>
          </label>

          {error && <p className="login-error" role="alert"><Warning />{error}</p>}
          {notice && <p className="login-notice" role="status"><CheckCircle weight="fill" />{notice}</p>}

          <button type="submit" className="login-submit" disabled={phase === "submitting"}>
            {phase === "submitting" ? "正在进入…" : "进入工作台"}
          </button>

          <p className="login-switch">
            还没有账号？<button type="button" onClick={() => switchMode("register")}>创建用户和密码</button>
          </p>
        </form> : <form onSubmit={(event) => void submitRegister(event)} noValidate>
          <label className="login-field">
            <span>用户名</span>
            <input
              value={signUpName}
              onChange={(event) => setSignUpName(event.target.value)}
              autoComplete="username"
              placeholder="zhang.wei"
              required
            />
            {signUpErrors.username
              ? <em className="login-field-error">{signUpErrors.username}</em>
              : <em className="login-field-hint">3–32 位，字母 / 数字 / 点 / 下划线 / 连字符</em>}
          </label>

          <label className="login-field">
            <span>显示名称<small>（可选）</small></span>
            <input
              value={signUpDisplay}
              onChange={(event) => setSignUpDisplay(event.target.value)}
              placeholder="张维"
            />
          </label>

          <label className="login-field">
            <span>密码</span>
            <span className="login-input">
              <input
                type={reveal ? "text" : "password"}
                value={signUpPassword}
                onChange={(event) => setSignUpPassword(event.target.value)}
                autoComplete="new-password"
                placeholder="至少 8 位"
                required
              />
              <button
                type="button"
                className="login-reveal"
                aria-label={reveal ? "隐藏密码" : "显示密码"}
                onClick={() => setReveal((value) => !value)}
              >{reveal ? <EyeSlash /> : <Eye />}</button>
            </span>
            {signUpErrors.password && <em className="login-field-error">{signUpErrors.password}</em>}
          </label>

          <label className="login-field">
            <span>确认密码</span>
            <input
              type="password"
              value={signUpConfirm}
              onChange={(event) => setSignUpConfirm(event.target.value)}
              autoComplete="new-password"
              placeholder="再输入一次"
              required
            />
            {signUpErrors.confirm && <em className="login-field-error">{signUpErrors.confirm}</em>}
          </label>

          {error && <p className="login-error" role="alert"><Warning />{error}</p>}
          {notice && <p className="login-notice" role="status"><CheckCircle weight="fill" />{notice}</p>}

          <button type="submit" className="login-submit" disabled={phase === "submitting"}>
            {phase === "submitting" ? "正在创建…" : "创建并进入"}
          </button>

          <p className="login-switch">
            已有账号？<button type="button" onClick={() => switchMode("login")}>返回登录</button>
          </p>
        </form>}

        <p className="login-meta">
          <ShieldCheck /> 访问令牌 30 分钟自动续期 · 密码以 PBKDF2 加盐哈希存储
        </p>
      </div>
    </section>
  </main>;
}
