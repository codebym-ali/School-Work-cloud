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
/**
 * Was the student not in school that day? Browser twin of `missedSchoolThatDay` in
 * `libs/common/util/attendance.ts` — **change one, change both.**
 *
 * `ABSENT` and `ON_LEAVE` both mean not present: approved leave is still a day the child was
 * not there to sit a test. `HALF_DAY` counts as present — they were in for part of it, and the
 * teacher can tick absent themselves if the test fell in the half they missed. Guessing the
 * other way would record a missed test for a student who actually sat it.
 *
 * Deliberately NOT the same question as the attendance percentage, where `ON_LEAVE` is
 * excluded from the denominator rather than counted against the student.
 */
export function missedSchool(status: string | undefined | null): boolean {
  return status === 'ABSENT' || status === 'ON_LEAVE';
}

export function attendancePercent(statuses: readonly string[]): number | null {
  const countable = statuses.filter((s) => s !== 'ON_LEAVE');
  if (!countable.length) return null;
  const credit = countable.reduce(
    (sum, s) => sum + (s === 'PRESENT' || s === 'LATE' ? 1 : s === 'HALF_DAY' ? 0.5 : 0),
    0,
  );
  return Math.round((credit / countable.length) * 100);
}
