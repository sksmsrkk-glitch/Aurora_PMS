/** Returns the physical room dates already covered by assignment spans. */
export function occupiedRoomDates(
  spans: readonly { dates: readonly string[] }[],
): Set<string> {
  return new Set(spans.flatMap((span) => span.dates));
}
