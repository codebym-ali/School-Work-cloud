'use client';

import { humanizeStatus } from '@sw/ui';
import { useCallback, useEffect, useState } from 'react';
import { api, apiGet, ApiError, type Invoice, type Paged, type Payment, type StudentDetail } from '@sw/api-client';
import { FEE_ADVANCE_ROLES, FEE_REVERSE_WAIVE_ROLES, hasAnyRole } from '@sw/roles';
import { useMe } from '@sw/session';
import { ReasonedActionDialog } from '@school/components/reasoned-action-dialog';

const rs = (n: string | number) => `Rs ${Number(n).toLocaleString()}`;

/** An invoice that still carries money owed — the only kind a waiver can apply to. */
const WAIVABLE = new Set(['PENDING', 'PARTIAL', 'OVERDUE']);

/**
 * A student's fees, with the owner's corrections on the rows where the money appears (GAP-01).
 *
 * ⚠️ **Every button renders if and only if the API would accept the click.** Reverse and waive are
 * `@Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN')`; recording an advance is `@Roles('OWNER_ADMIN',
 * 'ACCOUNTANT')`, which the deputy also satisfies through the role hierarchy. `hasAnyRole` applies that
 * same hierarchy, so the UI and the API answer the question the same way. A control shown and refused is
 * a trap; a permission granted and hidden is a deleted capability — which is how all three came to have
 * no screen at all.
 *
 * ⚠️ **Payments are fetched for THIS student.** The previous card fetched the school's latest page of
 * payments and filtered it in the browser, so once a school passed a page of payments, older receipts
 * vanished from a student's profile with no error anywhere.
 */
