"use client";

import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useEffect, useState } from "react";

/* The project runs one Supervisor-driven engine with two execution modes, so the
   reference's "engine picker" maps onto that real choice rather than inventing a
   second engine. The pick becomes the default 运行模式 for new sessions.

   示意图是动画的：节点依次出现、连线逐段画出、再有一个"调度包"沿链路循环，
   用来说明两种模式的差别（继续执行 vs 停在计划）。动画纯 CSS + SVG 原生
   animateMotion，不引第三方动效库。 */
export type Engine = "auto" | "plan_only";

const engines: Array<{ id: Engine; tag: string; name: string; desc: string; action: string }> = [
  {
    id: "auto",
    tag: "01 / SUPERVISOR",
    name: "自动执行",
    desc: "主 Agent 拆解目标、按能力注册表动态组队、逐步委派专业 Agent，质量审查后汇总结果；高风险动作会在执行前暂停，等待负责人批准。",
    action: "使用自动执行",
  },
  {
    id: "plan_only",
    tag: "02 / PLAN ONLY",
    name: "仅生成计划",
    desc: "只完成任务理解与规划：产出参与的专业 Agent 与执行步骤，不执行专业步骤。适合先把方案评审清楚，再决定是否执行。",
    action: "启用仅生成计划",
  },
];

