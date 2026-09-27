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
export function checkInStatus(
  now: Date,
  dayStartTime: string,
  graceMinutes: number,
  timeZone?: string,
): 'PRESENT' | 'LATE' {
  const [h, m] = dayStartTime.split(':').map(Number);
  const minutesNow = minutesOfDayIn(now, timeZone);
  return minutesNow <= h * 60 + m + graceMinutes ? 'PRESENT' : 'LATE';
}

/**
 * `HH:MM` on a given wall clock — the school's, not the server's (G4).
 *
 * Every timing rule in the product compares a stored `HH:MM` setting against "now", and all of
 * them used to read the server's clock via `Date#getHours()`. That is right only while every
 * tenant sits in the server's zone, and it fails **silently** otherwise: a 13:00 school in another
 * country would have its register judged late at the wrong moment, with nothing in the output to
 * suggest the comparison was against the wrong clock.
 *
 * Formatted rather than arithmetic on offsets, so DST is the runtime's problem and not ours.
 * `hourCycle: 'h23'` because `hour12: false` still yields "24" at midnight in some locales.
 */
export function localHhMm(at: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(at);
}

/** Minutes since local midnight, for comparing against an `HH:MM` setting. */
export function minutesOfDayIn(at: Date, timeZone?: string): number {
  const [h, m] = localHhMm(at, timeZone).split(':').map(Number);
  return h * 60 + m;
}

/**
 * Whether a school's `HH:MM` deadline has passed on its own clock.
 *
 * Both sides are zero-padded 24h, so a lexical compare is a chronological one — but it is worth
 * having one function for it: this same comparison is made by the staff day close and by the
 * class-register deadline, and the two drifting apart is exactly how one school ends up settled
 * at the wrong hour.
 */
export function isPastLocalTime(at: Date, hhmm: string, timeZone?: string): boolean {
  return localHhMm(at, timeZone) >= hhmm;
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
 * Is the school running today, across a set of campuses? (Owner Dashboard Redesign Plan, Phase 2.)
 *
 * The same rule the register applies per campus (`nonWorkingReason` in the attendance service):
 * a weekly-off day closes everything and wins the tie; a holiday with `campusId: null` closes every
 * campus; a campus holiday closes only that campus. The dashboard needs it over MANY campuses at
 * once, so it returns which campuses are shut — the whole-school view must count only the children
 * on campuses that are open, or a one-campus closure reads as "300 registers not marked".
 *
 * `open` is true while at least one campus is working. With no campuses at all (a school still
 * being set up) only the weekly-off and school-wide rules can apply.
 */
export function schoolDayStatus(
  date: Date,
  weeklyOffDays: readonly string[],
  holidays: ReadonlyArray<{ campusId: string | null; name: string }>,
  campusIds: readonly string[],
): { open: boolean; reason: string | null; closedCampusIds: string[] } {
  const WEEK = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  if (weeklyOffDays.includes(WEEK[date.getUTCDay()])) {
    return { open: false, reason: 'Weekly off', closedCampusIds: [...campusIds] };
  }
  const schoolWide = holidays.find((h) => h.campusId === null);
  if (schoolWide) return { open: false, reason: schoolWide.name, closedCampusIds: [...campusIds] };

  const closed = campusIds.filter((id) => holidays.some((h) => h.campusId === id));
  if (campusIds.length > 0 && closed.length === campusIds.length) {
    const names = [...new Set(holidays.filter((h) => h.campusId && closed.includes(h.campusId)).map((h) => h.name))];
    return { open: false, reason: names.length === 1 ? names[0] : 'Holiday', closedCampusIds: closed };
  }
  return { open: true, reason: null, closedCampusIds: closed };
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
