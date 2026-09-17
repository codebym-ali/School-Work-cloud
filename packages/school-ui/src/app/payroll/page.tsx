'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, apiGet, ApiError, type Campus, type PayrollRunDetail, type PayrollRunSummary } from '@sw/api-client';
import { ReasonedActionDialog } from '@school/components/reasoned-action-dialog';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const rs = (n: number | string) => `Rs ${Math.round(Number(n)).toLocaleString()}`;

/**
 * Payroll (GAP-05): draft a month, review each payslip and WHY it came to that, approve, then record payment.
 *
 * The engine already read attendance, unpaid leave and closures. There was no way to see, approve or pay what it
 * produced — and staff opened "My Payslips" to an empty page every month.
 *
 * ⚠️ **Every deduction shows its reason** — working days, days absent, unpaid leave, and whether this school
 * deducts for absence. A net figure without its arithmetic is a figure nobody can check before approving.
 *
 * ⚠️ **A draft can be discarded and run again.** Attendance corrected or a salary set after drafting used to be
 * unable to reach that month. Approval is final: approved months settle attendance and closures.
 */
export default function PayrollPage() {
  const now = new Date();
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [campusId, setCampusId] = useState('');
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [runs, setRuns] = useState<PayrollRunSummary[] | null>(null);
  const [open, setOpen] = useState<PayrollRunDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [approving, setApproving] = useState(false);
  const [paying, setPaying] = useState<string | null>(null);

  const loadRuns = useCallback(() => { api.payroll.listRuns().then(setRuns).catch(() => setRuns([])); }, []);
  useEffect(() => {
    loadRuns();
    apiGet<Campus[]>('/campuses').then((c) => { setCampuses(c); setCampusId((cur) => cur || c[0]?.id || ''); }).catch(() => {});
  }, [loadRuns]);

  const openRun = async (id: string) => {
    setMsg(null);
    try { setOpen(await api.payroll.getRun(id)); } catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not open that run.' }); }
  };

  async function draft() {
    setBusy(true); setMsg(null);
    try {
      const res = await api.payroll.run({ campusId, month, year });
      if (res.alreadyExists) setMsg({ ok: false, text: 'This month already has a payroll run for that campus — it is opened below.' });
      loadRuns();
      await openRun(res.runId);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not start payroll.' });
    } finally { setBusy(false); }
  }

  async function discard() {
    if (!open) return;
    setBusy(true);
    try {
      await api.payroll.discard(open.id);
      setMsg({ ok: true, text: 'Draft discarded. Run the month again to pick up the latest attendance and salaries.' });
      setOpen(null);
      loadRuns();
    } catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not discard.' }); }
    finally { setBusy(false); }
  }

  const totals = open ? open.payslips.reduce((t, p) => ({ gross: t.gross + Number(p.gross), net: t.net + Number(p.netPay) }), { gross: 0, net: 0 }) : null;

  return (
    <div className="stack">
      <div className="stack" style={{ gap: 4 }}>
        <h1 style={{ marginBottom: 0 }}>Payroll</h1>
        <p className="muted" style={{ margin: 0 }}>Draft a month, check each payslip, approve it, then record payments.</p>
      </div>

      <div className="card grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10, alignItems: 'end' }}>
        {campuses.length > 1 && (
          <div><label htmlFor="pr-campus">Campus</label>
            <select id="pr-campus" value={campusId} onChange={(e) => setCampusId(e.target.value)}>
              {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <div><label htmlFor="pr-month">Month</label>
          <select id="pr-month" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <div><label htmlFor="pr-year">Year</label><input id="pr-year" type="number" min={2000} max={3000} value={year} onChange={(e) => setYear(Number(e.target.value))} /></div>
        <div><button type="button" disabled={!campusId || busy} onClick={draft}>{busy ? 'Working…' : 'Draft payroll'}</button></div>
      </div>

      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}

      {open && totals && (
        <div className="card stack" style={{ gap: 10 }}>
          <div className="row" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>{MONTHS[open.month - 1]} {open.year} · {open.campusName}</h2>
            <span className={`badge ${open.status === 'APPROVED' ? 'ok' : 'warn'}`}>{open.status === 'APPROVED' ? 'Approved' : 'Draft'}</span>
            <span className="muted">{open.payslips.length} payslips · gross {rs(totals.gross)} · net {rs(totals.net)}</span>
            <span style={{ flex: 1 }} />
            {open.status === 'DRAFT' && (
              <>
                <button type="button" className="ghost small" disabled={busy} onClick={discard}>Discard draft</button>
                <button type="button" className="small" disabled={busy || open.payslips.length === 0} onClick={() => setApproving(true)}>Approve</button>
              </>
            )}
          </div>

          {open.excluded.length > 0 && (
            <div className="toast warn" style={{ margin: 0 }}>
              <strong>Not in this payroll:</strong> {open.excluded.map((x) => `${x.email} (${x.employeeCode})`).join(', ')} — no salary set.
              Set one on the Staff screen, then discard this draft and run it again.
            </div>
          )}

          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>Staff</th><th style={{ textAlign: 'right' }}>Gross</th><th>Why deducted</th><th style={{ textAlign: 'right' }}>Deductions</th><th style={{ textAlign: 'right' }}>Net</th><th>Paid</th></tr></thead>
              <tbody>
                {open.payslips.map((p) => {
                  const b = p.breakdown;
                  const reasons = [
                    b.unpaidLeaveDays ? `${b.unpaidLeaveDays} unpaid leave day${b.unpaidLeaveDays === 1 ? '' : 's'}` : '',
                    b.absentDays ? `${b.absentDays} absent${b.deductForAbsence ? '' : ' (not deducted — school setting)'}` : '',
                    b.fixedDeductions ? `fixed ${rs(b.fixedDeductions)}` : '',
                  ].filter(Boolean);
                  return (
                    <tr key={p.id}>
                      <td>{p.email}<div className="muted" style={{ fontSize: 12 }}>{p.employeeCode} · {p.designation}</div></td>
                      <td style={{ textAlign: 'right' }}>{rs(p.gross)}</td>
                      <td style={{ fontSize: 13 }}>
                        {reasons.length ? reasons.join(' · ') : <span className="muted">Nothing</span>}
                        <div className="muted" style={{ fontSize: 12 }}>{b.workingDays} working days this month</div>
                      </td>
                      <td style={{ textAlign: 'right' }}>{rs(Number(p.attendanceDeduction) + Number(p.otherDeductions))}</td>
                      <td style={{ textAlign: 'right' }}><strong>{rs(p.netPay)}</strong></td>
                      <td>
                        {p.paidAt
                          ? <span className="badge ok" title={p.paymentRef ?? undefined}>{new Date(p.paidAt).toLocaleDateString()}</span>
                          : open.status === 'APPROVED'
                            ? <button type="button" className="ghost small" onClick={() => setPaying(p.id)}>Mark paid</button>
                            : <span className="muted">After approval</span>}
                        {open.status === 'APPROVED' && (
                          <button type="button" className="ghost small" style={{ marginLeft: 4 }}
                            onClick={async () => { try { window.open((await api.payslips.pdf(p.id)).url, '_blank', 'noopener'); } catch { /* transient */ } }}>
                            PDF
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card stack" style={{ gap: 6 }}>
        <strong>Payroll history</strong>
        {runs === null ? <span className="muted">Loading…</span> : runs.length === 0 ? <span className="muted">No payroll has been run yet.</span> : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>Month</th><th>Campus</th><th>Status</th><th style={{ textAlign: 'right' }}>Payslips</th><th style={{ textAlign: 'right' }}>Net</th><th>Paid</th><th /></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{MONTHS[r.month - 1]} {r.year}</td>
                    <td>{r.campusName}</td>
                    <td><span className={`badge ${r.status === 'APPROVED' ? 'ok' : 'warn'}`}>{r.status === 'APPROVED' ? 'Approved' : 'Draft'}</span></td>
                    <td style={{ textAlign: 'right' }}>{r.payslips}</td>
                    <td style={{ textAlign: 'right' }}>{rs(r.totalNet)}</td>
                    <td>{r.paid} of {r.payslips}</td>
                    <td style={{ textAlign: 'right' }}><button type="button" className="ghost small" onClick={() => openRun(r.id)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {approving && open && totals && (
        <ReasonedActionDialog
          title={`Approve ${MONTHS[open.month - 1]} ${open.year} payroll?`}
          confirmLabel="Approve payroll"
          destructive={false}
          reasonLabel="Note for the record"
          reasonPlaceholder="e.g. Checked against the attendance register"
          consequence={<>{open.payslips.length} payslips, net <strong>{rs(totals.net)}</strong>. Approval is final: the month&apos;s attendance and closures are settled, and payslips become visible to staff.</>}
          onConfirm={async () => {
            await api.payroll.approve(open.id);
            loadRuns();
            await openRun(open.id);
            return 'Approved. You can now record payments.';
          }}
          onClose={() => setApproving(false)}
        />
      )}

      {paying && open && (
        <MarkPaid payslipId={paying} onClose={() => setPaying(null)} onDone={async () => { setPaying(null); loadRuns(); await openRun(open.id); }} />
      )}
    </div>
  );
}

function MarkPaid({ payslipId, onClose, onDone }: { payslipId: string; onClose: () => void; onDone: () => void }) {
  const [method, setMethod] = useState<'BANK_TRANSFER' | 'CASH' | 'CHEQUE'>('BANK_TRANSFER');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div role="dialog" aria-modal="true" aria-label="Record salary payment"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 16 }}>
      <div className="card stack" style={{ width: 'min(420px, 100%)', gap: 10, background: '#fff' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Record salary payment</h2>
        <div><label htmlFor="mp-method">Paid by</label>
          <select id="mp-method" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            <option value="BANK_TRANSFER">Bank transfer</option><option value="CASH">Cash</option><option value="CHEQUE">Cheque</option>
          </select>
        </div>
        <div><label htmlFor="mp-ref">Reference <span className="muted">(optional)</span></label><input id="mp-ref" maxLength={120} value={reference} onChange={(e) => setReference(e.target.value)} /></div>
        <p className="field-hint" style={{ margin: 0 }}>Recorded once. It cannot be changed afterwards.</p>
        {err && <div className="toast err" style={{ margin: 0 }} role="alert">{err}</div>}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" disabled={busy} onClick={async () => {
            setBusy(true); setErr(null);
            try { await api.payroll.markPaid(payslipId, { method, ...(reference.trim() ? { reference: reference.trim() } : {}) }); onDone(); }
            catch (e) { setErr(e instanceof ApiError ? (e.code === 'MFA_ENROLMENT_REQUIRED' ? 'Set up two-factor authentication under Security first.' : e.message) : 'Could not record the payment.'); setBusy(false); }
          }}>{busy ? 'Saving…' : 'Record payment'}</button>
        </div>
      </div>
    </div>
  );
}
