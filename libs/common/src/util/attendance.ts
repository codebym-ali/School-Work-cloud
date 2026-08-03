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
/**
 * Whether a self check-in at `now` counts as on time (§9).
 *
 * **The caller does not get to say.** A staff member presses one button and the clock decides,
 * because `staff_attendance` feeds the payroll deduction — letting someone self-declare "on
 * time" would be the whole exploit in miniature. `dayStartTime` is local wall-clock `HH:MM`
 * (prod runs `TZ=Asia/Karachi`), and `graceMinutes` is how long after it still counts.
 *
 * Exactly `dayStart + grace` is ON TIME; a boundary that punished the last legal minute would
 * be argued over every morning.
 */
export function checkInStatus(now: Date, dayStartTime: string, graceMinutes: number): 'PRESENT' | 'LATE' {
  const [h, m] = dayStartTime.split(':').map(Number);
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  return minutesNow <= h * 60 + m + graceMinutes ? 'PRESENT' : 'LATE';
}

/**
 * The working days in an inclusive range: neither a weekly-off nor a holiday.
 *
 * Needed so "not marked" can be a real number rather than the absence of one. A register that
 * cannot say how many days it is missing cannot be chased, and an attendance figure that
 * silently ignores unmarked days flatters whoever forgot to fill it in.
 */
export function workingDaysBetween(
  from: Date,
  to: Date,
  weeklyOffDays: readonly string[],
  holidayISODates: readonly string[],
): string[] {
  const WEEK = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  const holidays = new Set(holidayISODates);
  const days: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const last = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  while (cursor.getTime() <= last) {
    const iso = cursor.toISOString().slice(0, 10);
    if (!weeklyOffDays.includes(WEEK[cursor.getUTCDay()]) && !holidays.has(iso)) days.push(iso);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * Did this attendance status mean the student was not in school that day?
 *
 * Used to seed the "absent" box when a teacher enters class-test marks. `ABSENT` and `ON_LEAVE`
 * both mean not present — approved leave is still a day the child was not there to sit a test.
 * `HALF_DAY` counts as **present**: they were in for part of the day, and the teacher can tick
 * absent themselves if the test fell in the half they missed. Guessing the other way would
 * hand out a missed-test mark to a student who actually sat it.
 *
 * Note this is deliberately NOT the same question as the attendance percentage, where
 * `ON_LEAVE` is excluded rather than counted against the student.
 */
export function missedSchoolThatDay(status: string | undefined | null): boolean {
  return status === 'ABSENT' || status === 'ON_LEAVE';
}

export function attendancePercentFromStatuses(statuses: readonly string[]): number | null {
  const countable = statuses.filter((s) => s !== 'ON_LEAVE');
  if (!countable.length) return null;
  const credit = countable.reduce(
    (sum, s) => sum + (s === 'PRESENT' || s === 'LATE' ? 1 : s === 'HALF_DAY' ? 0.5 : 0),
    0,
  );
  return Math.round((credit / countable.length) * 100);
}
