'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type ClassTest, type ClassTestDetail, type RosterRow } from '@/lib/api';

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Class tests for one (section, subject) the teacher is assigned to.
 *
 * The whole job is two steps: set a test (name + what it's out of), then put a number against
 * each name. Everything else — weightage, terms, publishing — belongs to the exam system and is
 * deliberately absent here, because a class test never reaches a report card.
 */
export function ClassTestsPanel({ sectionId, subjectId, subjectName, roster, onMsg }: {
  sectionId: string;
  subjectId: string;
  subjectName: string;
  roster: RosterRow[];
  onMsg: (ok: boolean, text: string) => void;
}) {
  const [tests, setTests] = useState<ClassTest[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ClassTestDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', totalMarks: '', testDate: today() });
  const [entry, setEntry] = useState<Record<string, { marks: string; absent: boolean }>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const all = await api.classTests.list(sectionId);
      setTests(all.filter((t) => t.subjectId === subjectId));
    } catch {
      setTests([]);
    }
  }, [sectionId, subjectId]);
  useEffect(() => { load(); }, [load]);

  async function openTest(id: string) {
    if (openId === id) { setOpenId(null); setDetail(null); return; }
    setOpenId(id);
    const d = await api.classTests.get(id);
    setDetail(d);
    // Seed the inputs from stored marks so an edit starts from what's already recorded rather
    // than from blank — retyping a whole register to fix one number is how mistakes happen.
    const seeded: Record<string, { marks: string; absent: boolean }> = {};
    for (const r of roster) {
      const s = d.scores.find((x) => x.enrollmentId === r.enrollmentId);
      seeded[r.enrollmentId] = { marks: s?.marksObtained != null ? String(Number(s.marksObtained)) : '', absent: s?.isAbsent ?? false };
    }
    setEntry(seeded);
  }

  async function create() {
    const total = Number(form.totalMarks);
    if (!form.name.trim() || !Number.isFinite(total) || total <= 0) return;
    setBusy(true);
    try {
      await api.classTests.create({ sectionId, subjectId, name: form.name.trim(), totalMarks: total, testDate: form.testDate });
      setForm({ name: '', totalMarks: '', testDate: today() });
      setCreating(false);
      await load();
      onMsg(true, 'Test added — now enter the marks');
    } catch (e) {
      onMsg(false, e instanceof ApiError ? e.message : 'Could not add the test');
    } finally {
      setBusy(false);
    }
  }

  async function saveMarks() {
    if (!detail) return;
    setBusy(true);
    try {
      const rows = roster
        .map((r) => {
          const v = entry[r.enrollmentId];
          if (!v) return null;
          if (v.absent) return { enrollmentId: r.enrollmentId, isAbsent: true };
          if (v.marks.trim() === '') return null; // not yet entered — leave it alone
          return { enrollmentId: r.enrollmentId, marksObtained: Number(v.marks) };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      if (!rows.length) return onMsg(false, 'Nothing to save yet');

      const res = await api.classTests.setScores(detail.id, rows);
      await load();
      const d = await api.classTests.get(detail.id);
      setDetail(d);
      onMsg(res.failed === 0, res.failed === 0
        ? `Saved ${res.saved} mark${res.saved === 1 ? '' : 's'}`
        : `Saved ${res.saved}, ${res.failed} rejected — ${res.errors[0]?.message ?? ''}`);
    } catch (e) {
      onMsg(false, e instanceof ApiError ? e.message : 'Could not save marks');
    } finally {
      setBusy(false);
    }
  }

  async function remove(t: ClassTest) {
    if (!confirm(`Delete “${t.name}”?`)) return;
    try {
      await api.classTests.remove(t.id);
      if (openId === t.id) { setOpenId(null); setDetail(null); }
      await load();
      onMsg(true, 'Test deleted');
    } catch (e) {
      onMsg(false, e instanceof ApiError ? e.message : 'Could not delete the test');
    }
  }

  const total = detail ? Number(detail.totalMarks) : 0;
  const entered = detail ? roster.filter((r) => entry[r.enrollmentId]?.absent || entry[r.enrollmentId]?.marks.trim() !== '').length : 0;

  // Class summary, computed on what's entered. Absences are excluded — a sick child is not a
  // failing child, and counting them as 0 would drag the class average down dishonestly.
  const marks = detail
    ? roster.map((r) => entry[r.enrollmentId]).filter((v) => v && !v.absent && v.marks.trim() !== '').map((v) => Number(v!.marks))
    : [];
  const avg = marks.length ? Math.round((marks.reduce((a, b) => a + b, 0) / marks.length / total) * 100) : null;
  const below40 = total ? marks.filter((m) => (m / total) * 100 < 40).length : 0;

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row">
        <strong style={{ fontSize: 14 }}>{subjectName} tests</strong>
        <button className="ghost small" onClick={() => setCreating((v) => !v)}>{creating ? 'Cancel' : '+ New test'}</button>
      </div>

      {creating && (
        <div className="inline-form" style={{ alignItems: 'flex-end' }}>
          <div style={{ minWidth: 180 }}><label>Test name</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Chapter 3 quiz" />
          </div>
          <div style={{ maxWidth: 120 }}><label>Out of</label>
            <input type="number" min={1} value={form.totalMarks}
              onChange={(e) => setForm({ ...form, totalMarks: e.target.value })} placeholder="20" />
          </div>
          <div style={{ maxWidth: 160 }}><label>Date</label>
            <input type="date" max={today()} value={form.testDate} onChange={(e) => setForm({ ...form, testDate: e.target.value })} />
          </div>
          <button disabled={busy || !form.name.trim() || !form.totalMarks} onClick={create}>Add test</button>
        </div>
      )}

      {tests === null ? <p className="muted" style={{ margin: 0, fontSize: 13 }}>Loading…</p>
        : tests.length === 0 ? (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            No tests yet for {subjectName}. Add one above, then put a mark against each name.
          </p>
        ) : (
          <div className="chips">
            {tests.map((t) => (
              <span key={t.id} className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <button type="button" className="ghost small" style={{ padding: '2px 6px' }} onClick={() => openTest(t.id)}>
                  {t.name} · /{Number(t.totalMarks)} · {new Date(t.testDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                  {(t.scoreCount ?? 0) > 0 && <span className="muted"> · {t.scoreCount} marked</span>}
                </button>
                <button type="button" className="ghost small" style={{ padding: '2px 6px', color: '#b91c1c' }} onClick={() => remove(t)}>✕</button>
              </span>
            ))}
          </div>
        )}

      {detail && (
        <div className="card stack" style={{ gap: 8 }}>
          <div className="row">
            <strong style={{ fontSize: 14 }}>{detail.name} — out of {total}</strong>
            <span className="muted" style={{ fontSize: 12 }}>{entered} of {roster.length} entered</span>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>Roll</th><th>Student</th><th>Marks</th><th>Absent</th></tr></thead>
              <tbody>
                {roster.map((r) => {
                  const v = entry[r.enrollmentId] ?? { marks: '', absent: false };
                  const over = !v.absent && v.marks !== '' && Number(v.marks) > total;
                  return (
                    <tr key={r.enrollmentId}>
                      <td>{r.rollNumber ?? '—'}</td>
                      <td>{r.fullName}</td>
                      <td>
                        <input type="number" min={0} max={total} value={v.marks} disabled={v.absent}
                          style={{ width: 90, ...(over ? { borderColor: '#b91c1c' } : {}) }}
                          onChange={(e) => setEntry({ ...entry, [r.enrollmentId]: { ...v, marks: e.target.value } })} />
                        {over && <span style={{ color: '#b91c1c', fontSize: 11, marginLeft: 6 }}>over {total}</span>}
                      </td>
                      <td>
                        <input type="checkbox" checked={v.absent}
                          onChange={(e) => setEntry({ ...entry, [r.enrollmentId]: { marks: e.target.checked ? '' : v.marks, absent: e.target.checked } })} />
                      </td>
                    </tr>
                  );
                })}
                {roster.length === 0 && <tr><td colSpan={4} className="muted">No students enrolled.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="row">
            <button disabled={busy} onClick={saveMarks}>{busy ? 'Saving…' : 'Save marks'}</button>
            {avg !== null && (
              <span className="muted" style={{ fontSize: 12 }}>
                Class average <b>{avg}%</b>{below40 > 0 && <> · <span style={{ color: '#b91c1c' }}>{below40} below 40%</span></>}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
