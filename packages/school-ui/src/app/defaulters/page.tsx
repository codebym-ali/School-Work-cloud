'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type Defaulter } from '@sw/api-client';
import { hasAnyRole } from '@sw/roles';
import { useMe } from '@sw/session';

const rs = (n: number) => `Rs ${n.toLocaleString()}`;
const THRESHOLDS = [0, 7, 30, 60, 90];

/**
 * Defaulters as a working list (GAP-13).
 *
 * Chasing unpaid fees is a DAILY task with a next action on every row — call the guardian, send a reminder.
 * It was a read-only report table: the office got names and had to look up each family somewhere else.
 * Each row now carries the primary guardian, their number, and whether an SMS can actually reach them.
 *
 * ⚠️ **"Can text" is shown before sending, not discovered after.** SMS goes only to a verified number that has
 * not opted out. A reminder to anyone else would be queued and silently dropped, and the office would think
 * the family had been told. Those rows cannot be ticked, and say to call instead.
 *
 * ⚠️ **The screen sends ids, never amounts.** The server re-reads what each student owes when it queues the
 * message, so a list left open all morning still texts today's balance. One reminder per student per day.
 */
export default function DefaultersPage() {
  const me = useMe();
  const canOpenProfile = hasAnyRole(me?.roles, ['OWNER_ADMIN', 'CAMPUS_ADMIN']);
  const [minDays, setMinDays] = useState(0);
  const [rows, setRows] = useState<Defaulter[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    setRows(null);
    api.defaulters.list(minDays).then((r) => { setRows(r); setPicked(new Set()); }).catch((e) => {
      setRows([]);
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not load defaulters.' });
    });
  }, [minDays]);
  useEffect(() => { load(); }, [load]);

  const textable = useMemo(() => (rows ?? []).filter((r) => r.guardian?.canText), [rows]);

  /**
   * `?remind=all` — the owner home's "Send reminders" button (Owner Dashboard Phase 3).
   *
   * It lands HERE, on the confirmation this screen already has, rather than texting from the dashboard:
   * a one-tap mass SMS from a home screen would skip the one step that says how many families and how
   * many credits. So the intent only pre-ticks everyone who can be texted and opens that dialog; nothing
   * is sent until Send is pressed. Read from `location` once (not `useSearchParams`, which needs a
   * Suspense boundary to build), then removed from the URL so a reload does not reopen it.
   *
   * ⚠️ **The intent stays live until the dialog closes — it is not applied "once".** Every list load
   * ends by clearing the selection (`load`), and the list can load twice (React's dev double-effect, or
   * a filter change). Applied once, the second load wiped the ticks AFTER the dialog had opened, and it
   * read "Text 0 families?". Re-applied on every load while live, the selection always matches the list.
   */
  const intentRead = useRef(false);
  const [remindAll, setRemindAll] = useState(false);
  useEffect(() => {
    if (intentRead.current) return;
    intentRead.current = true;
    const url = new URL(window.location.href);
    if (url.searchParams.get('remind') !== 'all') return;
    url.searchParams.delete('remind');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    setRemindAll(true);
  }, []);
  useEffect(() => {
    if (!remindAll || rows === null) return;
    if (textable.length > 0) {
      setPicked(new Set(textable.map((r) => r.student.id)));
      setConfirming(true);
    } else {
      if (rows.length > 0) setMsg({ ok: false, text: 'Nobody on this list can be texted — their numbers are unverified or opted out. Call them instead.' });
      setRemindAll(false);
    }
  }, [remindAll, rows, textable]);
  /** Every way out of the dialog also ends the remind intent, so a later reload cannot reopen it. */
  const closeDialog = () => { setConfirming(false); setRemindAll(false); };
  const total = (rows ?? []).reduce((n, r) => n + r.outstanding, 0);
  const allPicked = textable.length > 0 && textable.every((r) => picked.has(r.student.id));

  const toggle = (id: string) => setPicked((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  async function send() {
    setBusy(true); setMsg(null);
    try {
      const res = await api.defaulters.remind([...picked]);
      const notes = [
        res.skipped.notDefaulting > 0 ? `${res.skipped.notDefaulting} had paid in the meantime` : '',
        res.skipped.cannotText > 0 ? `${res.skipped.cannotText} could not be texted` : '',
      ].filter(Boolean);
      setMsg({ ok: true, text: `${res.queued} reminder${res.queued === 1 ? '' : 's'} queued.${notes.length ? ` ${notes.join('; ')}.` : ''}` });
      closeDialog();
      setPicked(new Set());
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not send reminders. Nothing was sent.' });
    } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <div className="stack" style={{ gap: 4 }}>
        <h1 style={{ marginBottom: 0 }}>Defaulters</h1>
        <p className="muted" style={{ margin: 0 }}>Students with fees unpaid past the due date — and who to contact about each.</p>
      </div>

      <div className="card row" style={{ gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 200 }}>
          <label htmlFor="def-days">Overdue by at least</label>
          <select id="def-days" value={minDays} onChange={(e) => setMinDays(Number(e.target.value))}>
            {THRESHOLDS.map((d) => <option key={d} value={d}>{d === 0 ? 'Any time past due' : `${d} days`}</option>)}
          </select>
        </div>
        {rows && rows.length > 0 && (
          <div className="row" style={{ gap: 16 }}>
            <span><strong>{rows.length}</strong> <span className="muted">students</span></span>
            <span><strong>{rs(Math.round(total))}</strong> <span className="muted">outstanding</span></span>
          </div>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" disabled={picked.size === 0} onClick={() => { setConfirming(true); setMsg(null); }}>
          Send reminder{picked.size > 0 ? ` to ${picked.size}` : ''}
        </button>
      </div>

      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}

      {rows === null ? <p className="muted">Loading…</p> : rows.length === 0 ? (
        <div className="card"><p className="muted" style={{ margin: 0 }}>No student is overdue{minDays ? ` by ${minDays} days or more` : ''}.</p></div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input type="checkbox" aria-label="Select everyone who can be texted" checked={allPicked} disabled={textable.length === 0}
                    onChange={() => setPicked(allPicked ? new Set() : new Set(textable.map((r) => r.student.id)))} style={{ width: 'auto' }} />
                </th>
                <th>Student</th><th style={{ textAlign: 'right' }}>Owed</th><th>Overdue</th><th>Guardian</th><th>Contact</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.student.id}>
                  <td>
                    <input type="checkbox" style={{ width: 'auto' }} aria-label={`Select ${r.student.fullName}`}
                      checked={picked.has(r.student.id)} disabled={!r.guardian?.canText} onChange={() => toggle(r.student.id)} />
                  </td>
                  <td>
                    {canOpenProfile
                      ? <a href={`/students?student=${r.student.id}`}>{r.student.fullName}</a>
                      : r.student.fullName}
                    <div className="muted" style={{ fontSize: 12 }}>GR {r.student.grNumber} · {r.invoices} invoice{r.invoices === 1 ? '' : 's'}</div>
                  </td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}><strong>{rs(r.outstanding)}</strong></td>
                  <td>
                    <span className={`badge ${r.daysOverdue >= 60 ? 'bad' : r.daysOverdue >= 30 ? 'warn' : ''}`}>{r.daysOverdue} days</span>
                    <div className="muted" style={{ fontSize: 12 }}>since {new Date(r.oldestDueDate).toLocaleDateString('en-GB')}</div>
                  </td>
                  <td>
                    {r.guardian ? <>{r.guardian.name}<div className="muted" style={{ fontSize: 12 }}>{r.guardian.relation.toLowerCase()}</div></>
                      : <span className="badge warn">No guardian on record</span>}
                  </td>
                  <td>
                    {r.guardian && <a href={`tel:${r.guardian.phone}`} style={{ fontVariantNumeric: 'tabular-nums' }}>{r.guardian.phone}</a>}
                    {r.guardian && !r.guardian.canText && <div className="muted" style={{ fontSize: 12 }}>No SMS — call instead</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirming && (
        <div role="dialog" aria-modal="true" aria-label="Send fee reminders"
          onClick={(e) => { if (e.target === e.currentTarget && !busy) closeDialog(); }}
          onKeyDown={(e) => { if (e.key === 'Escape' && !busy) closeDialog(); }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 16 }}>
          <div className="card stack" style={{ width: 'min(460px, 100%)', gap: 12, background: '#fff' }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: 0, fontSize: 17 }}>Text {picked.size} {picked.size === 1 ? 'family' : 'families'}?</h2>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              Each primary guardian receives your fee reminder message with the amount owed <strong>at the moment it is sent</strong>.
              About {picked.size} SMS from your credits. A family already reminded today will not be texted again.
            </p>
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="ghost" disabled={busy} onClick={closeDialog}>Cancel</button>
              <button type="button" disabled={busy} onClick={send} autoFocus>{busy ? 'Sending…' : `Send ${picked.size}`}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
