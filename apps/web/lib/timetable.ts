import type { TimetableSlot } from '@/lib/api';

/**
 * Shared timetable shaping — used by the admin editor, the teacher week and the student week.
 *
 * One definition on purpose. Three screens render the same grid, and this codebase has been bitten
 * hardest by the same fact computed in more than one place: three copies of the attendance
 * percentage once gave a parent, a teacher and a director three different figures for one child.
 * A week that starts on Monday in one screen and Sunday in another is the same bug wearing a hat.
 */

/** `dayOfWeek` is stored 1 = Monday … 7 = Sunday, matching the column. */
export const DAY_NAMES: Record<number, string> = {
  1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday',
};
export const DAY_SHORT: Record<number, string> = {
  1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun',
};

/** Today in the same 1–7 scheme. `getDay()` is 0 = Sunday, which is the off-by-one to get wrong. */
export function todayDow(): number {
  const js = new Date().getDay();
  return js === 0 ? 7 : js;
}

/**
 * Which days and periods a grid should show.
 *
 * **Derived from the timetable itself, never from a fixed 7×8.** A school that teaches Monday to
 * Saturday over 8 periods should not be shown a Sunday column it will never fill, and one running
 * 10 periods must not have the last two cut off. `minDays`/`minPeriods` keep an *empty* grid
 * usable — there has to be something to click before the first slot exists.
 */
export function gridShape(slots: TimetableSlot[], opts: { minDays?: number; minPeriods?: number } = {}) {
  const { minDays = 5, minPeriods = 6 } = opts;
  const maxDay = slots.reduce((m, s) => Math.max(m, s.dayOfWeek), 0);
  const maxPeriod = slots.reduce((m, s) => Math.max(m, s.periodNo), 0);
  const days = Array.from({ length: Math.max(minDays, maxDay) }, (_, i) => i + 1);
  const periods = Array.from({ length: Math.max(minPeriods, maxPeriod) }, (_, i) => i + 1);
  return { days, periods };
}

/** O(1) cell lookup, so rendering a grid is not a scan of every slot per cell. */
export function byCell(slots: TimetableSlot[]): Map<string, TimetableSlot> {
  return new Map(slots.map((s) => [`${s.dayOfWeek}:${s.periodNo}`, s]));
}

/** Who teaches it — `fullName` is nullable on a staff profile, the code never is. */
export function teacherLabel(slot: TimetableSlot): string {
  return slot.staff.fullName ?? slot.staff.employeeCode;
}

/** "Grade 9-A" — the way a school says it out loud. */
export function sectionLabel(slot: TimetableSlot): string {
  return `${slot.section.class.name}-${slot.section.name}`;
}
