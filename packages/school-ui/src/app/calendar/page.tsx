'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Campus, type Holiday } from '@sw/api-client';
import { useMe } from '@sw/session';
import { hasAnyRole, isSchoolWideAdmin } from '@sw/roles';
import { ConfirmDialog } from '../classes/confirm-dialog';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = () => iso(new Date());
/**
 * The API returns a full ISO timestamp (`2027-03-20T00:00:00.000Z`), so appending `T00:00:00`
 * produced `Invalid Date` on every row — visible on screen, and missed by a spec that asserted
 * the closure's NAME rather than its date. Slice first, then parse as local midnight so the day
 * never shifts backwards in a negative-offset zone.
 */
const pretty = (d: string) =>
  new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

/**
 * The school calendar — days the school is shut.
 *
 * Deliberately NOT on the settings screen, although the plan first put it there. The weekly off
 * is a *setting* (one recurring rule, one control); this is a *register of dated records* with
 * its own create and delete. Mixing the two would make Settings half configuration and half CRUD
 * — the same shape the Classes refactor had to undo. Settings links here instead.
 *
 * Nothing on this page notifies anybody, and it says so: the whole point of the free path is that
 * a head declares a closure here and then chooses, separately and knowingly, how to tell people.
 */
export default function CalendarPage() {
  const me = useMe();
  const schoolWide = isSchoolWideAdmin(me?.roles);
  // A teacher reads this calendar but never writes it. Rendering controls that always 403 is the
  // same defect as the CSV-import button that was offered to everyone and worked for nobody.
  const canEdit = hasAnyRole(me?.roles, ['OWNER_ADMIN', 'CAMPUS_ADMIN']);

  const [rows, setRows] = useState<Holiday[] | null>(null);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [err, setErr] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<Holiday | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const [one, setOne] = useState({ date: today(), name: '', campusId: '' });
  // ⚠️ Deliberately NOT sticky and NOT defaulted on: every tick is a decision to spend credits,
  // and a checkbox that remembers "yes" would spend them on the next closure without being asked.
  const [notify, setNotify] = useState(false);
  const [range, setRange] = useState({ fromDate: '', toDate: '', name: '', campusId: '' });
  const [showRange, setShowRange] = useState(false);

  const load = useCallback(async () => {
    setRows(await api.holidays.list());
  }, []);

  useEffect(() => {
    load().catch(() => setErr(true));
    api.campuses.list().then(setCampuses).catch(() => {});
  }, [load]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      await load();
      setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'That did not work.' });
    } finally {
      setBusy(false);
    }
  }

  /**
   * The free notification path. Guardians have no logins, so the channel that reaches them is the
   * school's own WhatsApp group — and one broadcast by SMS would be ~500 segments, half a BASIC
   * school's monthly allowance, competing with the daily absence alerts. So: produce the message,
   * let the office paste it where the parents already are.
   */
  async function copyMessage(h: Holiday) {
    // No school name: this is pasted into the school's OWN group, where naming it is noise.
    const text =
      `The school will be closed on ${pretty(h.date)} (${h.name}). `
      + 'Classes resume as normal afterwards.';
    try {
      await navigator.clipboard.writeText(text);
      setCopied(h.id);
      setTimeout(() => setCopied(null), 4000);
    } catch {
      setMsg({ ok: false, text: 'Could not copy — select the text manually.' });
    }
  }

  if (err) return <p className="error">Couldn&apos;t load the calendar.</p>;

  const byMonth = (rows ?? []).reduce<Record<string, Holiday[]>>((acc, h) => {
    const d = new Date(h.date);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    (acc[key] ??= []).push(h);
    return acc;
  }, {});

  return (
    <div className="stack">
      <div className="stack" style={{ gap: 4 }}>
        <h1 style={{ marginBottom: 0 }}>School calendar</h1>
        <p className="muted" style={{ margin: 0 }}>
          Days the school is closed — Eid, public holidays, and one-off closures. Your weekly off
          is separate and lives in <a href="/settings">School settings</a>.
        </p>
      </div>

      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {/* Said once, plainly, at the top: this page changes what the system does, and tells nobody.
          A head who declares Eid and assumes parents were informed is the failure this prevents. */}
      {canEdit && (
      <div className="card stack" style={{ borderLeft: '4px solid #d97706' }}>
        <strong style={{ fontSize: 14 }}>Declaring a closure does not message anyone, unless you ask it to</strong>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Staff and students see it in the app straight away. Guardians are only texted if you tick
          <b> Text guardians</b> below — otherwise use <b>Copy message</b> on the closure and paste it
          into your WhatsApp group, which costs nothing.
        </p>
      </div>
      )}

      {canEdit && (
      <div className="card stack">
        <strong style={{ fontSize: 15 }}>Add a closure</strong>
        <div className="inline-form" style={{ alignItems: 'flex-end' }}>
          {!showRange ? (
            <>
              <div style={{ maxWidth: 170 }}>
                <label>Date</label>
                <input type="date" value={one.date} onChange={(e) => setOne({ ...one, date: e.target.value })} />
              </div>
              <div style={{ minWidth: 220 }}>
                <label>Why is it closed?</label>
                <input value={one.name} placeholder="e.g. Eid ul Adha"
                  onChange={(e) => setOne({ ...one, name: e.target.value })} />
              </div>
            </>
          ) : (
            <>
              <div style={{ maxWidth: 170 }}>
                <label>From</label>
                <input type="date" value={range.fromDate} onChange={(e) => setRange({ ...range, fromDate: e.target.value })} />
              </div>
              <div style={{ maxWidth: 170 }}>
                <label>To</label>
                <input type="date" value={range.toDate} onChange={(e) => setRange({ ...range, toDate: e.target.value })} />
              </div>
              <div style={{ minWidth: 200 }}>
                <label>Why is it closed?</label>
                <input value={range.name} placeholder="e.g. Winter break"
                  onChange={(e) => setRange({ ...range, name: e.target.value })} />
              </div>
            </>
          )}

          {/* Only an owner may close the whole school; a campus admin's closure is their campus
              whatever they pick, so the choice is not offered to them at all. */}
          {schoolWide && campuses.length > 1 && (
            <div style={{ minWidth: 190 }}>
              <label>Applies to</label>
              <select
                value={showRange ? range.campusId : one.campusId}
                onChange={(e) => (showRange
                  ? setRange({ ...range, campusId: e.target.value })
                  : setOne({ ...one, campusId: e.target.value }))}
              >
                <option value="">The whole school</option>
                {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}

          {/* ⚠️ Single closures only. A fortnight of winter break would otherwise fan out to
              students × 14, which is how a school burns a month of credits in one click. */}
          {!showRange && (
            <div style={{ minWidth: 200 }}>
              <label htmlFor="notify-guardians" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  id="notify-guardians"
                  type="checkbox"
                  checked={notify}
                  onChange={(e) => setNotify(e.target.checked)}
                  style={{ width: 'auto' }}
                />
                Text guardians
              </label>
            </div>
          )}

          <button
            disabled={busy || (showRange
              ? !range.fromDate || !range.toDate || range.name.trim().length < 2
              : !one.date || one.name.trim().length < 2)}
            onClick={() => (showRange
              ? run(async () => {
                  const res = await api.holidays.createRange({
                    fromDate: range.fromDate, toDate: range.toDate, name: range.name.trim(),
                    ...(range.campusId ? { campusId: range.campusId } : {}),
                  });
                  setRange({ fromDate: '', toDate: '', name: '', campusId: '' });
                  // Skipped days are reported rather than swallowed — a range crossing an
                  // existing closure is normal, and silently doing less than asked is not.
                  setMsg({
                    ok: true,
                    text: res.skipped.length
                      ? `Added ${res.created} day(s). Skipped: ${res.skipped.join(', ')}`
                      : `Added ${res.created} day(s).`,
                  });
                }, '')
              : run(async () => {
                  await api.holidays.create({
                    date: one.date, name: one.name.trim(),
                    ...(one.campusId ? { campusId: one.campusId } : {}),
                    ...(notify ? { notifyGuardians: true } : {}),
                  });
                  setOne({ date: today(), name: '', campusId: '' });
                  setNotify(false);
                }, notify ? 'Closure added — guardians are being texted' : 'Closure added'))}
          >
            {busy ? 'Saving…' : showRange ? 'Add these days' : 'Add closure'}
          </button>
          <button className="ghost small" onClick={() => setShowRange(!showRange)}>
            {showRange ? 'One day instead' : 'A range of days'}
          </button>
        </div>
        {/* The third clause is the one nobody expects, so it is stated where the decision is made. */}
        <div className="field-hint">
          No attendance is taken that day, staff are not marked absent, and payroll counts one
          fewer working day.
          {!showRange && notify && (
            <>
              {' '}<b>One SMS per enrolled student</b> will be sent from your credits — a guardian with
              two children here receives two.
            </>
          )}
        </div>
      </div>
      )}

      {!rows ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            {canEdit
              ? 'No closures recorded. Until one is, every day except your weekly off is treated as a normal school day — including public holidays.'
              : 'No closures recorded for your school.'}
          </p>
        </div>
      ) : (
        Object.entries(byMonth).map(([key, items]) => {
          const [y, m] = key.split('-').map(Number);
          return (
            <div key={key}>
              <div className="section-title">{MONTHS[m]} {y}</div>
              <div className="card stack" style={{ gap: 8 }}>
                {items.map((h) => (
                  <div className="row" key={h.id} style={{ gap: 10, alignItems: 'center' }}>
                    <strong style={{ minWidth: 130 }}>{pretty(h.date)}</strong>
                    <span>{h.name}</span>
                    <span className="badge">{h.campus?.name ?? 'Whole school'}</span>
                    {canEdit && (
                      <span className="row" style={{ gap: 6, marginLeft: 'auto' }}>
                        <button className="ghost small" onClick={() => void copyMessage(h)}>
                          {copied === h.id ? '✓ Copied' : '📋 Copy message'}
                        </button>
                        <button className="ghost small" style={{ color: '#b91c1c' }}
                          onClick={() => setConfirming(h)}>
                          Delete
                        </button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })
      )}

      {confirming && (
        <ConfirmDialog
          title={`Remove "${confirming.name}"?`}
          body={
            <>
              <b>{pretty(confirming.date)}</b> becomes a normal school day again: registers will be
              expected, and payroll will count it as a working day.
              <br />
              Anyone already told about the closure will not be told it is cancelled.
            </>
          }
          confirmLabel="Remove closure"
          onConfirm={async () => {
            try {
              await api.holidays.remove(confirming.id);
              await load();
              return null;
            } catch (e) {
              return e instanceof ApiError ? e.message : 'Could not remove that closure.';
            }
          }}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
