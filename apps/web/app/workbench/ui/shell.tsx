"use client";

/* One shell for every workbench route so header height, breadcrumb wording,
   content width and feedback placement stay identical across pages.

   CSS import order is authoritative here: workspace-layout.css comes last and
   therefore wins over workbench.css / sidebar.css (same specificity, later
   file wins). Pages must not import stylesheets themselves. */

import "../workbench.css";
import "../sidebar.css";
import "../../workspace-layout.css";

import type { ReactNode } from "react";
import { WorkbenchSidebar, findGroupLabel, findSectionLabel, type WorkbenchLocation } from "../workbench-sidebar";
import { NoticeBar, type Notice } from "./primitives";

export function WorkspacePage({
  active,
  note,
  actions,
  notice,
  onDismissNotice,
  children,
}: {
  active: WorkbenchLocation;
  /** Optional lead paragraph rendered above the first card. */
  note?: string;
  actions?: ReactNode;
  notice?: Notice | null;
  onDismissNotice?: () => void;
  children: ReactNode;
}) {
  const group = findGroupLabel(active);
  const title = findSectionLabel(active);

  return <main className="control-shell">
    <WorkbenchSidebar active={active} />
    <section className="control-main">
      <header className="control-header">
        <div>
          <p>{group} / {title}</p>
          <h1>{title}</h1>
        </div>
        {actions && <div className="header-actions">{actions}</div>}
      </header>

      {notice && onDismissNotice && <NoticeBar notice={notice} onClose={onDismissNotice} />}

      <div className="control-content">
        {note && <p className="page-lead">{note}</p>}
        {children}
      </div>
    </section>
  </main>;
}
