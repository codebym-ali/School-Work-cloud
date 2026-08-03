/**
 * Attendance percentage — the browser-side twin of `attendancePercentFromStatuses` in
 * `libs/common/src/util/attendance.ts`.
 *
 * ⚠️ These two must always agree. The server helper exists because the same figure was once
 * computed in three places and gave a parent, a teacher and a director three different answers
 * for one child; the duplication here is unavoidable only because `apps/web` cannot import
 * `@common` (separate tsconfig, separate install). **Change one, change both.**
 *
 * The rule: PRESENT and LATE are a full day, HALF_DAY is half, and ON_LEAVE is excluded from
 * the denominator entirely — approved leave is not an attendance failure. Returns null when
 * nothing is countable, because "no records yet" and "attended nothing" are different facts
 * and must not render alike.
 */
export function attendancePercent(statuses: readonly string[]): number | null {
  const countable = statuses.filter((s) => s !== 'ON_LEAVE');
  if (!countable.length) return null;
  const credit = countable.reduce(
    (sum, s) => sum + (s === 'PRESENT' || s === 'LATE' ? 1 : s === 'HALF_DAY' ? 0.5 : 0),
    0,
  );
  return Math.round((credit / countable.length) * 100);
}
