/**
 * Test-performance maths (§11 extension) — the SINGLE source of truth for every surface that
 * shows a percentage from class tests: the student portal, the teacher's class view and the
 * owner's campus → class → student reports.
 *
 * This exists as one module because the same project already learned the cost of the
 * alternative: attendance % was computed separately in three places and gave three different
 * answers for one child until it was extracted into `attendancePercentFromStatuses`. A parent,
 * a teacher and a director must never be shown three different figures for the same student.
 *
 * Two rules decide every number here, both agreed with the operator:
 *
 *  1. **Σ obtained ÷ Σ total**, not the mean of per-test percentages. Tests differ (10, 50), and
 *     a 50-mark test should weigh five times a 10-mark quiz. It is also what a teacher computes
 *     by hand, so the app agrees with the staffroom.
 *
 *  2. **Absences are EXCLUDED, never scored 0.** A sick child is not a failing child, and
 *     attendance already answers "were they there?". Counting an absence as zero conflates two
 *     different questions and makes illness look like failure.
 */

export interface ScoredTest {
  /** Null when the student was absent — excluded from the average, counted separately. */
  marksObtained: number | null;
  totalMarks: number;
  isAbsent: boolean;
  /** Used only for the monthly grouping. */
  testDate: Date | string;
}

export interface PerformanceSummary {
  /** Σ obtained ÷ Σ total, rounded. Null when nothing countable was sat. */
  percent: number | null;
  /** Tests actually sat (absences excluded) — the denominator behind `percent`. */
  testsTaken: number;
  /** Tests missed. Surfaced separately so absence never hides inside a low average. */
  testsMissed: number;
  marksObtained: number;
  marksTotal: number;
}

const num = (v: number | null): number => (v == null ? 0 : v);

/** Roll a set of scored tests into one figure, applying both rules above. */
export function summarisePerformance(scores: readonly ScoredTest[]): PerformanceSummary {
  const sat = scores.filter((s) => !s.isAbsent && s.marksObtained != null);
  const marksObtained = sat.reduce((a, s) => a + num(s.marksObtained), 0);
  const marksTotal = sat.reduce((a, s) => a + s.totalMarks, 0);
  return {
    percent: marksTotal > 0 ? Math.round((marksObtained / marksTotal) * 100) : null,
    testsTaken: sat.length,
    testsMissed: scores.filter((s) => s.isAbsent).length,
    marksObtained,
    marksTotal,
  };
}

export interface MonthlyPerformance extends PerformanceSummary {
  /** `YYYY-MM` — a calendar month, because that is what a school means by "September's result". */
  month: string;
}

/**
 * Per calendar month, newest first. Months with no test are omitted rather than shown as 0% —
 * "no tests were set" and "the student scored nothing" are different facts.
 */
export function monthlyPerformance(scores: readonly ScoredTest[]): MonthlyPerformance[] {
  const byMonth = new Map<string, ScoredTest[]>();
  for (const s of scores) {
    const d = s.testDate instanceof Date ? s.testDate : new Date(s.testDate);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const bucket = byMonth.get(key);
    if (bucket) bucket.push(s);
    else byMonth.set(key, [s]);
  }
  return [...byMonth.entries()]
    .map(([month, rows]) => ({ month, ...summarisePerformance(rows) }))
    .sort((a, b) => b.month.localeCompare(a.month));
}

/** Ranges the reports and the portal both offer, so the vocabulary never diverges. */
export const PERFORMANCE_RANGES = ['1w', '1m', '2m', '3m', '6m'] as const;
export type PerformanceRange = (typeof PERFORMANCE_RANGES)[number];

/** The inclusive start date for a range, relative to now. */
export function rangeStart(range: PerformanceRange, now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (range === '1w') d.setUTCDate(d.getUTCDate() - 7);
  else d.setUTCMonth(d.getUTCMonth() - Number(range.replace('m', '')));
  return d;
}
