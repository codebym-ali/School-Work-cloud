/**
 * Client-side preview of a composed day.
 *
 * ⚠️ **This duplicates `composeBellDay` on the server, and the duplication is deliberate and
 * bounded.** The screen has to show times moving as an admin edits a duration — that is the whole
 * point of entering minutes instead of clock times — and `libs/common` cannot be imported here,
 * because `apps/web` is a separate pnpm project with its own lockfile.
 *
 * What keeps it from becoming the three-different-attendance-percentages bug: **this function never
 * produces stored data.** Nothing here is sent to the server (the payload is `startsAt` + minutes),
 * and every save replaces the screen's state with the server's own response — so the moment a value
 * is real, it came from `composeBellDay`. The preview can only ever be wrong for the seconds before
 * you press Save, and the e2e asserts the two agree.
 */

export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

export function minutesToHhmm(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export interface DraftRow {
  isTeaching: boolean;
  label: string;
  minutes: number;
}

export interface PreviewRow extends DraftRow {
  startTime: string;
  endTime: string;
  /** Null on a break — the same rule the server applies, so the numbering shown is the real one. */
  periodNo: number | null;
  /** True once the day has run past midnight; the screen refuses to save while any row is over. */
  overflows: boolean;
}

export function previewDay(startsAt: string, rows: DraftRow[]): PreviewRow[] {
  let cursor = hhmmToMinutes(startsAt);
  let periodNo = 0;
  return rows.map((row) => {
    const end = cursor + row.minutes;
    const out: PreviewRow = {
      ...row,
      startTime: minutesToHhmm(Math.min(cursor, 23 * 60 + 59)),
      endTime: minutesToHhmm(Math.min(end, 23 * 60 + 59)),
      periodNo: row.isTeaching ? ++periodNo : null,
      overflows: end > 23 * 60 + 59,
    };
    cursor = end;
    return out;
  });
}

/** What the day adds up to — the number a coordinator is actually trying to hit. */
export function daySummary(rows: PreviewRow[]) {
  const teaching = rows.filter((r) => r.isTeaching).length;
  return { teaching, endsAt: rows.length ? rows[rows.length - 1].endTime : null };
}
