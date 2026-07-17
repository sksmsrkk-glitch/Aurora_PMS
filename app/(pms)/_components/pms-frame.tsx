"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { parsePmsWorkspace } from "../../pms-workspaces";
import PmsShell from "./pms-shell";

/**
 * Keeps the operational shell mounted while the URL changes between PMS
 * workspaces. The login page and the root redirect still render their own
 * route content, while every recognized workspace shares one live data/cache
 * boundary. This prevents a core snapshot reload on every sidebar click.
 */
export default function PmsFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const workspace = parsePmsWorkspace(pathname.split("/")[1]);

  if (!workspace) return children;
  return <PmsShell initialSection={workspace} />;
}
