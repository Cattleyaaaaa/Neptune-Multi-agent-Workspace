"use client";

/* 工作区路径选择器：像资源管理器一样在"后端真正可写的目录树"里选路径。

   为什么不用浏览器原生的文件对话框：出于安全，浏览器拿不到本地文件的绝对路径，
   而这个项目里的写入发生在服务端（路径是相对工作区根目录的），原生选择器给不出可用结果。
   所以这里浏览的是服务端目录 —— 用后端同一个 write_root，所见即所得：
   在界面里能选中，后端就一定写得进去。

   只读：列目录、不读文件内容。越界路径由后端拒绝，前端不复刻安全规则。 */

import { ArrowUp } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { Folder } from "@phosphor-icons/react/dist/csr/Folder";
import { FolderOpen } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { Warning } from "@phosphor-icons/react/dist/csr/Warning";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useCallback, useEffect, useState } from "react";
import { apiFetch, toErrorMessage } from "../../auth/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";

type Entry = { name: string; type: "dir" | "file"; path: string; size?: number };
type BrowseResult = {
  root: string;
  path: string;
  parent: string | null;
  entries: Entry[];
  truncated: boolean;
};

function formatSize(size?: number) {
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function PathPicker({
  open,
  onClose,
  onPick,
  title = "选择工作区内的路径",
}: {
  open: boolean;
  onClose: () => void;
  onPick: (path: string, kind: "dir" | "file") => void;
  title?: string;
}) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (path: string) => {
    setLoading(true);
    setError("");
    try {
      const response = await apiFetch(
        `${API_URL}/api/fs/browse?path=${encodeURIComponent(path)}`,
      );
      const payload = (await response.json().catch(() => null)) as BrowseResult | null;
      if (!response.ok || !payload) {
        throw new Error(toErrorMessage(payload, "无法读取该目录。"));
      }
      setData(payload);
      setSelected(null);
    } catch (loadError) {
      setError(loadError instanceof Error && loadError.message
        ? loadError.message
        : "无法读取该目录。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load("");
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const current = data?.path ?? "";
  const segments = current ? current.split("/") : [];
  const target = selected ? selected.path : current;

  return <div className="picker-mask" role="dialog" aria-modal="true" aria-label={title}>
    <section className="picker">
      <header className="picker-head">
        <div>
          <h2>{title}</h2>
          <p>
            浏览的是后端真实可写的目录：<code>{data?.root ?? "读取中…"}</code>
          </p>
        </div>
        <button type="button" className="picker-close" onClick={onClose} aria-label="关闭">
          <X />
        </button>
      </header>

      <div className="picker-crumbs">
        <button type="button" onClick={() => void load("")} disabled={loading}>
          <FolderOpen />工作区根
        </button>
        {segments.map((segment, index) => <span key={`${segment}-${index}`}>
          <b>/</b>
          <button
            type="button"
            onClick={() => void load(segments.slice(0, index + 1).join("/"))}
            disabled={loading}
          >
            {segment}
          </button>
        </span>)}
        <button
          type="button"
          className="picker-up"
          onClick={() => void load(data?.parent ?? "")}
          disabled={loading || !data || data.parent === null}
        >
          <ArrowUp />上一级
        </button>
      </div>

      {error && <p className="picker-error"><Warning />{error}</p>}

      <div className="picker-list">
        {loading && !data && <div className="picker-empty">正在读取目录…</div>}
        {data && !data.entries.length && !loading && (
          <div className="picker-empty">这个目录是空的，可以直接选择它。</div>
        )}
        {data?.entries.map((entry) => <div
          key={entry.path}
          className={`picker-row ${selected?.path === entry.path ? "selected" : ""}`}
        >
          <button
            type="button"
            className="picker-main"
            onClick={() => {
              if (entry.type === "dir") void load(entry.path);
              else setSelected(entry);
            }}
          >
            {entry.type === "dir" ? <Folder weight="fill" /> : <FileText />}
            <span>{entry.name}</span>
            {entry.type === "file" && <small>{formatSize(entry.size)}</small>}
          </button>
          {entry.type === "dir" && <button
            type="button"
            className="picker-pick"
            onClick={() => {
              onPick(entry.path, "dir");
              onClose();
            }}
          >
            选它
          </button>}
          {entry.type === "file" && <button
            type="button"
            className="picker-pick"
            onClick={() => {
              onPick(entry.path, "file");
              onClose();
            }}
          >
            选它
          </button>}
        </div>)}
        {data?.truncated && <div className="picker-empty">条目太多，只列出前 500 项。</div>}
      </div>

      <footer className="picker-foot">
        <span>
          将使用：<code>{target || "工作区根目录"}</code>
          {!selected && target ? "（选目录后可在路径里补文件名）" : ""}
        </span>
        <div>
          <button type="button" onClick={onClose}>取消</button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              onPick(target, selected ? "file" : "dir");
              onClose();
            }}
          >
            {selected ? "选择该文件" : "选择此目录"}
          </button>
        </div>
      </footer>
    </section>
  </div>;
}
