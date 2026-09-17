'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, ApiError, type AuditEntry } from '@sw/api-client';

/** The actions a school most often needs to find. The log records more; the filter also takes any exact code. */
const COMMON_ACTIONS = [
  'PAYMENT_REVERSED', 'FEE_WAIVED', 'STUDENT_WITHDRAWN', 'WITHDRAWAL_FEE_OVERRIDE', 'CERTIFICATE_ISSUED',
  'STUDENT_CNIC_REVEALED', 'PRIMARY_GUARDIAN_CHANGED', 'GUARDIAN_CONTACT_UPDATED', 'PROMOTION_OVERRIDE',
  'HOLIDAY_DECLARED', 'STUDENT_ADMITTED',
];

/** `PAYMENT_REVERSED` → "Payment reversed". The code stays visible on hover for anyone matching it exactly. */
const human = (action: string) => {
  const s = action.toLowerCase().replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/**
 * The activity log (GAP-06): who did what, when, and why.
 *
 * Every sensitive action was already recorded — reversals, waivers, CNIC reveals, withdrawals, overrides —
 * and none of it could be read without database access. "Who reversed this receipt, and what reason did
 * they give?" is the owner's question in every cash dispute; this answers it.
 *
 * ⚠️ **"Load older", never page numbers.** The log only grows, and numbered pages shift under the reader
 * each time something new is recorded, so an entry would appear twice or not at all. The API returns an
 * opaque cursor to the next older batch.
 *
 * ⚠️ **A campus admin sees their own campus's people only**, enforced by the API. The screen says so, so an
 * owner's action missing from a campus admin's view reads as scope rather than as a gap in the record.
 *
 * Deep-linkable: `/activity?entityId=<id>` shows the history of one record, which is how other screens
 * answer "who did this" in place.
 */
function ActivityLog() {
  const params = useSearchParams();
  const [action, setAction] = useState(params.get('action') ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const entityId = params.get('entityId') ?? '';

  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async (after?: string) => {
    setLoading(true); setErr(null);
    try {
      const res = await api.activity.list({
        ...(action ? { action } : {}),
        ...(entityId ? { entityId } : {}),
        // Whole days, in the reader's terms: "to 16 Sep" means through the end of that day.
        ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}),
        ...(to ? { to: new Date(`${to}T23:59:59.999`).toISOString() } : {}),
        ...(after ? { cursor: after } : {}),
      });
      setRows((prev) => (after ? [...prev, ...res.data] : res.data));
      setCursor(res.nextCursor);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not load the activity log.');
    } finally { setLoading(false); }
  }, [action, entityId, from, to]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="stack">
      <div className="stack" style={{ gap: 4 }}>
        <h1 style={{ marginBottom: 0 }}>Activity log</h1>
        <p className="muted" style={{ margin: 0 }}>
          Who changed what, when, and the reason they gave. Nothing here can be edited or deleted.
        </p>
      </div>

      <div className="card stack" style={{ gap: 10 }}>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
          <div>
            <label htmlFor="act-action">What happened</label>
            <input id="act-action" list="act-actions" value={action} placeholder="Any action"
              onChange={(e) => setAction(e.target.value.trim().toUpperCase())} />
            <datalist id="act-actions">{COMMON_ACTIONS.map((a) => <option key={a} value={a}>{human(a)}</option>)}</datalist>
          </div>
          <div><label htmlFor="act-from">From</label><input id="act-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><label htmlFor="act-to">To</label><input id="act-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
        {entityId && (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Showing one record&apos;s history. <a href="/activity">Show everything</a>
          </p>
        )}
        <p className="field-hint" style={{ margin: 0 }}>Campus admins see activity by people on their own campus.</p>
      </div>

      {err && <div className="toast err" role="alert">{err}</div>}

      <div className="card" style={{ padding: 0 }}>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Reason</th><th /></tr></thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr><td colSpan={5} className="muted">Nothing recorded matches these filters.</td></tr>
              )}
              {rows.map((r) => (
                <FragmentRow key={r.id} row={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="row" style={{ justifyContent: 'center' }}>
        {cursor
          ? <button type="button" className="ghost" disabled={loading} onClick={() => void load(cursor)}>{loading ? 'Loading…' : 'Load older'}</button>
          : rows.length > 0 && <span className="muted" style={{ fontSize: 13 }}>That is everything recorded.</span>}
      </div>
    </div>
  );
}

function FragmentRow({ row: r, open, onToggle }: { row: AuditEntry; open: boolean; onToggle: () => void }) {
  const hasDetail = r.oldValue != null || r.newValue != null;
  return (
    <>
      <tr>
        <td style={{ whiteSpace: 'nowrap' }}>{new Date(r.createdAt).toLocaleString()}</td>
        <td>{r.actor ?? <span className="muted">—</span>}</td>
        <td title={r.action}>
          {human(r.action)}
          <div className="muted" style={{ fontSize: 12 }}>{r.entityType}</div>
        </td>
        <td style={{ maxWidth: 320 }}>{r.reason ?? <span className="muted">—</span>}</td>
        <td style={{ textAlign: 'right' }}>
          {hasDetail && <button type="button" className="ghost small" aria-expanded={open} onClick={onToggle}>{open ? 'Hide' : 'Details'}</button>}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5}>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
              {r.oldValue != null && <Detail label="Before" value={r.oldValue} />}
              {r.newValue != null && <Detail label="After" value={r.newValue} />}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Detail({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="section-title" style={{ margin: '0 0 4px' }}>{label}</div>
      <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowX: 'auto' }}>
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export default function ActivityPage() {
  // useSearchParams needs a Suspense boundary in the app router, or the build bails out of static rendering.
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <ActivityLog />
    </Suspense>
  );
}
