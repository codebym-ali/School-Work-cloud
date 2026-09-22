'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, type SubjectCatalogueEntry, type SubjectMergeResult } from '@sw/api-client';
import { Metric, MetricFilter } from '@sw/ui';

/** Edit distance, capped small — we only care whether two names are one or two typos apart. */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[n];
}

/**
 * Two subject names look like the same subject when they differ only by case (`punjabi`/`Punjabi`),
 * by a couple of typos (`Mathmetics`/`Mathematics`), or one is a prefix of the other (`Math`/`Maths`).
 * Deliberately generous: this only SUGGESTS a merge, which a human then confirms.
 */
function looksAlike(a: string, b: string): boolean {
  const x = a.toLowerCase(), y = b.toLowerCase();
  if (x === y) return true;
  if (Math.max(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x))) return true;
  return Math.max(x.length, y.length) >= 4 && editDistance(x, y) <= 2;
}

/** Cluster catalogue names into groups of near-duplicates (size ≥ 2). Small N, so O(n²) is fine. */
function duplicateGroups(names: string[]): string[][] {
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    const group = names.filter((m) => !seen.has(m) && (m === n || looksAlike(n, m)));
    if (group.length > 1) { group.forEach((m) => seen.add(m)); groups.push(group); }
  }
  return groups;
}

/**
 * Subjects — the cross-class view that never existed.
 *
 * ⚠️ **A subject only ever lived inside one class's page.** `GET /subjects/catalogue` had returned a
 * bare `{ name, classCount }` and **had no caller at all** — so "which classes teach Chemistry, who
 * is short a teacher, and how many periods a week does it get" could not be asked. A coordinator
 * allocating a year's load thinks in subjects ACROSS classes, not one class at a time; this is that
 * surface.
 *
 * `periodsPerWeek` is per class (Grade 9 · Chemistry and Grade 10 · Chemistry are two rows with one
 * name and can differ), so it is edited here per class — the same `setLoad` the class page uses, so
 * the two can never disagree. The teacher-gap count reuses the one server fact (Law 4), so "3
 * without a teacher" here matches /classes and /staff by construction.
 */
