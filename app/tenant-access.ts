/** Pure tenant-entry policy shared by login behavior and its regression tests. */
export type TenantAccessAssignment = { subscription_status: string };

export function hasUsableTenantAccess(
  assignments: TenantAccessAssignment[],
  activeSupportGrantCount = 0,
) {
  return (
    assignments.some(
      (assignment) =>
        !["SUSPENDED", "CANCELLED"].includes(
          String(assignment.subscription_status).toUpperCase(),
        ),
    ) || activeSupportGrantCount > 0
  );
}
