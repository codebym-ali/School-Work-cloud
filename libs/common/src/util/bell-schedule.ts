/**
 * Composing a school day from a start time and a list of durations.
 *
 * ⚠️ **This is the whole reason the API takes durations instead of times.** An earlier draft of the
 * plan had the client send `startTime`/`endTime` per row and the server *validate* that rows were
 * contiguous — which cannot work at row granularity (a single-row edit is either accepted while it
 * breaks the day, or rejected while it is a legal intermediate state) and leaves gaps and overlaps
 * permanently possible for anything that writes the table.
 *
 * Walking the day from one start time makes both **inexpressible**: there is no input that produces
 * a gap, an overlap, or an out-of-order row. `sequence` and `periodNo` are assigned here for the
 * same reason — a hand-typed period number is how a grid ends up with a period 7 that no bell
 * rings for.
 */

export interface BellDayInputRow {
  isTeaching: boolean;
  label?: string | null;
  minutes: number;
}

export interface ComposedBellRow {
  sequence: number;
  isTeaching: boolean;
  periodNo: number | null;
  label: string | null;
  startTime: string;
  endTime: string;
}

/** Minutes since local midnight for a zero-padded `HH:MM`. */
export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/** The inverse. Always zero-padded, which is what makes these strings sort chronologically. */
export function minutesToHhmm(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Raised when a composed day cannot exist. The service turns it into a 422. */
export class BellDayError extends Error {}

/**
 * Walk `rows` forward from `startsAt`, producing stored rows.
 *
 * Teaching rows are numbered 1..n in order; breaks carry no number (and the DB CHECK asserts that
 * correspondence, so the two can never drift apart).
 */
export function composeBellDay(startsAt: string, rows: BellDayInputRow[]): ComposedBellRow[] {
  const out: ComposedBellRow[] = [];
  let cursor = hhmmToMinutes(startsAt);
  let periodNo = 0;

  rows.forEach((row, index) => {
    const end = cursor + row.minutes;
    // A day that runs past midnight is not a long day, it is a typo — and `end_time > start_time`
    // in SQL would reject the wrapped row anyway, with a message nobody could act on.
    if (end > 23 * 60 + 59) {
      throw new BellDayError(
        `The day would run past midnight — it reaches ${minutesToHhmm(Math.min(end, 24 * 60))} by row ${index + 1}.`,
      );
    }
    out.push({
      sequence: index,
      isTeaching: row.isTeaching,
      periodNo: row.isTeaching ? ++periodNo : null,
      label: row.isTeaching ? null : (row.label?.trim() || 'Break'),
      startTime: minutesToHhmm(cursor),
      endTime: minutesToHhmm(end),
    });
    cursor = end;
  });

  return out;
}

/** How many teaching periods a composed day holds — the declared count the grid renders. */
export function teachingPeriodCount(rows: Pick<ComposedBellRow, 'isTeaching'>[]): number {
  return rows.filter((r) => r.isTeaching).length;
}
