/**
 * A person's attendance percentage from a set of per-session statuses (blueprint §9).
 * PRESENT and LATE count as a full day, HALF_DAY as half; ON_LEAVE (approved leave) is
 * excluded from the denominator so an authorised absence never counts against attendance.
 * Returns null when there is nothing countable.
 *
 * Single source of truth on the server. The browser has one unavoidable twin —
 * `apps/web/lib/attendance.ts` — because `apps/web` cannot import `@common`. **Change one,
 * change both**; three copies of this calculation once gave a parent, a teacher and a director
 * three different figures for the same child.
 */
export function attendancePercentFromStatuses(statuses: readonly string[]): number | null {
  const countable = statuses.filter((s) => s !== 'ON_LEAVE');
  if (!countable.length) return null;
  const credit = countable.reduce(
    (sum, s) => sum + (s === 'PRESENT' || s === 'LATE' ? 1 : s === 'HALF_DAY' ? 0.5 : 0),
    0,
  );
  return Math.round((credit / countable.length) * 100);
}
