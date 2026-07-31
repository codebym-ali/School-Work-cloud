import { monthlyPerformance, rangeStart, summarisePerformance } from './performance';

/**
 * The two rules these tests pin down are product decisions, not implementation details:
 * a bigger test counts for more, and an absence is not a zero. Both are load-bearing — every
 * percentage the student, teacher and owner ever see is computed here.
 */
describe('summarisePerformance', () => {
  it('weighs by marks, not by test count', () => {
    // 45/50 and 2/10. Averaging the percentages would give (90 + 20) / 2 = 55%.
    // Σ obtained ÷ Σ total gives 47/60 = 78%, because the 50-mark test genuinely counts more.
    const s = summarisePerformance([
      { marksObtained: 45, totalMarks: 50, isAbsent: false, testDate: '2026-09-01' },
      { marksObtained: 2, totalMarks: 10, isAbsent: false, testDate: '2026-09-02' },
    ]);
    expect(s.percent).toBe(78);
    expect(s.testsTaken).toBe(2);
  });

  it('excludes an absence instead of scoring it zero, and counts it separately', () => {
    const scores = [
      { marksObtained: 8, totalMarks: 10, isAbsent: false, testDate: '2026-09-01' },
      { marksObtained: null, totalMarks: 10, isAbsent: true, testDate: '2026-09-08' },
    ];
    const s = summarisePerformance(scores);
    // 8/10 — not 8/20, which is what counting the absence as 0 would produce.
    expect(s.percent).toBe(80);
    expect(s.testsTaken).toBe(1);
    expect(s.testsMissed).toBe(1);
  });

  it('returns null rather than 0% when nothing countable was sat', () => {
    // "No marks yet" and "scored nothing" are different facts and must not render alike.
    expect(summarisePerformance([]).percent).toBeNull();
    expect(summarisePerformance([{ marksObtained: null, totalMarks: 10, isAbsent: true, testDate: '2026-09-01' }]).percent).toBeNull();
  });
});

describe('monthlyPerformance', () => {
  it('groups by calendar month, newest first, and omits months with no test', () => {
    const rows = monthlyPerformance([
      { marksObtained: 5, totalMarks: 10, isAbsent: false, testDate: '2026-08-14' },
      { marksObtained: 9, totalMarks: 10, isAbsent: false, testDate: '2026-09-02' },
      { marksObtained: 7, totalMarks: 10, isAbsent: false, testDate: '2026-09-20' },
    ]);
    expect(rows.map((r) => r.month)).toEqual(['2026-09', '2026-08']);
    expect(rows[0].percent).toBe(80); // (9 + 7) / 20
    expect(rows[1].percent).toBe(50);
    // July had no test at all — absent from the list, not shown as 0%.
    expect(rows.find((r) => r.month === '2026-07')).toBeUndefined();
  });
});

describe('rangeStart', () => {
  it('resolves each offered range', () => {
    const now = new Date('2026-09-15T10:00:00Z');
    expect(rangeStart('1w', now).toISOString().slice(0, 10)).toBe('2026-09-08');
    expect(rangeStart('1m', now).toISOString().slice(0, 10)).toBe('2026-08-15');
    expect(rangeStart('3m', now).toISOString().slice(0, 10)).toBe('2026-06-15');
    expect(rangeStart('6m', now).toISOString().slice(0, 10)).toBe('2026-03-15');
  });
});
