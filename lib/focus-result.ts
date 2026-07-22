/**
 * Resolves a deep-linked entity only after the matching request has completed.
 *
 * React Query keeps the previous page visible while the next request is in
 * flight. Without both guards below, a new `focus` URL can accidentally open a
 * row from that stale page and then clear the URL before the real response
 * arrives.
 */
export function resolveFocusedRow<T extends { id: string }>(
  payload:
    | { query?: { focus?: string }; rows: readonly T[] }
    | null
    | undefined,
  focus: string,
  isPlaceholderData: boolean,
): T | undefined {
  if (
    !focus ||
    isPlaceholderData ||
    payload?.query?.focus !== focus
  )
    return undefined;

  return payload.rows.find((row) => row.id === focus);
}
