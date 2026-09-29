import { paginate, rangeLabel, serverPage, sortRows } from './table';

describe('owner table logic', () => {
  describe('sortRows', () => {
    const rows = [
      { n: 'GR-0010', pct: 80 }, { n: 'GR-0002', pct: null }, { n: 'GR-0009', pct: 95 }, { n: 'gr-0001', pct: 80 },
    ];

    it('sorts strings naturally and case-insensitively', () => {
      expect(sortRows(rows, (r) => r.n, 'asc').map((r) => r.n)).toEqual(['gr-0001', 'GR-0002', 'GR-0009', 'GR-0010']);
      expect(sortRows(rows, (r) => r.n, 'desc').map((r) => r.n)).toEqual(['GR-0010', 'GR-0009', 'GR-0002', 'gr-0001']);
    });

    it('sorts numbers numerically and keeps ties in their original order (stable)', () => {
      expect(sortRows(rows, (r) => r.pct, 'asc').map((r) => r.n)).toEqual(['GR-0010', 'gr-0001', 'GR-0009', 'GR-0002']);
    });

    it('sinks empty values to the bottom in BOTH directions', () => {
      expect(sortRows(rows, (r) => r.pct, 'asc').at(-1)!.n).toBe('GR-0002');
      expect(sortRows(rows, (r) => r.pct, 'desc').at(-1)!.n).toBe('GR-0002');
    });

    it('does not mutate its input', () => {
      const before = rows.map((r) => r.n);
      sortRows(rows, (r) => r.n, 'desc');
      expect(rows.map((r) => r.n)).toEqual(before);
    });
  });

  describe('paginate', () => {
    const list = Array.from({ length: 53 }, (_, i) => i + 1);

    it('slices a page and reports 1-based bounds', () => {
      expect(paginate(list, 2, 25)).toMatchObject({ rows: list.slice(25, 50), page: 2, pageCount: 3, from: 26, to: 50, total: 53 });
      expect(paginate(list, 3, 25)).toMatchObject({ from: 51, to: 53 });
    });

    it('clamps a page past the end (a narrowing filter never strands you on an empty page)', () => {
      expect(paginate(list, 9, 25).page).toBe(3);
      expect(paginate(list, 0, 25).page).toBe(1);
    });

    it('reports an empty list as one page with 0/0 bounds', () => {
      expect(paginate([], 1, 25)).toMatchObject({ rows: [], page: 1, pageCount: 1, from: 0, to: 0, total: 0 });
    });

    it('computes the same bounds for a server-paged list', () => {
      expect(serverPage(['a', 'b'], 4, 25, 312)).toMatchObject({ rows: ['a', 'b'], page: 4, pageCount: 13, from: 76, to: 100, total: 312 });
    });
  });

  it('labels the range in plain words', () => {
    expect(rangeLabel({ from: 1, to: 25, total: 1312 })).toBe('Showing 1–25 of 1,312');
    expect(rangeLabel({ from: 0, to: 0, total: 0 }, 'students')).toBe('No students');
  });
});
