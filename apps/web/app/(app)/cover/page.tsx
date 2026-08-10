'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type CoverRow, type ManagedTeacher, type TimetableCoverage } from '@/lib/api';

/**
 * Cover — who is taking a class today (Cover Plan, C0 / §4.1).
 *
 * **Three fields, and nothing to set up first.** Section, day, who is covering. No timetable, no
 * staff attendance — both make this faster in later phases, and neither is a prerequisite, because
 * a school that keeps neither is exactly the school that still needs a substitute to be able to
 * mark the register.
 *
 * The screen is deliberately small. Recording cover is a thirty-second job the office does while
 * standing up, and the outcome that matters happens elsewhere: the covering teacher's *Mark this
 * register* button starts working.
 */
const today = () => new Date().toISOString().slice(0, 10);
const staffName = (s: { fullName: string | null; employeeCode: string }) => s.fullName ?? s.employeeCode;

export default function CoverPage() {
  const [date, setDate] = useState(today());
  const [rows, setRows] = useState<CoverRow[]>([]);
  const [sections, setSections] = useState<TimetableCoverage['sections']>([]);
  const [staff, setStaff] = useState<ManagedTeacher[]>([]);
  const [f, setF] = useState({ sectionId: '', coveringStaffId: '', absentStaffId: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try { setRows((await api.cover.list(date)).cover); }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not load cover.' }); }
  }, [date]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    // `timetable/coverage` is simply the cheapest list of every section with a readable name —
    // it needs no timetable rows to answer, only sections.
    api.timetable.coverage().then((c) => setSections(c.sections)).catch(() => {});
    api.staff.list().then(setStaff).catch(() => {});
  }, []);

  async function save() {
    if (!f.sectionId || !f.coveringStaffId) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.cover.create({
        sectionId: f.sectionId, date, coveringStaffId: f.coveringStaffId,
        absentStaffId: f.absentStaffId || undefined,
        reason: f.reason.trim() || undefined,
      });
      setF({ sectionId: '', coveringStaffId: '', absentStaffId: '', reason: '' });
      await load();
      setMsg({ ok: true, text: 'Cover recorded — they can mark that register now.' });
    } catch (e) {
      // Shown verbatim: the server names who is already covering, or says the payroll month is
      // settled. Both are things the office can act on; "Failed" is not.
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not record that.' });
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    setMsg(null);
    try { await api.cover.remove(id); await load(); setMsg({ ok: true, text: 'Cover removed.' }); }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not remove that.' }); }
  }

  const activeStaff = staff.filter((s) => s.employmentStatus === 'ACTIVE');

  return (
    <div className="stack">
      <h1>Cover</h1>
      <p className="muted" style={{ margin: 0 }}>
        When a teacher is away, record who is taking their class. Until you do, the person standing
        in that room can&apos;t mark the register — only an admin can.
      </p>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <div className="card stack">
        <div className="inline-form">
          <div><label>Day</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div style={{ minWidth: 190 }}><label>Class</label>
            <select value={f.sectionId} onChange={(e) => setF({ ...f, sectionId: e.target.value })}>
              <option value="">Select…</option>
              {sections.map((s) => (
                <option key={s.sectionId} value={s.sectionId}>{s.className}-{s.sectionName}</option>
              ))}
            </select>
          </div>
          <div style={{ minWidth: 190 }}><label>Covered by</label>
            <select value={f.coveringStaffId} onChange={(e) => setF({ ...f, coveringStaffId: e.target.value })}>
              <option value="">Select…</option>
              {activeStaff.map((s) => <option key={s.id} value={s.id}>{s.fullName ?? s.employeeCode}</option>)}
            </select>
          </div>
          {/* Optional, and it says so: a class can need someone for reasons the register does not
              know, and demanding an absentee would make the office invent one. */}
          <div style={{ minWidth: 170 }}><label>Instead of (optional)</label>
            <select value={f.absentStaffId} onChange={(e) => setF({ ...f, absentStaffId: e.target.value })}>
              <option value="">—</option>
              {activeStaff.map((s) => <option key={s.id} value={s.id}>{s.fullName ?? s.employeeCode}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 160 }}><label>Because (optional)</label>
            <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Sick, training…" />
          </div>
          <button onClick={save} disabled={!f.sectionId || !f.coveringStaffId || busy} style={{ minHeight: 44 }}>
            {busy ? 'Saving…' : 'Record cover'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="section-title">Covered on {new Date(date).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        {rows.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Nobody is covering a class this day.</p>
        ) : (
          <ul className="day-rail">
            {rows.map((r) => (
              <li key={r.id} style={{ gridTemplateColumns: '1fr auto', alignItems: 'center' }}>
                <span>
                  <span className="what">
                    <strong>{r.section.class.name}-{r.section.name}</strong>
                    {r.periodNo ? ` · period ${r.periodNo}` : ' · all day'} — {staffName(r.coveringStaff)}
                  </span>
                  {(r.absentStaff || r.reason) && (
                    <><br /><span className="where">
                      {r.absentStaff ? `instead of ${staffName(r.absentStaff)}` : ''}
                      {r.absentStaff && r.reason ? ' · ' : ''}{r.reason ?? ''}
                    </span></>
                  )}
                </span>
                <button className="ghost small" style={{ color: '#b91c1c' }} onClick={() => remove(r.id)}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
