"use client";

/* 产物视图：把"这次运行到底产出了什么"就地摊开。

   为什么需要它：交付物以前只在「查看步骤 → 交付物」里看得到，对话本身只给一段文字结论，
   于是"看不到交付产物"成了最常见的反馈。现在每条 Agent 回复下面就地列出产物清单，
   点一行展开它的全部字段 —— 不用跳页，也不用猜。

   两条规矩：
   1. 内容全部来自任务自身的 artifacts，不额外请求、不做二次解释；字段名保持后端原样，
      避免"界面说法"和真实产物对不上。
   2. 折叠状态标出"有几项内容"。空壳产物（只有标题、没有正文）一眼能看出来 —— 这是有意
      暴露的事实，不是装饰：本地规则模式下没有外部来源时，产物本来就只有框架。 */

import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { Package } from "@phosphor-icons/react/dist/csr/Package";
import { agentLabels } from "./shared";

/* 一个产物里哪些键算"给人看的正文"，其余降一档灰度显示。 */
const TEXT_KEYS = new Set([
  "title",
  "objective",
  "summary",
  "note",
  "reasoning",
  "method",
  "kind",
  "mode",
  "target",
  "error",
]);

/* 卡片里不必重复的键：标题已经在行标题上、目标就是用户刚发的那句话。 */
const CARD_OMITTED = ["title", "objective"];

export function FieldList({
  value,
  omit = [],
}: {
  value: Record<string, unknown>;
  omit?: readonly string[];
}) {
  const skip = new Set(omit);
  const text: Array<[string, string]> = [];
  const flags: Array<[string, boolean]> = [];
  const lists: Array<[string, string[]]> = [];
  const rest: Array<[string, unknown]> = [];

  for (const [key, item] of Object.entries(value)) {
    if (skip.has(key)) continue;
    if (typeof item === "string" && item.trim()) text.push([key, item.trim()]);
    else if (typeof item === "boolean") flags.push([key, item]);
    else if (Array.isArray(item) && item.length && item.every((entry) => typeof entry === "string")) {
      lists.push([key, item as string[]]);
    } else if (item !== null && item !== undefined && item !== "") rest.push([key, item]);
  }

  return <>
    {text.map(([key, item]) => <div className="field-row" key={key}>
      <small>{key}</small>
      <p className={TEXT_KEYS.has(key) ? "" : "muted"}>{item}</p>
    </div>)}
    {flags.length > 0 && <div className="field-flags">
      {flags.map(([key, item]) => <b key={key} className={item ? "ok" : "bad"}>
        {key}：{item ? "是" : "否"}
      </b>)}
    </div>}
    {lists.map(([key, items]) => <div className="field-row" key={key}>
      <small>{key}</small>
      <ul>{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
    </div>)}
    {rest.length > 0 && <details className="field-raw">
      <summary>其余字段（{rest.length}）</summary>
      <pre>{JSON.stringify(Object.fromEntries(rest), null, 2)}</pre>
    </details>}
  </>;
}

/* 折叠状态标注几个字段 —— 计数规则与 FieldList 的渲染规则**逐字对齐**：
   一个字段只要不是 null / undefined / 空字符串，就一定会被渲染出来（空数组、空对象
   也会进「其余字段」）。分开算会出现"标 4 项、点开看到 5 项"的矛盾。 */
function fieldCount(artifact: Record<string, unknown>): number {
  return Object.entries(artifact).filter(
    ([key, item]) =>
      !CARD_OMITTED.includes(key) && item !== null && item !== undefined && item !== "",
  ).length;
}

export function ArtifactCards({
  artifacts,
}: {
  artifacts?: Record<string, Record<string, unknown>>;
}) {
  const entries = Object.entries(artifacts ?? {});
  if (!entries.length) return null;

  return <section className="artifact-cards" aria-label="交付产物">
    <header className="artifact-cards-head">
      <Package weight="duotone" />
      <strong>交付产物</strong>
      <span>{entries.length} 项 · 点开就地查看</span>
    </header>

    {entries.map(([agent, artifact]) => {
      const value = artifact ?? {};
      const title = typeof value.title === "string" && value.title.trim()
        ? value.title.trim()
        : "Agent 产物";
      const count = fieldCount(value);
      return <details className="artifact-item" key={agent}>
        <summary>
          <FileText weight="duotone" />
          <span className="artifact-name">
            <strong>{title}</strong>
            <small>{agentLabels[agent] ?? agent}</small>
          </span>
          <em className={`artifact-count${count ? "" : " bare"}`}>
            {count ? `${count} 项字段` : "无正文"}
          </em>
          <CaretDown className="artifact-caret" />
        </summary>
        <div className="artifact-body">
          {count
            ? <FieldList value={value} omit={CARD_OMITTED} />
            : <p className="artifact-empty">
              这一项只有标题，没有正文 —— 通常说明上游没有可用的真实数据（例如没有可核验的来源）。
            </p>}
        </div>
      </details>;
    })}
  </section>;
}
