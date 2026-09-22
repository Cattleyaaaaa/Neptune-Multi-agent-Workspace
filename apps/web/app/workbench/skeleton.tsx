"use client";

/* Streaming fallback shared by every workbench route.

   `/workbench/loading.tsx` covers all nested pages, so it cannot know the
   destination through props. Reading it from the pathname keeps the sidebar
   highlight correct while a page streams in — otherwise every navigation under
   /workbench briefly showed "编排总览" as selected. Pages that own their own
   loading.tsx keep passing an explicit `active`, which is used as the fallback
   for the hash sections that live inside /workbench. */

import { usePathname } from "next/navigation";
import { WorkbenchSidebar, locationFromPathname, type WorkbenchLocation } from "./workbench-sidebar";

export function WorkbenchSkeleton({ active }: { active: WorkbenchLocation }) {
  const pathname = usePathname();
  const resolved = locationFromPathname(pathname ?? "") ?? active;

  return <main className="control-shell">
    <WorkbenchSidebar active={resolved} />
    <section className="control-main">
      <header className="control-header">
        <div>
          <span className="skeleton-block skeleton-line-sm" />
          <span className="skeleton-block skeleton-line-lg" />
        </div>
        <span className="skeleton-block skeleton-actions" />
      </header>
      <div className="control-content">
        <span className="skeleton-block skeleton-card" />
        <span className="skeleton-block skeleton-card" />
        <span className="skeleton-block skeleton-card-sm" />
      </div>
    </section>
  </main>;
}
