/**
 * Named date ranges, shared by every attendance history view.
 *
 * One definition on purpose: the teacher's own screen and the owner's drill-down must not be
 * able to disagree about what "last 3 months" means. The same lesson as the attendance
 * percentage — a figure a teacher and a director read differently destroys trust in both.
 */
export type RangeKey = '1m' | '3m' | '6m' | '1y' | 'all';

export const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: '1m', label: 'Last month' },
  { key: '3m', label: 'Last 3 months' },
  { key: '6m', label: 'Last 6 months' },
  { key: '1y', label: 'Last year' },
  // "All time" is not a nicety: without it a lifetime question forces the reader to guess a
  // start date, and a guessed start date silently truncates the answer.
  { key: 'all', label: 'All time' },
];

const MONTHS: Record<Exclude<RangeKey, 'all'>, number> = { '1m': 1, '3m': 3, '6m': 6, '1y': 12 };

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * `{ from, to }` as YYYY-MM-DD for the API. `all` returns no `from`, letting the server decide
 * how far back the record goes rather than this file inventing an epoch.
 *
 * Counts back in CALENDAR months, not 30-day blocks — "last 3 months" on 5 August means from
 * 5 May, which is what a person means and what a payroll month aligns to.
 */
export function rangeToParams(key: RangeKey, today = new Date()): { from?: string; to: string } {
  const to = iso(today);
  if (key === 'all') return { to };
  const from = new Date(today);
  from.setMonth(from.getMonth() - MONTHS[key]);
  return { from: iso(from), to };
}

export function rangeQuery(key: RangeKey): string {
  const { from, to } = rangeToParams(key);
  return new URLSearchParams({ ...(from ? { from } : {}), to }).toString();
}
