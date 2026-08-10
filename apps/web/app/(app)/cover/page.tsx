'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type AwayToday, type CoverRow, type ManagedTeacher, type TimetableCoverage } from '@/lib/api';

/**
 * Cover — who is taking a class today (Cover Plan, C0 §4.1 + C1).
 *
 * **Three fields, and nothing to set up first.** Section, day, who is covering. No timetable, no
 * staff attendance — both make this faster, and neither is a prerequisite, because a school that
 * keeps neither is exactly the school that still needs a substitute to be able to mark the register.
 *
 * **C1 adds the half that removes the remembering.** *Away today* is derived from the staff register
 * and approved leave; each away teacher's classes come from their assignments. Clicking one fills
 * the form, so the office picks from a list instead of reconstructing the morning from two other
 * screens. When a class is already covered the row says by whom, so what is left is what is shown.
 *
 * The outcome that matters happens elsewhere: the covering teacher's *Mark this register* button
 * starts working.
 */
const today = () => new Date().toISOString().slice(0, 10);
const staffName = (s: { fullName: string | null; employeeCode: string }) => s.fullName ?? s.employeeCode;
const longDate = (d: string) =>
  new Date(d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

export default function CoverPage() {
  const [date, setDate] = useState(today());
  const [rows, setRows] = useState<CoverRow[]>([]);
  const [away, setAway] = useState<AwayToday | null>(null);
  const [sections, setSections] = useState<TimetableCoverage['sections']>([]);
  const [staff, setStaff] = useState<ManagedTeacher[]>([]);
  const [f, setF] = useState({ sectionId: '', coveringStaffId: '', absentStaffId: '', reason: '', toDate: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [cover, aw] = await Promise.all([api.cover.list(date), api.cover.away(date)]);
      setRows(cover.cover);
      setAway(aw);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not load cover.' });
    }
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
    const body = {
      sectionId: f.sectionId, coveringStaffId: f.coveringStaffId,
      absentStaffId: f.absentStaffId || undefined,
      reason: f.reason.trim() || undefined,
    };
    try {
      if (f.toDate && f.toDate !== date) {
        const res = await api.cover.range({ ...body, fromDate: date, toDate: f.toDate });
        // A range answers with what it did AND did not do — a closure in the middle, or a day
        // somebody else already has. Reporting only the successes would leave a gap the office
        // finds out about on the day.
        setMsg({
          ok: res.created.length > 0,
          text: [
            `${res.created.length} day${res.created.length === 1 ? '' : 's'} covered.`,
            ...res.skipped.map((s) => `${s.date}: ${s.reason}`),
          ].join(' · '),
        });
      } else {
        await api.cover.create({ ...body, date });
        setMsg({ ok: true, text: 'Cover recorded — they can mark that register now.' });
      }
      setF({ sectionId: '', coveringStaffId: '', absentStaffId: '', reason: '', toDate: '' });
      await load();
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
  const needsCover = (away?.away ?? []).flatMap((a) =>
    a.sections.filter((s) => !s.coveredBy).map((s) => ({ ...s, staff: a })));

  return (
    <div className="stack">
      <h1>Cover</h1>
      <p className="muted" style={{ margin: 0 }}>
        When a teacher is away, record who is taking their class. Until you do, the person standing
        in that room can&apos;t mark the register — only an admin can.
      </p>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <div className="card">
        <div className="section-title">Away on {longDate(date)} {away && away.away.length > 0 ? `· ${away.away.length}` : ''}</div>
        {!away ? null : away.away.length === 0 ? (
          // Never a bare "nobody is away": on a morning before the register is marked that is a
          // guess dressed as a fact, and the office would trust it and stop looking.
          <p className="muted" style={{ margin: 0 }}>
            {away.staffRegisterMarked
              ? 'Nobody with classes is marked absent or on leave.'
              : 'The staff register isn’t marked for this day yet, so this only knows about approved leave — record cover below if you know someone is away.'}
          </p>
        ) : (
          <ul className="day-rail">
            {away.away.map((a) => (
              <li key={a.staffId} style={{ gridTemplateColumns: '1fr' }}>
                <span className="what"><strong>{staffName(a)}</strong> — {a.reason}</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {a.sections.map((s) => (
                    <button
                      key={s.sectionId}
                      className="ghost small"
                      disabled={Boolean(s.coveredBy)}
                      // One click fills the form: the class, and who it is instead of. The office
                      // then chooses one name, which is the only thing it actually has to decide.
                      onClick={() => setF({ ...f, sectionId: s.sectionId, absentStaffId: a.staffId })}
                      title={s.coveredBy ? `${s.coveredBy} is covering this` : 'Arrange cover for this class'}
                    >
                      {s.className}-{s.sectionName}{s.coveredBy ? ` · ${s.coveredBy}` : ' · needs cover'}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
        {needsCover.length > 0 && (
          <p className="muted" style={{ margin: '8px 0 0' }}>
            {needsCover.length} class{needsCover.length === 1 ? '' : 'es'} still need someone.
          </p>
        )}
      </div>

      <div className="card stack">
        <div className="inline-form">
          <div><label>Day</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          {/* Optional, and empty by default: most cover is one day, and a school with a teacher off
              until Thursday should not have to enter it four times. */}
          <div><label>Until (optional)</label>
            <input type="date" value={f.toDate} min={date} onChange={(e) => setF({ ...f, toDate: e.target.value })} />
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
            {busy ? 'Saving…' : f.toDate && f.toDate !== date ? 'Record for those days' : 'Record cover'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="section-title">Covered on {longDate(date)}</div>
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