export default function SubjectsPage() {
  const [rows, setRows] = useState<SubjectCatalogueEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState('');
  const [onlyGaps, setOnlyGaps] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  // A two-step merge: pick a canonical name for a near-duplicate group, preview the effect
  // (server dry-run), then confirm. Nothing is written until "Confirm merge".
  const [merge, setMerge] = useState<{ group: string[]; toName: string } | null>(null);
  const [preview, setPreview] = useState<SubjectMergeResult | null>(null);
  const [merging, setMerging] = useState(false);

  const load = () =>
    api.subjects.catalogue()
      .then((r) => setRows(r as SubjectCatalogueEntry[]))
      .catch(() => setMsg({ ok: false, text: 'Could not load subjects.' }))
      .finally(() => setLoaded(true));

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const totalGaps = useMemo(() => rows.reduce((n, r) => n + (r.sectionGaps ?? 0), 0), [rows]);
  // Groups of names that look like the same subject. The default canonical is the longest, most
  // "proper-cased" spelling — usually the correct full word (Mathematics over Maths/Mathmetics).
  const dupeGroups = useMemo(() => {
    const names = rows.map((r) => r.name);
    const countOf = (n: string) => rows.find((r) => r.name === n)?.classCount ?? 0;
    return duplicateGroups(names).map((g) => {
      // Default to the spelling used in the most classes — the drifted typo is usually the rarer one —
      // then a proper-cased name over a lower-cased one, then the longer. The office can still override.
      const best = [...g].sort((a, b) => {
        const cap = (s: string) => (/^[A-Z]/.test(s) ? 1 : 0);
        return countOf(b) - countOf(a) || cap(b) - cap(a) || b.length - a.length || a.localeCompare(b);
      })[0];
      return { group: g, best };
    });
  }, [rows]);

  function startMerge(group: string[], best: string) {
    setMsg(null);
    setPreview(null);
    setMerge({ group, toName: best });
  }

  async function runPreview() {
    if (!merge) return;
    const toName = merge.toName.trim();
    if (!toName) return;
    const fromNames = merge.group.filter((n) => n !== toName);
    setMerging(true);
    try {
      setPreview(await api.subjects.merge(fromNames, toName, true));
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not preview the merge.' });
      setMerge(null);
    } finally { setMerging(false); }
  }

  async function confirmMerge() {
    if (!merge) return;
    const toName = merge.toName.trim();
    const fromNames = merge.group.filter((n) => n !== toName);
    setMerging(true);
    try {
      const r = await api.subjects.merge(fromNames, toName, false);
      setMerge(null);
      setPreview(null);
      await load();
      setMsg({ ok: true, text: `Merged into “${r.toName}” — ${r.renamed} renamed, ${r.merged} folded in.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not merge the subjects.' });
    } finally { setMerging(false); }
  }

  const shown = rows.filter((r) => {
    if (onlyGaps && !(r.sectionGaps ?? 0)) return false;
    const q = search.trim().toLowerCase();
    if (q && !r.name.toLowerCase().includes(q)) return false;
    return true;
  });

  async function setLoad(subjectId: string, value: string) {
    const raw = value.trim();
    const next = raw === '' ? null : Math.max(1, Math.min(60, Number(raw) || 1));
    setSaving(subjectId);
    setMsg(null);
    try {
      await api.subjects.setLoad(subjectId, next);
      // Re-read so the value shown is the server's, not the keystroke's.
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not save the weekly load.' });
    } finally { setSaving(null); }
  }

  return (
    <div className="stack">
      <h1>Subjects</h1>
      <p className="muted" style={{ margin: 0 }}>
        Every subject the school teaches, across all classes — where it is taught, how many periods a
        week it gets, and where it has no teacher. Periods a week are advisory; the timetable reports
        against them but never blocks.
      </p>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {loaded && rows.length > 0 && (
        <div className="grid">
          <Metric label="Subjects" value={rows.length} />
          <MetricFilter label="Without a teacher" value={totalGaps} alert={totalGaps > 0}
            active={onlyGaps} title="Show only subjects short a teacher somewhere"
            onClick={() => setOnlyGaps(!onlyGaps)} />
        </div>
      )}

      {loaded && dupeGroups.length > 0 && (
        <div className="card stack" style={{ gap: 10 }}>
          <div className="section-title" style={{ margin: 0 }}>Possible duplicates</div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            These names look like the same subject taught under different spellings. Merging folds them
            onto one name — exam results, teacher assignments, timetables and class tests move with it.
          </p>
          {dupeGroups.map(({ group, best }) => (
            <div key={group.join('|')} className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                {group.map((n) => (
                  <span key={n} className="badge" style={{ marginRight: 6 }}>
                    {n} <span className="muted">×{rows.find((r) => r.name === n)?.classCount ?? 0}</span>
                  </span>
                ))}
              </div>
              <button type="button" className="ghost small" onClick={() => startMerge(group, best)}>Merge…</button>
            </div>
          ))}

          {merge && (
            <div className="toast stack" style={{ gap: 8, margin: 0 }} role="group" aria-label="Merge subjects">
              <div className="row" style={{ alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 220 }}>
                  <label htmlFor="merge-to">Keep this name</label>
                  <input id="merge-to" value={merge.toName} onChange={(e) => { setMerge({ ...merge, toName: e.target.value }); setPreview(null); }} />
                </div>
                <span className="muted" style={{ fontSize: 13 }}>
                  Folding in: {merge.group.filter((n) => n !== merge.toName.trim()).join(', ') || '—'}
                </span>
                {!preview
                  ? <button type="button" className="primary small" disabled={merging || !merge.toName.trim()} onClick={runPreview}>Preview</button>
                  : <button type="button" className="primary small" disabled={merging} onClick={confirmMerge}>Confirm merge</button>}
                <button type="button" className="ghost small" disabled={merging} onClick={() => { setMerge(null); setPreview(null); }}>Cancel</button>
              </div>
              {preview && (
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  This will rename <strong>{preview.renamed}</strong> and merge <strong>{preview.merged}</strong> subject
                  {preview.merged === 1 ? '' : 's'} into “{preview.toName}”, moving {preview.examResults} exam result{preview.examResults === 1 ? '' : 's'},
                  {' '}{preview.assignments} teacher assignment{preview.assignments === 1 ? '' : 's'}, {preview.slots} timetable slot{preview.slots === 1 ? '' : 's'},
                  {' '}{preview.sectionLinks} section link{preview.sectionLinks === 1 ? '' : 's'} and {preview.classTests} class test{preview.classTests === 1 ? '' : 's'}. This cannot be undone.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <div className="card stack" style={{ gap: 8 }}>
        <div className="inline-form">
          <div style={{ minWidth: 260 }}>
            <label>Search</label>
            <input placeholder="e.g. Chemistry" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>

        {!loaded ? (
          <p className="muted" style={{ margin: 0 }}>Loading…</p>
        ) : shown.length === 0 ? (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {onlyGaps ? 'Every subject has a teacher everywhere it is taught.' : rows.length === 0 ? 'No subjects yet. Add them on a class.' : `No subject matches “${search}”.`}
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>Taught in · periods a week</th>
                  <th style={{ width: 150 }}>Without a teacher</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.name}>
                    <td><strong>{r.name}</strong></td>
                    <td>
                      {/* Each class the subject is taught in, with its own weekly-load input — the
                          load is per class and legitimately differs between grades. */}
                      <div className="stack" style={{ gap: 4 }}>
                        {(r.classes ?? []).map((c) => (
                          <div key={c.subjectId} className="row" style={{ justifyContent: 'flex-start', gap: 8 }}>
                            <Link href={`/classes/${c.classId}`} style={{ minWidth: 110 }}>{c.className}</Link>
                            <input type="number" min={1} max={60} aria-label={`Periods per week for ${r.name} in ${c.className}`}
                              style={{ width: 72 }} placeholder="—" defaultValue={c.periodsPerWeek ?? ''}
                              disabled={saving === c.subjectId}
                              onBlur={(e) => {
                                const raw = e.target.value.trim();
                                const next = raw === '' ? null : Math.max(1, Math.min(60, Number(raw) || 1));
                                if (next !== (c.periodsPerWeek ?? null)) setLoad(c.subjectId, e.target.value);
                              }} />
                            <span className="muted" style={{ fontSize: 12 }}>/week</span>
                          </div>
                        ))}
                      </div>
                    </td>
                    <td>
                      {(r.sectionGaps ?? 0) > 0
                        ? <span className="badge warn">{r.sectionGaps} section{r.sectionGaps === 1 ? '' : 's'}</span>
                        : <span className="muted" style={{ fontSize: 13 }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
