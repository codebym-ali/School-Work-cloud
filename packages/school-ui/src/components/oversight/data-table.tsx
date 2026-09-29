'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { paginate, rangeLabel, serverPage, sortRows, type SortDir, type SortValue } from '@school/lib/table';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Present ⇒ the column is sortable by this value. */
  sortValue?: (row: T) => SortValue;
  align?: 'left' | 'right';
  /** Starts hidden; the user can turn it on from "Columns". */
  defaultHidden?: boolean;
  /** Can't be hidden (the identity column). */
  pinned?: boolean;
  width?: string;
  /** With `serverSort`: the column sorts the WHOLE list on the server (its key is sent as the field). */
  serverSortable?: boolean;
}

/**
 * Supply with `serverPaging` when the API can sort. Then only `serverSortable` columns sort, and a header
 * click asks the server — a client sort over one page is a list whose page 2 starts again from A.
 */
export interface ServerSort {
  sort: { key: string; dir: SortDir } | null;
  onSortChange: (sort: { key: string; dir: SortDir } | null) => void;
}

/** Supply when the SERVER pages: `rows` is then only the current page. */
export interface ServerPaging {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

/**
 * The owner list (Owner UX plan, Phase 1a): dense, sortable, paged, with the row as the way into the record.
 *
 * - Sorting is by header button with `aria-sort`; empty values sink to the bottom either way.
 * - Paging shows "Showing 1–25 of 312" — client-side by default, or `serverPaging` for server-paged APIs
 *   (pair it with `serverSort` so a header sorts the whole list, not the page in hand).
 * - Columns can be shown/hidden, so a dense table stays readable on a laptop.
 * - Selection (checkboxes) raises a bulk-action bar; `bulkActions` renders its buttons.
 * - `onRowClick` makes the whole row open the record (mouse or Enter); clicks on controls inside the row
 *   (checkbox, ⋯ menu, links) do NOT trigger it.
 */
export function DataTable<T>({
  columns, rows, rowKey, caption, loading = false, empty, onRowClick, rowLabel,
  pageSize = 25, serverPaging, serverSort, initialSort, selectable = false, bulkActions, noun = 'results', toolbar,
}: {
  serverSort?: ServerSort;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Accessible name for the table. */
  caption: string;
  loading?: boolean;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  /** Accessible name of a clickable row ("Open Ahmed Butt"). */
  rowLabel?: (row: T) => string;
  pageSize?: number;
  serverPaging?: ServerPaging;
  initialSort?: { key: string; dir: SortDir };
  selectable?: boolean;
  bulkActions?: (selected: T[], clear: () => void) => ReactNode;
  noun?: string;
  /** Rendered at the left of the toolbar row (e.g. a status filter). */
  toolbar?: ReactNode;
}) {
  const [localSort, setLocalSort] = useState<{ key: string; dir: SortDir } | null>(initialSort ?? null);
  const sort = serverSort ? serverSort.sort : localSort;
  const canSort = (c: Column<T>) => (serverSort ? !!c.serverSortable : !!c.sortValue);
  const [page, setPage] = useState(1);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(columns.filter((c) => c.defaultHidden).map((c) => c.key)));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [colsOpen, setColsOpen] = useState(false);
  const colsRef = useRef<HTMLDivElement>(null);

  // A new data set (new filter) starts from page 1 with nothing selected.
  const sig = useMemo(() => rows.map(rowKey).join('|'), [rows, rowKey]);
  useEffect(() => { if (!serverPaging) setPage(1); setSelected(new Set()); }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!colsOpen) return;
    const onDown = (e: MouseEvent) => { if (!colsRef.current?.contains(e.target as Node)) setColsOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setColsOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [colsOpen]);

  const shown = columns.filter((c) => !hidden.has(c.key));
  // Server-sorted rows arrive in order; re-sorting them locally would only fight the server.
  const sortCol = sort && !serverSort ? columns.find((c) => c.key === sort.key && c.sortValue) : undefined;
  const sorted = sortCol && sort ? sortRows(rows, sortCol.sortValue!, sort.dir) : rows;
  const slice = serverPaging
    ? serverPage(sorted, serverPaging.page, serverPaging.pageSize, serverPaging.total)
    : paginate(sorted, page, pageSize);
  const goTo = (p: number) => (serverPaging ? serverPaging.onPageChange(p) : setPage(p));