export function StudentFeesCard({ student }: { student: StudentDetail }) {
  const me = useMe();
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [denied, setDenied] = useState(false);
  const [reversing, setReversing] = useState<Payment | null>(null);
  const [waiving, setWaiving] = useState<Invoice | null>(null);
  const [advancing, setAdvancing] = useState(false);

  const canCorrect = hasAnyRole(me?.roles, FEE_REVERSE_WAIVE_ROLES);
  const canAdvance = hasAnyRole(me?.roles, FEE_ADVANCE_ROLES);
  const primary = student.guardians.find((g) => g.isPrimary) ?? student.guardians[0];

  const load = useCallback(() => {
    apiGet<Paged<Invoice>>(`/fees/invoices?studentId=${student.id}&pageSize=100`)
      .then((r) => setInvoices(r.data))
      // A role without fee access simply doesn't get this card — not an error on their screen.
      .catch(() => { setDenied(true); setInvoices([]); });
    api.feeCorrections.studentPayments(student.id).then((r) => setPayments(r.data)).catch(() => {});
  }, [student.id]);

  useEffect(() => { load(); }, [load]);

  async function openProof(paymentId: string) {
    try {
      const { url } = await api.feeSetup.paymentProof(paymentId);
      window.open(url, '_blank', 'noopener');
    } catch { /* the button only shows when proof exists; a failure here is transient */ }
  }

  if (denied || invoices === null) return null;

  const outstanding = invoices.reduce((n, i) => n + Math.max(Number(i.totalAmount) - Number(i.paidAmount), 0), 0);
  const forInvoice = (id: string) => payments.filter((p) => p.invoiceId === id);

  return (
    <div className="card stack">
      <div className="row" style={{ alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Fees</h3>
        <span className="row" style={{ gap: 8, alignItems: 'center' }}>
          {invoices.length > 0 && (
            <span className={outstanding > 0 ? 'badge warn' : 'badge ok'}>
              {outstanding > 0 ? `${rs(outstanding)} outstanding` : 'Nothing outstanding'}
            </span>
          )}
          {/* Needs a guardian: an advance is the guardian's money held as credit, not the child's. */}
          {canAdvance && primary && (
            <button type="button" className="ghost small" onClick={() => setAdvancing(true)}>Record advance</button>
          )}
        </span>
      </div>

      {invoices.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>No invoices have been generated for this student yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead><tr><th>Period</th><th>Total</th><th>Paid</th><th>Status</th><th>Receipts</th>{canCorrect && <th />}</tr></thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}>
                  <td>{i.month ? `${i.month}/${i.year}` : i.year}</td>
                  <td>{rs(i.totalAmount)}</td>
                  <td>{rs(i.paidAmount)}</td>
                  <td><span className={`badge ${i.status === 'PAID' ? 'ok' : i.status === 'OVERDUE' ? 'bad' : i.status === 'WAIVED' ? '' : 'warn'}`}>{humanizeStatus(i.status)}</span></td>
                  <td>
                    {forInvoice(i.id).length === 0 ? <span className="muted">—</span> : (
                      <span className="chips">
                        {forInvoice(i.id).map((p) => (
                          <ReceiptChip key={p.id} payment={p} canReverse={canCorrect}
                            onProof={() => openProof(p.id)} onReverse={() => setReversing(p)} />
                        ))}
                      </span>
                    )}
                  </td>
                  {canCorrect && (
                    <td style={{ textAlign: 'right' }}>
                      {WAIVABLE.has(i.status) && (
                        <button type="button" className="ghost small" onClick={() => setWaiving(i)}>Waive</button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reversing && (
        <ReasonedActionDialog
          title={`Reverse receipt #${reversing.receiptNo}?`}
          confirmLabel="Reverse payment"
          reasonPlaceholder="e.g. Posted against the wrong sibling"
          consequence={
            <>
              {rs(reversing.amountPaid)} comes off this invoice and it is recalculated. The original receipt is
              <strong> kept, marked reversed</strong>, and a reversal receipt is issued — nothing is deleted.
              This cannot be undone; a mistaken reversal is corrected by recording the payment again.
            </>
          }
          onConfirm={async (reason) => {
            const res = await api.feeCorrections.reverse(reversing.id, reason);
            load();
            return `Reversed. Reversal receipt ${res.receiptNo} issued.`;
          }}
          onClose={() => setReversing(null)}
        />
      )}

      {waiving && (
        <ReasonedActionDialog
          title={`Waive ${waiving.month ? `${waiving.month}/${waiving.year}` : waiving.year}?`}
          confirmLabel="Waive the balance"
          reasonPlaceholder="e.g. Staff child — fee concession approved by the owner"
          consequence={
            <>
              The remaining {rs(Math.max(Number(waiving.totalAmount) - Number(waiving.paidAmount), 0))} is written
              off as a <strong>waiver line</strong> on the invoice, with your reason on it, so the invoice still adds
              up line by line. The invoice is then closed and will refuse any further payment.
            </>
          }
          onConfirm={async (reason) => {
            await api.feeCorrections.waive(waiving.id, reason);
            load();
            return 'Waived. The invoice is closed.';
          }}
          onClose={() => setWaiving(null)}
        />
      )}

      {advancing && primary && (
        <AdvanceDialog guardianId={primary.parent.id} guardianName={primary.parent.fullName}
          onClose={() => setAdvancing(false)} onRecorded={load} />
      )}
    </div>
  );
}

/**
 * One receipt. A reversed one stays on the page, struck through and linked to its reversal — hiding it
 * would make a corrected mistake look as though it never happened, which is the opposite of a record.
 */
function ReceiptChip({ payment: p, canReverse, onProof, onReverse }: {
  payment: Payment; canReverse: boolean; onProof: () => void; onReverse: () => void;
}) {
  const reversed = p.reversal !== null;
  return (
    <span className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', opacity: reversed ? 0.75 : 1 }}
      title={reversed ? `Reversed: ${p.reversal!.reason}` : undefined}>
      <span style={{ textDecoration: reversed ? 'line-through' : undefined }}>
        #{p.receiptNo} · {rs(p.amountPaid)}
      </span>
      <span className="muted" style={{ fontSize: 11 }}>{p.method.replace('_', ' ').toLowerCase()}</span>
      {reversed && <span className="badge bad" style={{ fontSize: 11 }}>reversed · {p.reversal!.receiptNo}</span>}
      {p.hasProof && (
        <button type="button" className="ghost small" style={{ padding: '2px 6px', minHeight: 24 }} onClick={onProof}>View proof</button>
      )}
      {canReverse && !reversed && (
        <button type="button" className="ghost small" style={{ padding: '2px 6px', minHeight: 24, color: '#b91c1c' }} onClick={onReverse}>
          Reverse
        </button>
      )}
    </span>
  );
}

/**
 * Record money a guardian paid ahead, held as credit and applied automatically when invoices generate.
 *
 * ⚠️ The Idempotency-Key is created ONCE, when this dialog opens, and reused on every submit. A key
 * minted per click would make a double click two separate deposits.
 */
function AdvanceDialog({ guardianId, guardianName, onClose, onRecorded }: {
  guardianId: string; guardianName: string; onClose: () => void; onRecorded: () => void;
}) {
  const [key] = useState(() => crypto.randomUUID());
  const [amount, setAmount] = useState('');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const value = Number(amount);
  const valid = Number.isFinite(value) && value > 0 && /^\d+(\.\d{1,2})?$/.test(amount.trim());

  async function submit() {
    if (!valid || busy) return;
    setBusy(true); setError(null);
    try {
      await api.feeCorrections.recordAdvance({ parentId: guardianId, amount: value, ...(ref.trim() ? { transactionRef: ref.trim() } : {}) }, key);
      setDone(true);
      onRecorded();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not go through. Nothing was recorded.');
    } finally { setBusy(false); }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Record advance"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 16 }}>
      <div className="card stack" style={{ width: 'min(440px, 100%)', gap: 12, background: '#fff' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Record an advance</h2>
        {done ? (
          <>
            <div className="toast ok" style={{ margin: 0 }} role="status">
              {rs(value)} recorded as credit for {guardianName}. It is applied automatically to their next invoices.
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" onClick={onClose} autoFocus>Done</button></div>
          </>
        ) : (
          <>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              Money <strong>{guardianName}</strong> has paid ahead. It is held as their credit — across all their
              children at this school — and drawn down when invoices are generated.
            </p>
            <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label htmlFor="advance-amount">Amount (Rs)</label>
                <input id="advance-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus disabled={busy} />
              </div>
              <div>
                <label htmlFor="advance-ref">Reference <span className="muted">(optional)</span></label>
                <input id="advance-ref" maxLength={120} value={ref} onChange={(e) => setRef(e.target.value)} disabled={busy} />
              </div>
            </div>
            {error && <div className="toast err" style={{ margin: 0 }} role="alert">{error}</div>}
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <button className="ghost" type="button" disabled={busy} onClick={onClose}>Cancel</button>
              <button type="button" disabled={!valid || busy} onClick={submit}>{busy ? 'Recording…' : 'Record advance'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