export function EngineModal({
  open,
  value,
  onSelect,
  onEnter,
  onClose,
}: {
  open: boolean;
  value: Engine;
  onSelect: (engine: Engine) => void;
  onEnter: () => void;
  onClose: () => void;
}) {
  // 系统开了"减少动态效果"时不再播放示意图动画（SMIL 的运动圆点也一并去掉）。
  const [animate, setAnimate] = useState(true);
  useEffect(() => {
    setAnimate(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  if (!open) return null;
  return <div className="engine-modal" role="dialog" aria-modal="true" aria-label="选择运行模式">
    <div className="engine-dialog">
      <button type="button" className="engine-close" onClick={onClose} aria-label="关闭"><X /></button>
      <div className="engine-head">
        <p>运行时入口</p>
        <h2>选择你的运行模式</h2>
        <span>两种模式共享同一套能力注册表、工具鉴权与审计链路，区别只在是否继续执行专业步骤。选定后会作为新建会话的默认运行模式，随时可在顶部工具条切换。</span>
      </div>
      <div className="engine-cards">
        {engines.map((engine) => {
          const active = value === engine.id;
          return <article className={`engine-card ${active ? "selected" : ""}`} key={engine.id}>
            <small>{engine.tag}</small>
            <h3>{engine.name}</h3>
            <p>{engine.desc}</p>
            <EngineDiagram mode={engine.id} animate={animate} />
            <button type="button" className={active ? "primary" : "ghost"} onClick={() => onSelect(engine.id)}>
              {active ? <><Check weight="bold" />当前选择</> : engine.action}
            </button>
          </article>;
        })}
      </div>
      <div className="engine-foot">
        <span>每次进入运行中心都会展示这段说明，可直接关闭；无密钥也能运行，本地规则推理不会虚构外部事实。</span>
        <button type="button" className="primary" onClick={onEnter}>进入工作台</button>
      </div>
    </div>
  </div>;
}

/* 一个 4.6s 的循环：主 Agent → 专职 Agent → 汇总交付，节点依次出现、连线逐段画出。
   延迟写在元素上，所有动画共用同一个周期，因此整套动作会整齐地重复。 */
const CYCLE = 4.6;
function at(seconds: number): { animationDelay: string } {
  return { animationDelay: `${seconds}s` };
}

function EngineDiagram({ mode, animate }: { mode: Engine; animate: boolean }) {
  return <svg
    className={`engine-diagram${animate ? "" : " static"}`}
    viewBox="0 0 300 110"
    role="img"
    aria-label={mode === "auto" ? "主 Agent 调度专业 Agent 并汇总交付" : "只到计划产出即停止"}
  >
    <defs>
      <marker id="engine-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
        <path d="M2 1L8 5L2 9" fill="none" stroke="#9ab7a5" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </marker>
    </defs>

    {mode === "auto" ? <>
      <g className="engine-node" style={at(0)}>
        <rect x="108" y="6" width="84" height="22" rx="6" fill="#eaf1ec" stroke="#9ab7a5" strokeWidth="0.5" />
        <text x="150" y="17" textAnchor="middle" dominantBaseline="central" fontSize="10" fill="#1d2b23">主 Agent</text>
      </g>

      <path className="engine-wire" style={at(0.55)} d="M150 28 L58 44" fill="none" stroke="#9ab7a5" strokeWidth="1" markerEnd="url(#engine-arrow)" />
      <path className="engine-wire" style={at(0.65)} d="M150 28 L150 44" fill="none" stroke="#9ab7a5" strokeWidth="1" markerEnd="url(#engine-arrow)" />
      <path className="engine-wire" style={at(0.75)} d="M150 28 L242 44" fill="none" stroke="#9ab7a5" strokeWidth="1" markerEnd="url(#engine-arrow)" />

      <g className="engine-node" style={at(1)}>
        <rect x="20" y="46" width="76" height="22" rx="6" fill="#f6f8f6" stroke="#e0e6e1" strokeWidth="0.5" />
        <text x="58" y="57" textAnchor="middle" dominantBaseline="central" fontSize="10" fill="#5f7168">研究</text>
      </g>
      <g className="engine-node" style={at(1.12)}>
        <rect x="112" y="46" width="76" height="22" rx="6" fill="#f6f8f6" stroke="#e0e6e1" strokeWidth="0.5" />
        <text x="150" y="57" textAnchor="middle" dominantBaseline="central" fontSize="10" fill="#5f7168">数据 / 工程</text>
      </g>
      <g className="engine-node" style={at(1.24)}>
        <rect x="204" y="46" width="76" height="22" rx="6" fill="#f6f8f6" stroke="#e0e6e1" strokeWidth="0.5" />
        <text x="242" y="57" textAnchor="middle" dominantBaseline="central" fontSize="10" fill="#5f7168">审查</text>
      </g>

      <path className="engine-wire" style={at(1.75)} d="M58 68 L138 84" fill="none" stroke="#9ab7a5" strokeWidth="1" markerEnd="url(#engine-arrow)" />
      <path className="engine-wire" style={at(1.85)} d="M150 68 L150 84" fill="none" stroke="#9ab7a5" strokeWidth="1" markerEnd="url(#engine-arrow)" />
      <path className="engine-wire" style={at(1.95)} d="M242 68 L162 84" fill="none" stroke="#9ab7a5" strokeWidth="1" markerEnd="url(#engine-arrow)" />

      <rect className="engine-halo" x="104" y="82" width="92" height="30" rx="9" fill="#8fc79f" />
      <g className="engine-node" style={at(2.2)}>
        <rect x="108" y="86" width="84" height="22" rx="6" fill="#f1f7d7" stroke="#b9d34e" strokeWidth="0.5" />
        <text x="150" y="97" textAnchor="middle" dominantBaseline="central" fontSize="10" fill="#1d2b23">汇总交付</text>
      </g>

      {/* 沿整条链路循环的小圆点：调度是持续进行的，不是一个一次性的箭头 */}
      {animate && <circle className="engine-packet" r="3.4" cx="150" cy="30" fill="#2f6b4f">
        <animateMotion
          dur={`${CYCLE}s`}
          repeatCount="indefinite"
          calcMode="linear"
          path="M150 34 L58 50 L58 72 L150 92 L242 72 L242 50 L150 34"
        />
      </circle>}
    </> : <>
      <g className="engine-node" style={at(0)}>
        <rect x="10" y="44" width="74" height="24" rx="6" fill="#f6f8f6" stroke="#e0e6e1" strokeWidth="0.5" />
        <text x="47" y="56" textAnchor="middle" dominantBaseline="central" fontSize="10" fill="#5f7168">任务目标</text>
      </g>

      <path className="engine-wire" style={at(0.5)} d="M86 56 L96 56" fill="none" stroke="#9ab7a5" strokeWidth="1" markerEnd="url(#engine-arrow)" />

      <g className="engine-node" style={at(0.85)}>
        <rect x="98" y="44" width="74" height="24" rx="6" fill="#f6f8f6" stroke="#e0e6e1" strokeWidth="0.5" />
        <text x="135" y="56" textAnchor="middle" dominantBaseline="central" fontSize="10" fill="#5f7168">任务规划</text>
      </g>

      <path className="engine-wire" style={at(1.35)} d="M174 56 L184 56" fill="none" stroke="#9ab7a5" strokeWidth="1" markerEnd="url(#engine-arrow)" />

      <rect className="engine-halo" x="182" y="40" width="82" height="32" rx="9" fill="#8fc79f" />
      <g className="engine-node" style={at(1.6)}>
        <rect x="186" y="44" width="74" height="24" rx="6" fill="#f1f7d7" stroke="#b9d34e" strokeWidth="0.5" />
        <text x="223" y="56" textAnchor="middle" dominantBaseline="central" fontSize="10" fill="#1d2b23">计划产出</text>
      </g>

      {/* 断点：虚线走到这里就断了，后面的专业步骤不会执行 */}
      <path className="engine-stop" style={at(2.1)} d="M264 56 L286 56" fill="none" stroke="#c3cec8" strokeWidth="1" />
      <path className="engine-stop" style={at(2.1)} d="M290 49 L290 63" fill="none" stroke="#c3cec8" strokeWidth="1.5" strokeLinecap="round" />

      {animate && <circle className="engine-packet" r="3.4" cx="16" cy="56" fill="#2f6b4f">
        <animateMotion
          dur={`${CYCLE}s`}
          repeatCount="indefinite"
          calcMode="linear"
          path="M16 56 L223 56 L223 56 L223 56"
        />
      </circle>}
    </>}
  </svg>;
}
