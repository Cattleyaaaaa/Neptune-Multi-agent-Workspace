import "./workbench.css";
import "./sidebar.css";
import "../workspace-layout.css";
import { WorkbenchSkeleton } from "./skeleton";

export default function Loading() {
  return <WorkbenchSkeleton active="overview" />;
}
