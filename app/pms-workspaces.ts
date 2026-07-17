/** Canonical workspace registry used by routing, navigation, and route tests. */
export const PMS_WORKSPACES = [
  "overview",
  "frontdesk",
  "inventory",
  "website",
  "groups",
  "finance",
  "accounting",
  "channels",
  "rooms",
  "reports",
  "master",
  "revenue",
  "audit",
] as const;

export type PmsWorkspace = (typeof PMS_WORKSPACES)[number];

/** Converts an untrusted URL segment into a known PMS workspace. */
export function parsePmsWorkspace(value: string | null | undefined): PmsWorkspace | null {
  return PMS_WORKSPACES.find((workspace) => workspace === value) ?? null;
}

/** Produces the stable, bookmarkable URL for a PMS workspace. */
export function pmsWorkspacePath(workspace: PmsWorkspace): `/${PmsWorkspace}` {
  return `/${workspace}`;
}
