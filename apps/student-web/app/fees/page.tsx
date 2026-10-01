'use client';

import { Fragment, useEffect, useState } from 'react';
import { api, ApiError, type PortalFee } from '@sw/api-client';
import { feeBadge, monthYear } from '@sw/ui';

const METHOD: Record<string, string> = {
  CASH: 'Cash', BANK_TRANSFER: 'Bank transfer', EASYPAISA: 'EasyPaisa',
  JAZZCASH: 'JazzCash', CHEQUE: 'Cheque', CARD: 'Card', ADVANCE: 'From advance',
};

export default function MyFees() {
  const [rows, setRows] = useState<PortalFee[] | null>(null);
  const [err, setErr] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { api.portal.fees().then(setRows).catch(() => setErr(true)); }, []);

  /** Opens the PDF in a new tab. The link is presigned and short-lived, so it is fetched on the
   *  click rather than rendered as an href that would be stale by the time anyone used it. */
  async function openReceipt(paymentId: string) {
    setBusy(paymentId);
    setMsg(null);
    try {
      const { url } = await api.portal.receipt(paymentId);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Could not open that receipt.');
    } finally {
      setBusy(null);
    }
  }

  if (err) return <p className="error">Couldn&apos;t load your fees.</p>;
  if (!rows) return <p className="muted">Loading…</p>;
  const outstanding = rows.reduce((s, i) => s + i.remaining, 0);

  return (
    <div className="stack">
      <h1>My Fees</h1>
      <p className="muted">Pay at the school counter or via bank. Total outstanding: <b>Rs {outstanding.toLocaleString()}</b>.</p>
      {msg && <div className="toast err">{msg}</div>}
      <table className="stacked">
        <thead><tr><th>Period</th><th>Total</th><th>Paid</th><th>Remaining</th><th>Due</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <Fragment key={r.id}>
              <tr>
                <td data-label="Period"><strong style={{ fontWeight: 600 }}>{monthYear(r.month, r.year)}</strong></td>
                <td data-label="Total">Rs {r.total.toLocaleString()}</td>
                <td data-label="Paid">Rs {r.paid.toLocaleString()}</td>
                <td data-label="Remaining">Rs {r.remaining.toLocaleString()}</td>
                <td data-label="Due">{new Date(r.dueDate).toLocaleDateString()}</td>
                <td data-label="Status"><span className={`badge ${feeBadge(r.status)}`}>{r.status}</span></td>
                <td data-label="" style={{ textAlign: 'right' }}>
                  {/* Only where there is something to show. A "Receipts" control on a bill with
                      no payments is a button that opens an empty box. */}
                  {r.payments.length > 0 && (
                    <button className="ghost small" onClick={() => setOpen(open === r.id ? null : r.id)}>
                      {open === r.id ? 'Hide' : `Receipts (${r.payments.length})`}
                    </button>
                  )}
                </td>
              </tr>
              {open === r.id && (
                <tr>
                  <td colSpan={7} data-label="" style={{ background: '#f8fafc' }}>
                    <div className="stack" style={{ gap: 6, padding: '4px 0' }}>
                      {r.payments.map((p) => (
                        <div className="row" key={p.id} style={{ gap: 10, justifyContent: 'flex-start' }}>
                          <strong style={{ minWidth: 96 }}>Receipt #{p.receiptNo}</strong>
                          <span>Rs {p.amount.toLocaleString()}</span>
                          <span className="muted">{METHOD[p.method] ?? p.method}</span>
                          <span className="muted">{new Date(p.paidAt).toLocaleDateString()}</span>
                          {/* A reversed payment stays visible and says so. Quietly dropping it
                              from the list is how a family is left holding a receipt for money
                              the school no longer counts. */}
                          {p.reversed ? (
                            <span className="badge bad">Reversed — ask the office</span>
                          ) : (
                            <button className="ghost small" disabled={busy === p.id} onClick={() => void openReceipt(p.id)}>
                              {busy === p.id ? 'Opening…' : '⬇ Receipt (PDF)'}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {rows.length === 0 && <tr><td colSpan={7} className="muted">No invoices yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
