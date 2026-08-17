import type { BellSchedule, TimetableSlot } from '@/lib/api';

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
 * Which days and periods a grid should show — **the school's declared day when there is one.**
 *
 * `gridShape` below infers the shape from the slots themselves, which is a guess: it reads
 * `max(periodNo)` over whatever has been typed so far, floored at 6. That is all there ever was
 * before the bell schedule existed, and it is why an 8-period school saw 6 rows and Friday looked
 * exactly like Tuesday.
 *
 * With a bell, the answer is **declared**: `periodsByDay` says how many periods each day actually
 * has, so a short Friday is short on the grid too, and a cell past a day's last period is not an
 * empty slot waiting to be filled — it does not exist. Without one (`bell === null`, the state every
 * existing school is in) it falls back to the old inference, unchanged.
 *
 * ⚠️ **Breaks are deliberately not rendered as bands in this week grid.** The plan called for it, and
 * it cannot be honest here: each day is composed independently, so the assembly is row 1 on Monday
 * and absent on Friday, and one shared band across seven columns would be drawing a break on days
 * that do not have it. Breaks live on the School Timings screen, which is day-oriented, and in the
 * per-lesson times below.
 */
export function weekShape(
  bell: BellSchedule | null | undefined,
  slots: TimetableSlot[],
  opts: { minDays?: number; minPeriods?: number } = {},
) {
  const composed = bell?.days.filter((d) => d.teachingPeriods > 0) ?? [];
  if (composed.length === 0) {
    // Either no schedule, or one created and never composed. Both mean "nothing declared yet".
    return { ...gridShape(slots, opts), periodsByDay: null, declared: false };
  }
  const maxDay = Math.max(...composed.map((d) => d.dayOfWeek));
  const maxPeriods = Math.max(...composed.map((d) => d.teachingPeriods));
  const periodsByDay = new Map(composed.map((d) => [d.dayOfWeek, d.teachingPeriods]));
  return {
    days: Array.from({ length: maxDay }, (_, i) => i + 1),
    periods: Array.from({ length: maxPeriods }, (_, i) => i + 1),
    periodsByDay,
    declared: true,
  };
}

/** When one period runs on one day — the times differ per day, so this is never a per-row label. */
export function periodTime(bell: BellSchedule | null | undefined, dayOfWeek: number, periodNo: number) {
  const row = bell?.days.find((d) => d.dayOfWeek === dayOfWeek)?.rows.find((r) => r.periodNo === periodNo);
  return row ? { startTime: row.startTime, endTime: row.endTime } : null;
}

/**
 * The old inferred shape, now the **fallback** rather than the default.
 *
 * `minDays`/`minPeriods` keep an *empty* grid usable — there has to be something to click before
 * the first slot exists.
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