  const pageKeys = slice.rows.map(rowKey);
  const allOnPage = pageKeys.length > 0 && pageKeys.every((k) => selected.has(k));
  const someOnPage = pageKeys.some((k) => selected.has(k));
  const selectedRows = rows.filter((r) => selected.has(rowKey(r)));
  const clear = () => setSelected(new Set());
  const toggle = (k: string) => setSelected((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const toggleAll = () => setSelected((s) => {
    const n = new Set(s);
    if (allOnPage) pageKeys.forEach((k) => n.delete(k)); else pageKeys.forEach((k) => n.add(k));
    return n;
  });

  const next = (s: { key: string; dir: SortDir } | null, key: string) =>
    (s?.key !== key ? { key, dir: 'asc' as SortDir } : s.dir === 'asc' ? { key, dir: 'desc' as SortDir } : null);
  const cycleSort = (key: string) => (serverSort ? serverSort.onSortChange(next(serverSort.sort, key)) : setLocalSort((s) => next(s, key)));
  const hideable = columns.filter((c) => !c.pinned);
  const colSpan = shown.length + (selectable ? 1 : 0);

  return (
    <div className="ov-table-card">
      <div className="ov-toolbar">
        <div className="ov-toolbar-left">
          {selectable && selected.size > 0 ? (
            <div className="ov-bulk" role="region" aria-label="Bulk actions">
              <strong>{selected.size} selected</strong>
              {bulkActions?.(selectedRows, clear)}
              <button type="button" className="ov-link" onClick={clear}>Clear</button>
            </div>
          ) : toolbar}
        </div>
        <div className="ov-toolbar-right">
          <span className="ov-range" aria-live="polite">{loading ? 'Loading…' : rangeLabel(slice, noun)}</span>
          {hideable.length > 0 && (
            <div className="ov-cols" ref={colsRef}>
              <button type="button" className="ov-btn-quiet" aria-haspopup="true" aria-expanded={colsOpen} onClick={() => setColsOpen((o) => !o)}>
                Columns
              </button>
              {colsOpen && (
                <div className="ov-menu ov-cols-menu" role="group" aria-label="Show columns">
                  {hideable.map((c) => (
                    <label key={c.key} className="ov-check">
                      <input type="checkbox" checked={!hidden.has(c.key)}
                        onChange={() => setHidden((h) => { const n = new Set(h); if (n.has(c.key)) n.delete(c.key); else n.add(c.key); return n; })} />
                      {c.header}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="ov-table-scroll">
        <table className="ov-table" aria-label={caption} aria-busy={loading}>
          <thead>
            <tr>
              {selectable && (
                <th className="ov-col-check">
                  <input type="checkbox" aria-label="Select all on this page" checked={allOnPage}
                    ref={(el) => { if (el) el.indeterminate = !allOnPage && someOnPage; }} onChange={toggleAll} />
                </th>
              )}
              {shown.map((c) => {
                const active = sort?.key === c.key;
                const ariaSort = active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : canSort(c) ? 'none' : undefined;
                return (
                  <th key={c.key} scope="col" aria-sort={ariaSort} style={{ width: c.width, textAlign: c.align }}>
                    {canSort(c) ? (
                      <button type="button" className={`ov-sort${active ? ' is-active' : ''}`} onClick={() => cycleSort(c.key)}>
                        {c.header}
                        <span className="ov-sort-ind" aria-hidden>{active ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
                      </button>
                    ) : c.header}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading && Array.from({ length: 5 }, (_, i) => (
              <tr key={`sk${i}`} aria-hidden><td colSpan={colSpan}><span className="ov-skel ov-row-skel" /></td></tr>
            ))}
            {!loading && slice.rows.length === 0 && (
              <tr><td colSpan={colSpan} className="ov-empty-cell">{empty ?? `No ${noun}`}</td></tr>
            )}
            {!loading && slice.rows.map((r) => {
              const k = rowKey(r);
              const clickable = !!onRowClick;
              return (
                <tr key={k}
                  className={`${clickable ? 'is-clickable' : ''}${selected.has(k) ? ' is-selected' : ''}`}
                  tabIndex={clickable ? 0 : undefined}
                  aria-label={clickable && rowLabel ? rowLabel(r) : undefined}
                  onClick={clickable ? (e) => { if (!isInteractive(e.target)) onRowClick!(r); } : undefined}
                  onKeyDown={clickable ? (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onRowClick!(r); } : undefined}>
                  {selectable && (
                    <td className="ov-col-check">
                      <input type="checkbox" aria-label={`Select ${rowLabel?.(r) ?? 'row'}`} checked={selected.has(k)} onChange={() => toggle(k)} />
                    </td>
                  )}
                  {shown.map((c) => <td key={c.key} style={{ textAlign: c.align }}>{c.cell(r)}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {slice.pageCount > 1 && (
        <nav className="ov-pager" aria-label="Pages">
          <button type="button" className="ov-btn-quiet" disabled={slice.page <= 1} onClick={() => goTo(slice.page - 1)}>← Previous</button>
          <span>Page {slice.page} of {slice.pageCount}</span>
          <button type="button" className="ov-btn-quiet" disabled={slice.page >= slice.pageCount} onClick={() => goTo(slice.page + 1)}>Next →</button>
        </nav>
      )}
    </div>
  );
}

/** A click that landed on a control inside the row is that control's, not the row's. */
function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('a, button, input, select, textarea, label, [role="menu"]');
}
