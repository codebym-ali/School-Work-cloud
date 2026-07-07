/**
 * Grading computations (blueprint §11) — pure functions, so they are unit-tested
 * with the worked examples from Appendix C. Grades are ALWAYS derived here at
 * read/publish time; nothing grade-shaped is stored.
 */

export interface GradeBand {
  label: string;
  minPercent: number;
  maxPercent: number;
  gradePoint: number;
}

/** Map a percentage to its grade band label (inclusive bounds). */
export function gradeFor(scale: GradeBand[], percent: number): { label: string; gradePoint: number } | null {
  const band = scale.find((b) => percent >= b.minPercent && percent <= b.maxPercent);
  return band ? { label: band.label, gradePoint: band.gradePoint } : null;
}

export interface ExamMark {
  weightagePercent: number; // this exam's weight within the term
  marksObtained: number | null;
  totalMarks: number;
  isAbsent: boolean;
}

/**
 * Subject term percent = Σ over the term's exams of (marks/total × weightage).
 * Absent in an exam contributes 0 for that exam's weighted share. With weightages
 * summing to 100, the result is a 0–100 percentage.
 */
export function subjectTermPercent(marks: ExamMark[]): number {
  let pct = 0;
  for (const m of marks) {
    if (m.isAbsent || m.marksObtained == null || m.totalMarks <= 0) continue;
    pct += (m.marksObtained / m.totalMarks) * m.weightagePercent;
  }
  return round2(pct);
}

/** Overall = mean of subject term percents (equal subject weighting in v1). */
export function overallPercent(subjectPercents: number[]): number {
  if (subjectPercents.length === 0) return 0;
  return round2(subjectPercents.reduce((s, p) => s + p, 0) / subjectPercents.length);
}

/**
 * Dense rank by value descending (ties share a rank, the next rank skips):
 * values [90, 90, 80] → ranks {90:1, 80:2}. Returns a map keyed by the exact value.
 */
export function denseRankByValue(values: number[]): Map<number, number> {
  const unique = [...new Set(values)].sort((a, b) => b - a);
  const ranks = new Map<number, number>();
  unique.forEach((v, i) => ranks.set(v, i + 1));
  return ranks;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
