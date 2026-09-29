/**
 * Pure list logic behind the owner DataTable (Owner UX plan, Phase 1a) — sorting, paging and the range
 * label — kept out of the component so it is unit-tested once and every table sorts and pages the same way.
 */

export type SortDir = 'asc' | 'desc';
export type SortValue = string | number | null | undefined;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Stable sort by a derived value. Empty values (null/undefined/'') always sink to the BOTTOM whatever the
 * direction — a blank attendance % must never float to the top of "lowest first" and read as the worst.
 * Strings compare naturally ("Grade 2" < "Grade 10", "GR-0009" < "GR-0010"); numbers numerically.
 */
export function sortRows<T>(rows: readonly T[], value: (row: T) => SortValue, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: value(row) }))
    .sort((a, b) => {
      const aEmpty = a.v === null || a.v === undefined || a.v === '';
      const bEmpty = b.v === null || b.v === undefined || b.v === '';
      if (aEmpty || bEmpty) return aEmpty === bEmpty ? a.i - b.i : aEmpty ? 1 : -1;
      const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : collator.compare(String(a.v), String(b.v));
      return c === 0 ? a.i - b.i : c * sign;
    })
    .map((x) => x.row);
}

export interface PageSlice<T> {
  rows: T[];
  /** The page actually shown — clamped, so a filter that shrinks the list never strands you on page 9 of 2. */
  page: number;
  pageCount: number;
  /** 1-based first/last row numbers shown; 0/0 when empty. */
  from: number;
  to: number;
  total: number;
}

/** Slice one page (1-based). */
export function paginate<T>(rows: readonly T[], page: number, pageSize: number): PageSlice<T> {
  return pageBounds(rows.length, page, pageSize, (from, to) => rows.slice(from, to));
}

/** The same bounds when the SERVER pages and only the current page is in hand. */
export function serverPage<T>(pageRows: readonly T[], page: number, pageSize: number, total: number): PageSlice<T> {
  return pageBounds(total, page, pageSize, () => [...pageRows]);
}

function pageBounds<T>(total: number, page: number, pageSize: number, take: (from: number, to: number) => T[]): PageSlice<T> {
  const size = Math.max(1, pageSize);
  const pageCount = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (p - 1) * size;
  const end = Math.min(start + size, total);
  return { rows: take(start, end), page: p, pageCount, from: total === 0 ? 0 : start + 1, to: end, total };
}

/** "Showing 1–25 of 312" — the count a user needs to trust a filtered list isn't hiding rows. */
export function rangeLabel(s: Pick<PageSlice<unknown>, 'from' | 'to' | 'total'>, noun = 'results'): string {
  if (s.total === 0) return `No ${noun}`;
  return `Showing ${s.from.toLocaleString('en-US')}–${s.to.toLocaleString('en-US')} of ${s.total.toLocaleString('en-US')}`;
}
