/**
 * A person's attendance percentage from a set of per-session statuses (blueprint §9).
 * PRESENT and LATE count as a full day, HALF_DAY as half; ON_LEAVE (approved leave) is
 * excluded from the denominator so an authorised absence never counts against attendance.
 * Returns null when there is nothing countable.
 *
 * Single source of truth for the student/parent portals — keep the Staff self-view
 * (`apps/web/app/(app)/my-attendance`) in sync with this weighting.
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
