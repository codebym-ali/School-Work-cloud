'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type ManagedTeacher, type SectionTimetable, type Subject, type TimetableCoverage } from '@/lib/api';
import { DAY_SHORT, byCell, periodTime, teacherLabel, weekShape } from '@/lib/timetable';

/**
 * Timetable editor (§23 "teacher assignments & timetable editor (clash warnings)").
 *
 * **Clashes are the server's answer, not this screen's guess.** The rule — one teacher cannot be
 * in two sections in the same period — needs every other section's grid to evaluate, so checking
 * it here would mean loading the whole school and reimplementing the check in a second place. The
 * cell posts, and whatever the API says is shown verbatim, including which class already has that
 * teacher. That is also why the error is worth reading rather than a generic "conflict".
 *
 * The grid's size comes from the school's DECLARED day (`weekShape`) when it has one, and falls
 * back to inferring it from the data when it does not — so a school running Monday–Saturday over ten
 * periods is not squeezed into someone else's idea of a week, and a short Friday shows as short
 * rather than as four empty cells nobody is meant to fill.
 */
export default function TimetablePage() {
  const [coverage, setCoverage] = useState<TimetableCoverage | null>(null);
  const [sectionId, setSectionId] = useState('');
  const [grid, setGrid] = useState<SectionTimetable | null>(null);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [staff, setStaff] = useState<ManagedTeacher[]>([]);
  const [editing, setEditing] = useState<{ day: number; period: number } | null>(null);
  const [draft, setDraft] = useState({ subjectId: '', staffId: '', room: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copyFrom, setCopyFrom] = useState(1);
  const [copyTo, setCopyTo] = useState<number[]>([]);
  const [skipped, setSkipped] = useState<Array<{ dayOfWeek: number; periodNo: number; reason: string }>>([]);

  useEffect(() => {
    api.timetable.coverage().then((c) => {
      setCoverage(c);
      if (c.sections.length && !sectionId) setSectionId(c.sections[0].sectionId);
    }).catch(() => setMsg({ ok: false, text: 'Could not load sections.' }));
    api.staff.list().then(setStaff).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    if (!sectionId) return;
    try {
      const g = await api.timetable.forSection(sectionId);
      setGrid(g);
      // Only this class's subjects can be scheduled — the API refuses anything else, so offering
      // a wider list would just be inviting a 422.
      setSubjects(await api.subjects.list(g.section.class.id));
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not load the timetable.' });
    }
  }, [sectionId]);
  useEffect(() => { load(); }, [load]);

  async function save() {
    if (!editing || !draft.subjectId || !draft.staffId) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.timetable.setSlot({
        sectionId, dayOfWeek: editing.day, periodNo: editing.period,
        subjectId: draft.subjectId, staffId: draft.staffId,
        room: draft.room.trim() || undefined,
      });
      setEditing(null);
      await load();
      setMsg({ ok: true, text: 'Period saved.' });
    } catch (e) {
      // Shown as-is: the server names the clashing class and period, which is the only version of
      // this message anyone can act on.
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not save that period.' });
    } finally { setBusy(false); }
  }

  /**
   * Copy one day's lessons onto others — 60 saves instead of 720 on a 15-section school.
   *
   * A partial copy is the ordinary outcome once a week is half built, so the result is reported
   * rather than treated as success-or-failure: the skipped cells are listed with the server's own
   * reason, which names the clashing class or the day that is too short.
   */
  async function copyDay() {
    if (!copyFrom || copyTo.length === 0) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.timetable.copyDay({ sectionId, fromDay: copyFrom, toDays: copyTo });
      await load();
      setCopyTo([]);
      setSkipped(res.skipped);
      setMsg({
        ok: true,
        text: res.skipped.length
          ? `Copied ${res.created} ${res.created === 1 ? 'lesson' : 'lessons'}. ${res.skipped.length} could not be placed.`
          : `Copied ${res.created} ${res.created === 1 ? 'lesson' : 'lessons'}.`,
      });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not copy that day.' });
    } finally { setBusy(false); }
  }

  async function clear(id: string) {
    setMsg(null);
    try { await api.timetable.clearSlot(id); await load(); setMsg({ ok: true, text: 'Period cleared.' }); }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not clear that period.' }); }
  }

  const cells = byCell(grid?.slots ?? []);
  const bell = grid?.bell ?? null;
  const { days, periods, periodsByDay, declared } = weekShape(bell, grid?.slots ?? []);
  const staffOptions = staff.filter((s) => s.employmentStatus === 'ACTIVE');
  /** A period a given day does not have. Not an empty cell — a cell that does not exist. */
  const outsideDay = (d: number, p: number) => periodsByDay !== null && p > (periodsByDay.get(d) ?? 0);

  return (
    <div className="stack">
      <h1>Timetable</h1>
      <p className="muted" style={{ margin: 0 }}>
        One section&apos;s week. A teacher can&apos;t be given two classes in the same period — if
        that happens you&apos;ll be told which class already has them.
      </p>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <div className="card stack" style={{ gap: 8 }}>
        <div className="inline-form">
          <div style={{ minWidth: 240 }}>
            <label>Section</label>
            <select value={sectionId} onChange={(e) => { setSectionId(e.target.value); setEditing(null); }}>
              {coverage?.sections.map((s) => (
                <option key={s.sectionId} value={s.sectionId}>
                  {s.className}-{s.sectionName}{s.slots === 0 ? ' — no timetable yet' : ` — ${s.slots} periods`}
                </option>
              ))}
            </select>
          </div>
        </div>
        {/* "Not built yet" and "built and empty" look identical on a blank grid, and only the
            first is worth chasing — so the count says which this is. */}
        {coverage && coverage.sections.every((s) => s.slots === 0) && (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            No section has a timetable yet. Pick a section and click any cell to start.
          </p>
        )}
        {/* Which shape this grid is: the school's declared day, or the old guess. The difference
            matters — under a guess, "period 7" exists only because somebody typed into it. */}
        {grid && (declared
          ? <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              Periods and times come from <strong>{bell?.name}</strong>. A day shows only the periods
              it actually has. <a href="/timings">Change the timings →</a>
            </p>
          : <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              No timings set for this campus, so the grid is guessing how many periods there are and
              cannot show when they run. <a href="/timings">Set the school timings →</a>
            </p>)}
      </div>

      {/* Advisory, and it says so. A coordinator allocates the load first and places it second;
          before this, nothing could tell them a week was two Maths periods short until November.
          Nothing here refuses anything — overshooting mid-build then rebalancing is normal. */}
      {grid && grid.slots.length > 0 && (
        <div className="card stack" style={{ gap: 8 }}>
          <div className="section-title" style={{ margin: 0 }}>Copy a day</div>
          <div className="inline-form">
            <div style={{ minWidth: 150 }}>
              <label htmlFor="tt-copy-from">From</label>
              <select id="tt-copy-from" value={copyFrom} onChange={(e) => setCopyFrom(Number(e.target.value))}>
                {days.map((d) => <option key={d} value={d}>{DAY_SHORT[d]}</option>)}
              </select>
            </div>
            <div className="stack" style={{ gap: 4 }}>
              <label>To</label>
              <div className="chips">
                {days.filter((d) => d !== copyFrom).map((d) => (
                  <button key={d} type="button" className={copyTo.includes(d) ? 'small' : 'ghost small'}
                    aria-pressed={copyTo.includes(d)}
                    onClick={() => setCopyTo(copyTo.includes(d) ? copyTo.filter((x) => x !== d) : [...copyTo, d])}>
                    {DAY_SHORT[d]}
                  </button>
                ))}
              </div>
            </div>
            <button disabled={busy || copyTo.length === 0} onClick={copyDay}>{busy ? 'Copying…' : 'Copy'}</button>
          </div>
          {/* Nothing is overwritten, and saying so up front is the difference between a button
              people use and one they are afraid of. */}
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            Lessons already on the target day are kept — nothing is overwritten.
          </p>
          {skipped.length > 0 && (
            <ul className="muted" style={{ margin: 0, fontSize: 12, paddingLeft: 18 }}>
              {skipped.map((s, i) => <li key={i}>{s.reason}</li>)}
            </ul>
          )}
        </div>
      )}

      {grid && grid.load.some((l) => l.target !== null) && (
        <div className="card stack" style={{ gap: 6 }}>
          <div className="section-title" style={{ margin: 0 }}>Weekly load</div>
          <div className="chips">
            {grid.load.filter((l) => l.target !== null).map((l) => {
              const short = l.placed < (l.target ?? 0);
              const over = l.placed > (l.target ?? 0);
              return (
                <span key={l.subjectId} className="chip"
                  title={short ? `${(l.target ?? 0) - l.placed} still to place` : over ? 'More than allocated' : 'Complete'}
                  style={over ? { color: 'var(--accent-ink)' } : short ? undefined : { color: 'var(--ok-ink)' }}>
                  {l.name} — {l.placed} of {l.target}
                </span>
              );
            })}
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            Advisory only — nothing is refused. Set a subject&apos;s weekly periods on{' '}
            <a href="/setup">School configuration</a>.
          </p>
        </div>
      )}

      {grid && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 70 }}>Period</th>
                {days.map((d) => <th key={d}>{DAY_SHORT[d]}</th>)}
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p}>
                  <td><strong>{p}</strong></td>
                  {days.map((d) => {
                    const slot = cells.get(`${d}:${p}`);
                    const isEditing = editing?.day === d && editing?.period === p;
                    const time = periodTime(bell, d, p);
                    if (outsideDay(d, p)) {
                      // The honest rendering of a short Friday: the cell is absent, not empty. An
                      // empty clickable cell would invite a lesson the API would then refuse.
                      return (
                        <td key={d} className="muted" style={{ verticalAlign: 'top', minWidth: 150, textAlign: 'center' }}
                          aria-label={`${DAY_SHORT[d]} has no period ${p}`}>
                          —
                        </td>
                      );
                    }
                    return (
                      <td key={d} style={{ verticalAlign: 'top', minWidth: 150 }}>
                        {time && (
                          <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>
                            {time.startTime}–{time.endTime}
                          </div>
                        )}
                        {isEditing ? (
                          <div className="stack" style={{ gap: 4 }}>
                            <select value={draft.subjectId} onChange={(e) => setDraft({ ...draft, subjectId: e.target.value })}>
                              <option value="">Subject…</option>
                              {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                            <select value={draft.staffId} onChange={(e) => setDraft({ ...draft, staffId: e.target.value })}>
                              <option value="">Teacher…</option>
                              {staffOptions.map((s) => (
                                <option key={s.id} value={s.id}>{s.fullName ?? s.employeeCode}</option>
                              ))}
                            </select>
                            <input placeholder="Room (optional)" value={draft.room}
                              onChange={(e) => setDraft({ ...draft, room: e.target.value })} />
                            <div className="chips">
                              <button className="small" disabled={!draft.subjectId || !draft.staffId || busy} onClick={save}>
                                {busy ? 'Saving…' : 'Save'}
                              </button>
                              <button className="ghost small" onClick={() => setEditing(null)}>Cancel</button>
                            </div>
                          </div>
                        ) : slot ? (
                          <div className="stack" style={{ gap: 2 }}>
                            <strong style={{ fontSize: 13 }}>{slot.subject.name}</strong>
                            <span className="muted" style={{ fontSize: 12 }}>{teacherLabel(slot)}</span>
                            {slot.room && <span className="muted" style={{ fontSize: 12 }}>{slot.room}</span>}
                            <div className="chips">
                              <button className="ghost small" onClick={() => {
                                setEditing({ day: d, period: p });
                                setDraft({ subjectId: slot.subject.id, staffId: slot.staff.id, room: slot.room ?? '' });
                              }}>Edit</button>
                              <button className="ghost small" style={{ color: '#b91c1c' }} onClick={() => clear(slot.id)}>Clear</button>
                            </div>
                          </div>
                        ) : (
                          <button className="ghost small" onClick={() => {
                            setEditing({ day: d, period: p });
                            setDraft({ subjectId: '', staffId: '', room: '' });
                          }}>+ Add</button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
