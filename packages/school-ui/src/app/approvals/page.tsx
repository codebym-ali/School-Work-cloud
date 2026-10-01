'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type ApprovalRequest } from '@sw/api-client';
import { EmptyState } from '@school/components/oversight';
import { useMe } from '@sw/session';

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
const STATUS_LABEL: Record<(typeof STATUSES)[number], string> = { PENDING: 'Waiting', APPROVED: 'Approved', REJECTED: 'Rejected' };
const rs = (n: number) => `Rs ${Math.round(n).toLocaleString()}`;
const when = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Approvals — what the office prepared and the owner signs off.
 *
 * The owner sees every campus and decides; a campus's Ops Admin or accountant sees only that campus's requests, as a
 * status board ("waiting for the owner") with no buttons. Nothing held here has reached a family: approving is the
 * moment a campus's monthly vouchers are issued, and rejecting voids them so the class can be billed again.
 */
export default function ApprovalsPage() {
  const me = useMe();
  const isOwner = (me?.roles ?? []).includes('OWNER_ADMIN');

  const [status, setStatus] = useState<(typeof STATUSES)[number]>('PENDING');
  const [rows, setRows] = useState<ApprovalRequest[] | null>(null);
  const [waiting, setWaiting] = useState(0);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [rejecting, setRejecting] = useState<{ id: string; reason: string } | null>(null);
  const [err, setErr] = useState(false);

  const load = useCallback(async () => {
    const [list, pending] = await Promise.all([
      api.approvals.list(status),
      api.approvals.pendingCount().catch(() => ({ pending: 0 })),
    ]);
    setRows(list);
    setWaiting(pending.pending);
  }, [status]);

  useEffect(() => { setRows(null); load().catch(() => setErr(true)); }, [load]);

  async function decide(id: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(id);
    setMsg(null);
    try { await fn(); setRejecting(null); await load(); setMsg({ ok: true, text: ok }); }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'That did not work' }); }
    finally { setBusy(''); }
  }

  if (err) return <p className="error">Couldn&apos;t load approvals.</p>;

  return (
    <div className="stack">
      <div className="stack" style={{ gap: 4 }}>
        <h1 style={{ marginBottom: 0 }}>Approvals</h1>
        <p className="muted" style={{ margin: 0 }}>
          {isOwner
            ? 'Fee vouchers and school-wide changes your campuses have prepared. Nothing goes out or changes until you approve it.'
            : 'Your requests to the owner — monthly fee vouchers and school-wide setup changes. They take effect only once the owner approves.'}
        </p>
      </div>

      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <div className="chips">
        {STATUSES.map((s) => (
          <button key={s} type="button" className={`chip${status === s ? ' active' : ''}`} onClick={() => setStatus(s)}>
            {STATUS_LABEL[s]}
            {s === 'PENDING' && waiting > 0 && <span className="badge warn" style={{ marginLeft: 6 }}>{waiting}</span>}
          </button>
        ))}
      </div>

      {!rows ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card">
          <EmptyState icon="inbox" title={status === 'PENDING' ? 'Nothing waiting' : `No ${STATUS_LABEL[status].toLowerCase()} requests`}>
            {status === 'PENDING'
              ? (isOwner ? 'When a campus prepares its monthly fee vouchers, or an Ops Admin proposes a school-wide change, it appears here for you to approve.' : 'When you generate a campus\'s monthly vouchers, or propose a school-wide change, it waits here for the owner.')
              : null}
          </EmptyState>
        </div>
      ) : rows.map((r) => (
        <div key={r.id} className="card stack" style={{ gap: 10 }}>
          <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
            <div className="stack" style={{ gap: 2, flex: 1 }}>
              <strong style={{ fontSize: 16 }}>{r.title}</strong>
              <span className="muted" style={{ fontSize: 13 }}>
                Prepared by {r.requestedBy ?? 'the office'} · {when(r.requestedAt)}
                {r.decidedAt && <> · {r.status === 'APPROVED' ? 'Approved' : 'Rejected'} by {r.decidedBy ?? 'the owner'} on {when(r.decidedAt)}</>}
              </span>
            </div>
            <span className={`badge ${r.status === 'PENDING' ? 'warn' : r.status === 'APPROVED' ? 'ok' : 'err'}`}>
              {r.status === 'PENDING' ? (isOwner ? 'Needs you' : 'Waiting for the owner') : STATUS_LABEL[r.status]}
            </span>
          </div>

          {r.summary && (
            <div className="row" style={{ gap: 28, flexWrap: 'wrap' }}>
              <div><span className="muted" style={{ fontSize: 12, display: 'block' }}>
                {r.status === 'REJECTED' ? 'Vouchers voided' : r.status === 'APPROVED' ? 'Vouchers issued' : 'Vouchers'}</span>
                <strong style={{ fontSize: 20 }}>{r.summary.vouchers.toLocaleString()}</strong></div>
              <div><span className="muted" style={{ fontSize: 12, display: 'block' }}>Total billed</span>
                <strong style={{ fontSize: 20 }}>{rs(r.summary.total)}</strong></div>
              <div><span className="muted" style={{ fontSize: 12, display: 'block' }}>Month</span>
                <strong style={{ fontSize: 20 }}>{r.summary.period}</strong></div>
              {r.summary.classes.length > 0 && (
                <div style={{ flex: 1, minWidth: 180 }}><span className="muted" style={{ fontSize: 12, display: 'block' }}>Classes</span>
                  <span>{r.summary.classes.join(', ')}</span></div>
              )}
            </div>
          )}

          {/* A setup change: what it WOULD do, in the proposer's own values. Approving applies exactly this. */}
          {r.changes && r.changes.length > 0 && (
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-start' }}>
              {r.changes.map((c) => (
                <span key={c.label} className="chip" style={{ cursor: 'default' }}>
                  <span className="muted">{c.label}:</span> <strong>{c.value}</strong>
                </span>
              ))}
            </div>
          )}

          {r.decisionNote && (
            <p className="muted" style={{ margin: 0 }}>{r.status === 'REJECTED' ? 'Reason: ' : 'Note: '}{r.decisionNote}</p>
          )}

          {isOwner && r.status === 'PENDING' && (
            rejecting?.id === r.id ? (
              <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <label>Why are you sending these back? <span className="muted">(the office sees this)</span></label>
                  <input autoFocus value={rejecting.reason} placeholder="e.g. Fee plan changed — please regenerate"
                    onChange={(e) => setRejecting({ id: r.id, reason: e.target.value })} />
                </div>
                <button className="ghost small" onClick={() => setRejecting(null)}>Cancel</button>
                <button className="small" style={{ background: '#c0392b' }}
                  disabled={busy === r.id || rejecting.reason.trim().length < 3}
                  onClick={() => decide(r.id, () => api.approvals.reject(r.id, rejecting.reason.trim()),
                    r.type === 'VOUCHER_BATCH' ? 'Sent back — the held vouchers were voided and the classes can be billed again.' : 'Sent back — nothing was changed.')}>
                  Reject &amp; void
                </button>
              </div>
            ) : (
              <div className="row" style={{ gap: 8 }}>
                <button disabled={busy === r.id}
                  onClick={() => decide(r.id, () => api.approvals.approve(r.id),
                    r.type === 'VOUCHER_BATCH' ? 'Approved — the vouchers are issued to families.' : 'Approved — the change has been applied.')}>
                  {busy === r.id ? 'Approving…' : r.type === 'VOUCHER_BATCH' ? `Approve & issue${r.summary ? ` ${r.summary.vouchers} vouchers` : ''}` : 'Approve & apply'}
                </button>
                <button className="ghost" disabled={busy === r.id} onClick={() => setRejecting({ id: r.id, reason: '' })}>Reject…</button>
              </div>
            )
          )}
        </div>
      ))}
    </div>
  );
}
