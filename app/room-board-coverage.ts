/** Returns the physical room dates already covered by assignment spans. */
export function occupiedRoomDates(
  spans: readonly { dates: readonly string[] }[],
): Set<string> {
  return new Set(spans.flatMap((span) => span.dates));
}

/** A move beginning on arrival is semantically a full-stay assignment. */
export function normalizedRoomMoveMode(
  requested: "FULL" | "FROM_DATE",
  arrivalDate: string,
  moveDate: string,
): "FULL" | "FROM_DATE" {
  return requested === "FROM_DATE" && moveDate > arrivalDate
    ? "FROM_DATE"
    : "FULL";
}
