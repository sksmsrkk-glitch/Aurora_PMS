import type { PmsMutationReceipt } from "./pms-mutation";

export type PmsQueryKey = readonly ["pms", string];

const sharedMutationKeys: readonly PmsQueryKey[] = [
  ["pms", "workspace"],
  ["pms", "frontdesk"],
  ["pms", "reservation-detail"],
  ["pms", "search"],
  ["pms", "report"],
];

/**
 * Returns every read model that can be affected by a successful PMS command.
 * The reservation-detail prefix deliberately invalidates all currently opened
 * detail drawers, including side effects that do not bump a reservation row.
 */
export function successfulMutationQueryKeys(
  receipt: Pick<PmsMutationReceipt, "invalidates">,
): PmsQueryKey[] {
  const keys: PmsQueryKey[] = [
    ...receipt.invalidates.map((key) => ["pms", key] as const),
    ...sharedMutationKeys,
  ];
  return Array.from(new Map(keys.map((key) => [key.join(":"), key])).values());
}

/**
 * Failed optimistic commands may mean another terminal changed the record.
 * These active projections must refetch before the operator can retry.
 */
export function failedMutationQueryKeys(): PmsQueryKey[] {
  return [
    ["pms", "frontdesk"],
    ["pms", "reservation-detail"],
  ];
}
