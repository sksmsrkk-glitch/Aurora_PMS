/** Pure calendar math shared by the inventory UI and behavioral tests. */

import { addIsoDays } from "../lib/format";

export function inclusiveDays(from: string, to: string) {
  return Math.max(1, Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1);
}

export function matchingDayCount(from: string, to: string, selectedWeekdays: number[]) {
  let count = 0;
  for (let date = from, guard = 0; date <= to && guard < 730; date = addIsoDays(date, 1), guard += 1) {
    if (selectedWeekdays.includes(new Date(`${date}T00:00:00Z`).getUTCDay())) count += 1;
  }
  return count;
}

/** Returns the small server/render window inside a potentially 730-day selection. */
export function boundedCalendarWindow(cursor: string, selectionTo: string, windowDays: 14 | 30) {
  const candidate = addIsoDays(cursor, windowDays - 1);
  const to = candidate < selectionTo ? candidate : selectionTo;
  return { from: cursor, to, days: inclusiveDays(cursor, to) };
}
