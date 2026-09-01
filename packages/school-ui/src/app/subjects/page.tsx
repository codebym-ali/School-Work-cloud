'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, type SubjectCatalogueEntry } from '@sw/api-client';
import { Metric, MetricFilter } from '@sw/ui';

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

  const load = () =>
    api.subjects.catalogue()
      .then((r) => setRows(r as SubjectCatalogueEntry[]))
      .catch(() => setMsg({ ok: false, text: 'Could not load subjects.' }))
      .finally(() => setLoaded(true));

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const totalGaps = useMemo(() => rows.reduce((n, r) => n + (r.sectionGaps ?? 0), 0), [rows]);

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
