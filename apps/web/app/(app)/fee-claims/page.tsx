'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type FeeClaim } from '@/lib/api';
import { useMe } from '@/lib/me-context';

const STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'] as const;
const rs = (n: string | number) => `Rs ${Number(n).toLocaleString()}`;
const METHOD: Record<string, string> = {
  CASH: 'Cash', BANK_TRANSFER: 'Bank transfer', EASYPAISA: 'EasyPaisa',
  JAZZCASH: 'JazzCash', CHEQUE: 'Cheque', CARD: 'Card', ADVANCE: 'Advance',
};
const SOURCE: Record<string, string> = {
  OFFICE: 'Office', STUDENT_PORTAL: 'Student portal', GUARDIAN_LINK: 'Parent link',
};

/**
 * The verification queue — money somebody says arrived.
 *
 * Nothing here has moved a rupee yet: a claim holds no receipt number and adds nothing to
 * collections until it is verified against the bank statement. That is why this is a queue and
 * not a list of payments, and why the pending count is what the dashboard advertises.
 *
 * Oldest first, because a queue is worked through and the family waiting longest goes first.
 */
export default function FeeClaimsPage() {
  const me = useMe();
  const canDecide = (me?.roles ?? []).some((r) => r === 'OWNER_ADMIN' || r === 'ACCOUNTANT');

  const [status, setStatus] = useState<string>('PENDING');
  const [claims, setClaims] = useState<FeeClaim[] | null>(null);
  const [counts, setCounts] = useState({ pending: 0 });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [rejecting, setRejecting] = useState<{ id: string; reason: string } | null>(null);
  const [err, setErr] = useState(false);

  const load = useCallback(async () => {
    const [list, pending] = await Promise.all([
      api.feeSetup.claims({ status }),
      api.feeSetup.pendingClaims().catch(() => ({ pending: 0 })),
    ]);
    setClaims(list.data);
    setCounts(pending);
  }, [status]);

  useEffect(() => { setClaims(null); load().catch(() => setErr(true)); }, [load]);

  async function run(id: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(id);
    try { await fn(); await load(); setMsg({ ok: true, text: ok }); }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'That did not work' }); }
    finally { setBusy(''); }
  }

  async function openProof(id: string) {
    try {
      const { url } = await api.feeSetup.claimProof(id);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not open that file' });
    }
  }

  if (err) return <p className="error">Couldn&apos;t load payment submissions.</p>;

  return (
    <div className="stack">
      <div className="stack" style={{ gap: 4 }}>
        <h1 style={{ marginBottom: 0 }}>Payment submissions</h1>
        <p className="muted" style={{ margin: 0 }}>
          Money someone says they have sent. <strong>Nothing here is counted as paid</strong> until you
          check it against your bank statement and verify it — that is what issues the receipt.
        </p>
      </div>

      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <div className="chips">
        {STATUSES.map((s) => (
          <button key={s} type="button" className={`chip${status === s ? ' active' : ''}`} onClick={() => setStatus(s)}>
            {s === 'PENDING' ? 'Awaiting check' : s === 'VERIFIED' ? 'Verified' : 'Rejected'}
            {/* The badge answers "what still needs me?", so it stays on PENDING whatever is shown. */}
            {s === 'PENDING' && counts.pending > 0 && <span className="badge warn" style={{ marginLeft: 6 }}>{counts.pending}</span>}
          </button>
        ))}
      </div>

      <div className="card stack">
        {!claims ? (
          <p className="muted" style={{ margin: 0 }}>Loading…</p>
        ) : claims.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {status === 'PENDING'
              ? 'Nothing is waiting to be checked.'
              : `No ${status.toLowerCase()} submissions.`}
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr><th>Student</th><th>For</th><th>Amount</th><th>How</th><th>Paid on</th><th>Proof</th><th></th></tr>
              </thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.student.fullName}</strong>
                      <span className="muted" style={{ display: 'block', fontSize: 12 }}>{c.student.grNumber}</span>
                    </td>
                    <td className="muted">{c.invoice.month ? `${c.invoice.month}/${c.invoice.year}` : c.invoice.year}</td>
                    <td><strong>{rs(c.amount)}</strong></td>
                    <td>
                      {METHOD[c.method] ?? c.method}
                      {c.transactionRef && (
                        <span className="muted" style={{ display: 'block', fontSize: 12 }}>{c.transactionRef}</span>
                      )}
                    </td>
                    <td className="muted">
                      {c.paidOn.slice(0, 10)}
                      {/* Submitted-on is shown only when it differs — the payer's date is the one
                          that matters, and repeating it when they match is noise. */}
                      {c.createdAt.slice(0, 10) !== c.paidOn.slice(0, 10) && (
                        <span style={{ display: 'block', fontSize: 11 }}>sent in {c.createdAt.slice(0, 10)}</span>
                      )}
                      <span className="badge" style={{ fontSize: 11 }}>{SOURCE[c.source] ?? c.source}</span>
                    </td>
                    <td>
                      {c.hasProof
                        ? <button className="ghost small" onClick={() => openProof(c.id)}>View</button>
                        : <span className="muted">—</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {c.status === 'PENDING' && canDecide ? (
                        rejecting?.id === c.id ? (
                          <span className="inline-form" style={{ justifyContent: 'flex-end' }}>
                            <input autoFocus style={{ width: 200 }} placeholder="Why? The payer sees this"
                              value={rejecting.reason}
                              onChange={(e) => setRejecting({ id: c.id, reason: e.target.value })} />
                            <button className="small" disabled={rejecting.reason.trim().length < 3 || busy === c.id}
                              onClick={() => run(c.id, () => api.feeSetup.rejectClaim(c.id, rejecting.reason.trim()), 'Submission rejected').then(() => setRejecting(null))}>
                              Reject
                            </button>
                            <button className="ghost small" onClick={() => setRejecting(null)}>Cancel</button>
                          </span>
                        ) : (
                          <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                            <button className="small" disabled={busy === c.id}
                              onClick={() => run(c.id, async () => {
                                const res = await api.feeSetup.verifyClaim(c.id);
                                setMsg({ ok: true, text: `Verified — receipt #${res.receiptNo} issued` });
                              }, 'Verified')}>
                              {busy === c.id ? 'Verifying…' : '✓ Verify'}
                            </button>
                            <button className="ghost small" style={{ color: '#b91c1c' }}
                              onClick={() => setRejecting({ id: c.id, reason: '' })}>Reject</button>
                          </span>
                        )
                      ) : c.status === 'VERIFIED' ? (
                        <span className="badge ok">Receipt issued</span>
                      ) : c.status === 'REJECTED' ? (
                        <span className="badge bad" title={c.rejectionReason ?? undefined}>Rejected</span>
                      ) : (
                        <span className="muted" style={{ fontSize: 12 }}>Awaiting the cashier</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {status === 'REJECTED' && (claims?.length ?? 0) > 0 && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          A rejected submission is final — if the payer sends corrected details, they submit again.
        </p>
      )}
    </div>
  );
}
