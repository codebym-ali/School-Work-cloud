'use client';

import { useState } from 'react';
import { api, apiGet, type Invoice, type Paged, type StudentDetail } from '@sw/api-client';
import { FEE_CLEARANCE_OVERRIDE_ROLES, hasAnyRole, WITHDRAW_ROLES } from '@sw/roles';
import { useMe } from '@sw/session';
import { ReasonedActionDialog } from '@school/components/reasoned-action-dialog';

const rs = (n: number) => `Rs ${n.toLocaleString()}`;
const today = () => new Date().toISOString().slice(0, 10);
const OWING = new Set(['PENDING', 'PARTIAL', 'OVERDUE']);

/** First day an invoice's billing period covers — the same rule the API applies (`periodStart`). */
const periodStart = (i: { month: number | null; year: number }) => `${i.year}-${String(i.month ?? 1).padStart(2, '0')}-01`;

/**
 * Split a student's unpaid invoices at the leaving date, exactly as the server does:
 *  - OWED: months that had begun by the leaving date. Withdrawal is not a write-off; these stay on record.
 *  - AFTER: months that begin after it. The student was not enrolled for them; withdrawal closes them.
 * Shown so the person sees the outcome before confirming. The server remains the authority.
 */
function splitAt(invoices: Invoice[], leavingDate: string) {
  const unpaid = invoices.filter((i) => OWING.has(i.status));
  const owed = unpaid.filter((i) => periodStart(i) <= leavingDate);
  const after = unpaid.filter((i) => periodStart(i) > leavingDate);
  const sum = (xs: Invoice[]) => xs.reduce((n, i) => n + Math.max(Number(i.totalAmount) - Number(i.paidAmount), 0), 0);
  return { owed, after, owedAmount: sum(owed) };
}

/**
 * Leaving the school (GAP-04).
 *
 * One action that closes the enrolment from the leaving date, closes invoices for months after the
 * student left, disables their portal login, and records who did it and why.
 *
 * ⚠️ Certificates (leaving / fee-clearance) are issued on paper by the office — the system no longer
 * produces them (removed 2026-09-19). The unpaid-fees safeguard remains: only the owner can let a
 * student leave owing money for a month that had begun, and the balance stays on record.
 */
export function WithdrawalCard({ student, onChanged }: { student: StudentDetail; onChanged: () => void }) {
  const me = useMe();
  const canWithdraw = hasAnyRole(me?.roles, WITHDRAW_ROLES);
  const canOverride = hasAnyRole(me?.roles, FEE_CLEARANCE_OVERRIDE_ROLES);
  const [open, setOpen] = useState(false);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [leavingDate, setLeavingDate] = useState(today());
  const [allowOwing, setAllowOwing] = useState(false);

  if (!canWithdraw) return null;

  if (!student.isActive) {
    return (
      <div className="card stack" style={{ gap: 4 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Left the school</h3>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          This student has been withdrawn.
        </p>
      </div>
    );
  }

  async function begin() {
    setLeavingDate(today());
    setAllowOwing(false);
    setOpen(true);
    try {
      setInvoices((await apiGet<Paged<Invoice>>(`/fees/invoices?studentId=${student.id}&pageSize=100`)).data);
    } catch {
      setInvoices([]); // no fee access: the server still decides, and says why if it refuses
    }
  }

  const split = invoices ? splitAt(invoices, leavingDate) : null;
  const owing = !!split && split.owedAmount > 0;
  const blocked = owing && !canOverride;

  return (
    <div className="card stack" style={{ gap: 8 }}>
      <div className="row" style={{ alignItems: 'center' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15 }}>Leaving the school</h3>
          <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>
            Closes the enrolment, stops billing, and turns off the student portal login.
          </p>
        </div>
        <button type="button" className="ghost small" style={{ color: '#b91c1c' }} onClick={begin}>Withdraw student</button>
      </div>

      {open && (
        <ReasonedActionDialog
          title={`Withdraw ${student.fullName}?`}
          confirmLabel="Withdraw student"
          reasonPlaceholder="e.g. Family relocating to Karachi"
          extraReady={!!split && !blocked && (!owing || allowOwing) && leavingDate !== '' && leavingDate <= today()}
          consequence={
            <>
              The enrolment is closed from the leaving date and the student portal login is turned off. This cannot be
              undone from here — a student who returns is admitted again.
            </>
          }
          onConfirm={async (reason) => {
            const res = await api.students.withdraw(student.id, {
              reason, leavingDate, ...(owing && allowOwing ? { overrideFeeClearance: true } : {}),
            });
            onChanged();
            const parts = [
              'Withdrawn.',
              res.leftOwing ? 'Fees remain owed and stay on record.' : 'No fees were outstanding.',
            ];
            if (res.waivedInvoicesAfterLeaving > 0) {
              parts.push(`${res.waivedInvoicesAfterLeaving} invoice${res.waivedInvoicesAfterLeaving === 1 ? '' : 's'} for months after leaving ${res.waivedInvoicesAfterLeaving === 1 ? 'was' : 'were'} closed as not owed.`);
            }
            return parts.join(' ');
          }}
          onClose={() => setOpen(false)}
        >
          <div>
            <label htmlFor="leaving-date">Leaving date</label>
            <input id="leaving-date" type="date" max={today()} value={leavingDate} onChange={(e) => { setLeavingDate(e.target.value); setAllowOwing(false); }} />
            <div className="field-hint">The day the student left. Invoices for months that begin after it are closed as not owed.</div>
          </div>

          {!split ? (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>Checking fees…</p>
          ) : (
            <>
              {split.after.length > 0 && (
                <div className="toast" style={{ margin: 0, fontSize: 13 }}>
                  {split.after.length} invoice{split.after.length === 1 ? '' : 's'} for months after the leaving date will be
                  closed — the student was not enrolled for {split.after.length === 1 ? 'it' : 'them'}.
                </div>
              )}
              {owing && blocked && (
                <div className="toast err" style={{ margin: 0, fontSize: 13 }} role="alert">
                  <strong>{rs(split.owedAmount)} is still owed</strong> for months that had begun. Collect it first, or ask the
                  owner — only the owner can let a student leave owing money.
                </div>
              )}
              {owing && !blocked && (
                <div className="toast warn stack" style={{ margin: 0, gap: 6, fontSize: 13 }}>
                  <span><strong>{rs(split.owedAmount)} is still owed</strong> for months that had begun.</span>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                    <input type="checkbox" checked={allowOwing} onChange={(e) => setAllowOwing(e.target.checked)} style={{ width: 'auto', marginTop: 3 }} />
                    <span>Let them leave owing it. The balance <strong>stays on record</strong> as owed — this is not a waiver.</span>
                  </label>
                </div>
              )}
              {!owing && (
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>Nothing is owed.</p>
              )}
            </>
          )}
        </ReasonedActionDialog>
      )}
    </div>
  );
}
