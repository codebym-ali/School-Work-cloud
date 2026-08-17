'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, apiGet, type BellSchedule, type Campus, type Klass } from '@/lib/api';
import { DAY_NAMES, DAY_SHORT } from '@/lib/timetable';
import { type DraftRow, daySummary, previewDay } from '@/lib/timings';

/**
 * School timings — the screen that declares what a school day looks like.
 *
 * Before this existed, `periodNo` was a bare ordinal: the timetable could say *what* happens in
 * period 3 and never *when*, breaks could not be represented at all, and the grid guessed a class's
 * period count from `max(periodNo)` over whatever had already been typed. Every one of those is a
 * consequence of the day never having been declared anywhere.
 *
 * ⚠️ **The admin types durations, never times.** The day is walked from its start, here for the
 * preview and on the server for the save, so a gap or an overlap between rows is not something this
 * screen validates — it is something neither the screen nor the API can express.
 */
export default function TimingsPage() {
  const [schedules, setSchedules] = useState<BellSchedule[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [scheduleId, setScheduleId] = useState('');
  const [day, setDay] = useState(1);
  const [startsAt, setStartsAt] = useState('08:00');
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [copyTo, setCopyTo] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [newName, setNewName] = useState('Regular');
  const [newCampus, setNewCampus] = useState('');
  const [classes, setClasses] = useState<Klass[]>([]);
  const [wingName, setWingName] = useState('');
  const [wingClasses, setWingClasses] = useState<string[]>([]);
  const [showWing, setShowWing] = useState(false);

  const schedule = schedules.find((s) => s.id === scheduleId) ?? null;

  const load = useCallback(async (keepId?: string) => {
    try {
      const res = await api.bellSchedules.list();
      setSchedules(res.schedules);
      const next = keepId ?? scheduleId;
      const chosen = res.schedules.find((s) => s.id === next) ?? res.schedules[0];
      if (chosen) setScheduleId(chosen.id);
      else setScheduleId('');
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not load the timings.' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
    api.campuses.list().then((c) => { setCampuses(c); if (c[0]) setNewCampus(c[0].id); }).catch(() => {});
    apiGet<Klass[]>('/classes').then(setClasses).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Whenever the chosen schedule or day changes, the draft is reloaded FROM THE SERVER'S rows —
  // never carried over. Editing Monday and clicking Tuesday must not silently paste Monday into it.
  useEffect(() => {
    const d = schedule?.days.find((x) => x.dayOfWeek === day);
    setStartsAt(d?.startsAt ?? '08:00');
    setRows(
      (d?.rows ?? []).map((r) => ({
        isTeaching: r.isTeaching,
        label: r.label ?? '',
        minutes: minutesBetween(r.startTime, r.endTime),
      })),
    );
    setCopyTo([]);
  }, [scheduleId, day, schedule]);

  const preview = useMemo(() => previewDay(startsAt, rows), [startsAt, rows]);
  const summary = daySummary(preview);
  const overflowing = preview.some((r) => r.overflows);

  function patchRow(i: number, patch: Partial<DraftRow>) {
    setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function move(i: number, by: number) {
    const to = i + by;
    if (to < 0 || to >= rows.length) return;
    const next = [...rows];
    [next[i], next[to]] = [next[to], next[i]];
    setRows(next);
  }

  async function saveDay() {
    if (!schedule) return;
    setBusy(true);
    setMsg(null);
    try {
      const body = { startsAt, rows: rows.map((r) => ({ isTeaching: r.isTeaching, label: r.isTeaching ? undefined : (r.label || 'Break'), minutes: r.minutes })) };
      const saved = await api.bellSchedules.setDay(schedule.id, day, body);
      for (const other of copyTo) await api.bellSchedules.setDay(schedule.id, other, body);
      await load(schedule.id);

      // ⚠️ Stated out loud rather than swallowed. Shortening a day is how a school runs Ramadan or
      // an exam week — there is deliberately no dated variant — so it must be obvious that the
      // lessons on the periods just removed are KEPT and will come back, not quietly discarded.
      const copied = copyTo.length ? ` Copied to ${copyTo.length} more ${copyTo.length === 1 ? 'day' : 'days'}.` : '';
      setMsg(saved.retainedLessons > 0
        ? { ok: true, text: `${DAY_NAMES[day]} saved.${copied} ${saved.retainedLessons} lesson${saved.retainedLessons === 1 ? '' : 's'} sit on periods this day no longer has — they are kept, and reappear if you add those periods back.` }
        : { ok: true, text: `${DAY_NAMES[day]} saved.${copied}` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not save that day.' });
    } finally { setBusy(false); }
  }

  /**
   * A wing schedule — Primary out at 12:30 while Secondary runs to 14:00, on one campus.
   *
   * ⚠️ A class may follow exactly ONE schedule, and the server refuses a second naming the first.
   * That is not a tidiness rule: two schedules claiming one class is precisely what would make
   * `periodNo` mean two different things for that class's sections, and it is the invariant that
   * let the seasonal-variant idea be cut rather than modelled.
   */
  async function createWing() {
    const campusId = schedule?.campusId ?? newCampus;
    if (!campusId || !wingName.trim() || wingClasses.length === 0) return;
    setBusy(true);
    setMsg(null);
    try {
      const created = await api.bellSchedules.create({ campusId, name: wingName.trim(), classIds: wingClasses });
      await load(created.id);
      setWingName(''); setWingClasses([]); setShowWing(false);
      setMsg({ ok: true, text: `"${created.name}" created. Compose its days — the classes on it now follow these timings.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not create the wing schedule.' });
    } finally { setBusy(false); }
  }

  async function removeSchedule(id: string, name: string) {
    setBusy(true);
    setMsg(null);
    try {
      await api.bellSchedules.remove(id);
      await load();
      // Nothing is stranded: those classes fall back to the campus default, or to no timings at
      // all — which is a supported state, not a broken one.
      setMsg({ ok: true, text: `"${name}" retired. Its classes now follow the campus default.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not retire that schedule.' });
    } finally { setBusy(false); }
  }

  async function createSchedule() {
    setBusy(true);
    setMsg(null);
    try {
      const created = await api.bellSchedules.create({ campusId: newCampus, name: newName.trim(), isDefault: true });
      await load(created.id);
      setMsg({ ok: true, text: 'Schedule created. Now compose each day.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not create the schedule.' });
    } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <h1>School Timings</h1>
      <p className="muted" style={{ margin: 0 }}>
        What a school day looks like — how many periods, how long, and where the breaks fall. Each
        day is built on its own, so a short Friday is simply fewer rows. The timetable grid renders
        the day you declare here.
      </p>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {schedules.length === 0 ? (
        <div className="card stack" style={{ gap: 8 }}>
          <strong>No timings set yet</strong>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Until a campus has timings, the timetable cannot say when a period runs and has to guess
            how many there are.
          </p>
          <div className="inline-form">
            <div style={{ minWidth: 200 }}>
              <label htmlFor="tm-campus">Campus</label>
              <select id="tm-campus" value={newCampus} onChange={(e) => setNewCampus(e.target.value)}>
                {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div style={{ minWidth: 200 }}>
              <label htmlFor="tm-name">Name</label>
              <input id="tm-name" value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            <button disabled={busy || !newCampus || !newName.trim()} onClick={createSchedule}>
              {busy ? 'Creating…' : 'Create timings'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="card stack" style={{ gap: 8 }}>
            <div className="inline-form">
              <div style={{ minWidth: 300 }}>
                <label htmlFor="tm-schedule">Schedule</label>
                <select id="tm-schedule" value={scheduleId} onChange={(e) => setScheduleId(e.target.value)}>
                  {schedules.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.campusName} — {s.name}{s.isDefault ? ' (campus default)' : ` (${s.classes.length} ${s.classes.length === 1 ? 'class' : 'classes'})`}
                    </option>
                  ))}
                </select>
              </div>
              <button className="ghost small" onClick={() => setShowWing(!showWing)}>
                {showWing ? 'Cancel' : '+ Wing schedule'}
              </button>
              {schedule && !schedule.isDefault && (
                <button className="ghost small" style={{ color: '#b91c1c' }} disabled={busy}
                  onClick={() => removeSchedule(schedule.id, schedule.name)}>Retire</button>
              )}
            </div>

            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {schedule?.isDefault
                ? 'The campus default — every class that is not on a wing schedule follows it.'
                : `Followed by ${schedule?.classes.map((c) => c.name).join(', ') || 'no classes'}.`}
            </p>

            {showWing && (
              <div className="stack" style={{ gap: 8 }}>
                <div className="inline-form">
                  <div style={{ minWidth: 220 }}>
                    <label htmlFor="tm-wing">Name</label>
                    <input id="tm-wing" placeholder="Primary Wing" value={wingName}
                      onChange={(e) => setWingName(e.target.value)} />
                  </div>
                  <button disabled={busy || !wingName.trim() || wingClasses.length === 0} onClick={createWing}>
                    {busy ? 'Creating…' : 'Create'}
                  </button>
                </div>
                <div className="stack" style={{ gap: 4 }}>
                  <label>Classes that follow it</label>
                  <div className="chips">
                    {classes
                      .filter((k) => k.campusId === (schedule?.campusId ?? newCampus))
                      .map((k) => (
                        <button key={k.id} type="button" aria-pressed={wingClasses.includes(k.id)}
                          className={wingClasses.includes(k.id) ? 'small' : 'ghost small'}
                          onClick={() => setWingClasses(wingClasses.includes(k.id)
                            ? wingClasses.filter((x) => x !== k.id) : [...wingClasses, k.id])}>
                          {k.name}
                        </button>
                      ))}
                  </div>
                  <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                    A class can only follow one schedule — picking one already on another wing is
                    refused, and the message names where it sits.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="chips" aria-label="Day">
            {[1, 2, 3, 4, 5, 6, 7].map((d) => {
              const composed = schedule?.days.find((x) => x.dayOfWeek === d);
              const count = composed?.teachingPeriods ?? 0;
              return (
                <button key={d} className={d === day ? 'small' : 'ghost small'} aria-pressed={d === day}
                  onClick={() => setDay(d)}>
                  {DAY_SHORT[d]}{count > 0 ? ` · ${count}` : ''}
                </button>
              );
            })}
          </div>

          <div className="card stack" style={{ gap: 10 }}>
            <div className="inline-form">
              <div style={{ minWidth: 140 }}>
                <label htmlFor="tm-start">Day starts</label>
                <input id="tm-start" type="time" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
              </div>
            </div>

            {rows.length === 0 && (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                {DAY_NAMES[day]} has no periods. Add one below, or leave it empty if the school does
                not teach on {DAY_NAMES[day]}.
              </p>
            )}

            {rows.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 110 }}>Time</th>
                      <th>What</th>
                      <th style={{ width: 110 }}>Minutes</th>
                      <th style={{ width: 150 }}>Order</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((r, i) => (
                      <tr key={i} style={r.overflows ? { color: '#b91c1c' } : undefined}>
                        <td><code>{r.startTime}–{r.endTime}</code></td>
                        <td>
                          {r.isTeaching
                            ? <strong>Period {r.periodNo}</strong>
                            : <input aria-label={`Break name, row ${i + 1}`} value={rows[i].label}
                                placeholder="Break" onChange={(e) => patchRow(i, { label: e.target.value })} />}
                        </td>
                        <td>
                          <input aria-label={`Minutes, row ${i + 1}`} type="number" min={1} max={240}
                            value={rows[i].minutes}
                            onChange={(e) => patchRow(i, { minutes: Math.max(1, Number(e.target.value) || 1) })} />
                        </td>
                        <td>
                          <div className="chips">
                            <button className="ghost small" aria-label={`Move row ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                            <button className="ghost small" aria-label={`Move row ${i + 1} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>↓</button>
                            <button className="ghost small" style={{ color: '#b91c1c' }} aria-label={`Remove row ${i + 1}`}
                              onClick={() => setRows(rows.filter((_, idx) => idx !== i))}>Remove</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="chips">
              <button className="ghost small" onClick={() => setRows([...rows, { isTeaching: true, label: '', minutes: 40 }])}>+ Add period</button>
              <button className="ghost small" onClick={() => setRows([...rows, { isTeaching: false, label: 'Break', minutes: 15 }])}>+ Add break</button>
            </div>

            {/* The footer states what the day IS, because "ends at 13:40 with 7 teaching periods" is
                the number a coordinator is trying to hit — not the individual durations. */}
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {rows.length === 0
                ? 'No periods on this day.'
                : <>Day ends <strong>{summary.endsAt}</strong> · <strong>{summary.teaching}</strong> teaching {summary.teaching === 1 ? 'period' : 'periods'}</>}
            </p>
            {overflowing && (
              <p className="toast err" style={{ margin: 0 }}>This day runs past midnight. Shorten a row before saving.</p>
            )}

            <div className="stack" style={{ gap: 6 }}>
              <label>Also copy these timings to</label>
              <div className="chips">
                {[1, 2, 3, 4, 5, 6, 7].filter((d) => d !== day).map((d) => (
                  <button key={d} className={copyTo.includes(d) ? 'small' : 'ghost small'} aria-pressed={copyTo.includes(d)}
                    onClick={() => setCopyTo(copyTo.includes(d) ? copyTo.filter((x) => x !== d) : [...copyTo, d])}>
                    {DAY_SHORT[d]}
                  </button>
                ))}
              </div>
            </div>

            <div className="chips">
              <button disabled={busy || overflowing} onClick={saveDay}>
                {busy ? 'Saving…' : `Save ${DAY_NAMES[day]}`}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Durations are what the admin edits, so a loaded day is converted back from its stored times. */
function minutesBetween(from: string, to: string): number {
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  return th * 60 + tm - (fh * 60 + fm);
}
