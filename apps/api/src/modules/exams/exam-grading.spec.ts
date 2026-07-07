import { denseRankByValue, gradeFor, overallPercent, subjectTermPercent, type GradeBand } from './exam-grading';

const SCALE: GradeBand[] = [
  { label: 'A+', minPercent: 90, maxPercent: 100, gradePoint: 4.0 },
  { label: 'A', minPercent: 80, maxPercent: 89.99, gradePoint: 3.7 },
  { label: 'B', minPercent: 70, maxPercent: 79.99, gradePoint: 3.0 },
  { label: 'C', minPercent: 60, maxPercent: 69.99, gradePoint: 2.0 },
  { label: 'F', minPercent: 0, maxPercent: 59.99, gradePoint: 0.0 },
];

describe('Exam grading (§11)', () => {
  it('maps a percent to its grade band (inclusive)', () => {
    expect(gradeFor(SCALE, 95)?.label).toBe('A+');
    expect(gradeFor(SCALE, 80)?.label).toBe('A');
    expect(gradeFor(SCALE, 57)?.label).toBe('F');
    expect(gradeFor([], 50)).toBeNull();
  });

  it('computes a subject term percent as the weighted sum across exams', () => {
    // Mid-Term (w40) 80/100, Final (w60) 90/100 → 0.8*40 + 0.9*60 = 32 + 54 = 86
    const math = subjectTermPercent([
      { weightagePercent: 40, marksObtained: 80, totalMarks: 100, isAbsent: false },
      { weightagePercent: 60, marksObtained: 90, totalMarks: 100, isAbsent: false },
    ]);
    expect(math).toBe(86);

    // English: Mid 70/100 (28), Final ABSENT → contributes 0 → 28
    const english = subjectTermPercent([
      { weightagePercent: 40, marksObtained: 70, totalMarks: 100, isAbsent: false },
      { weightagePercent: 60, marksObtained: null, totalMarks: 100, isAbsent: true },
    ]);
    expect(english).toBe(28);
  });

  it('overall is the mean of subject percents; grade derives from it', () => {
    const overall = overallPercent([86, 28]);
    expect(overall).toBe(57);
    expect(gradeFor(SCALE, overall)?.label).toBe('F');
  });

  it('dense-ranks within a section (ties share, next rank skips)', () => {
    const ranks = denseRankByValue([86, 57, 57]);
    expect(ranks.get(86)).toBe(1);
    expect(ranks.get(57)).toBe(2); // both 57s share rank 2
    const three = denseRankByValue([90, 90, 80]);
    expect(three.get(90)).toBe(1);
    expect(three.get(80)).toBe(2);
  });
});
