'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, apiGet, ApiError, type Campus, type PayrollPayslip, type PayrollRunDetail, type PayrollRunSummary } from '@sw/api-client';
import { useMe } from '@sw/session';
import { ReasonedActionDialog } from '@school/components/reasoned-action-dialog';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const rs = (n: number | string) => `Rs ${Math.round(Number(n)).toLocaleString()}`;
const METHOD_LABEL: Record<string, string> = { CASH: 'Cash', BANK_TRANSFER: 'Bank transfer', CHEQUE: 'Cheque' };

/**
 * Payroll (Cash Payroll Plan): the campus accountant drafts the month and hands over cash; the owner approves.
 *
 * ⚠️ **One screen, two jobs.** The owner sees every campus and the Approve button. The accountant sees their own
 * campus, no Approve — a status line says who they are waiting for — and the running total of cash still to hand
 * over, which is the number they are actually working against on payday.
 *
 * ⚠️ **Every deduction shows its reason**: unpaid leave days, absent days, and whether this school deducts
 * absence. A net figure without its arithmetic cannot be checked before approving, or explained afterwards.
 *
 * The API is the authority on all of it — campus, approval, self-payment. This screen only avoids offering
 * a click the server would refuse.
 */
export default function PayrollPage() {
  const me = useMe();
  const isOwner = (me?.roles ?? []).includes('OWNER_ADMIN');
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
  const [paying, setPaying] = useState<PayrollPayslip | null>(null);

  const loadRuns = useCallback(() => { api.payroll.listRuns().then(setRuns).catch(() => setRuns([])); }, []);
  useEffect(() => {
    loadRuns();
    apiGet<Campus[]>('/campuses').then((c) => {
      // A campus-bound accountant drafts their own campus only.
      const mine = me?.campusId ? c.filter((x) => x.id === me.campusId) : c;
      setCampuses(mine);
      setCampusId((cur) => cur || mine[0]?.id || me?.campusId || '');
    }).catch(() => { if (me?.campusId) setCampusId(me.campusId); });
  }, [loadRuns, me?.campusId]);

  const openRun = async (id: string) => {
    try { setOpen(await api.payroll.getRun(id)); } catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not open that payroll.' }); }
  };

  async function draft() {
    setBusy(true); setMsg(null);
    try {
      const res = await api.payroll.run({ campusId, month, year });
      if (res.alreadyExists) setMsg({ ok: false, text: `${MONTHS[month - 1]} ${year} already has a payroll for this campus. It is opened below.` });
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
      setMsg({ ok: true, text: 'Draft discarded. Draft the month again to pick up the latest attendance and salaries.' });
      setOpen(null);
      loadRuns();
    } catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not discard.' }); }
    finally { setBusy(false); }
  }

  const total = open ? open.payslips.reduce((n, p) => n + Number(p.netPay), 0) : 0;
  const unpaid = open ? open.payslips.filter((p) => !p.paidAt) : [];
  const toHandOver = unpaid.reduce((n, p) => n + Number(p.netPay), 0);
  const campusName = campuses.find((c) => c.id === campusId)?.name;

  return (
    <div className="stack">
      <div className="stack" style={{ gap: 4 }}>
        <h1 style={{ marginBottom: 0 }}>Payroll{!isOwner && campusName ? ` · ${campusName}` : ''}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {isOwner
            ? 'The campus accountant drafts each month and hands over salaries. You check the draft and approve it.'
            : 'Draft the month, check each person’s pay, and once the owner approves, record each salary as you hand it over.'}
        </p>
      </div>

      <div className="card grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10, alignItems: 'end' }}>
        {isOwner && campuses.length > 1 && (
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

      {open && (
        <div className="card stack" style={{ gap: 10 }}>
          <div className="row" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>{MONTHS[open.month - 1]} {open.year} · {open.campusName}</h2>
            <span className={`badge ${open.status === 'APPROVED' ? 'ok' : 'warn'}`}>{open.status === 'APPROVED' ? 'Approved' : 'Draft'}</span>
            <span style={{ flex: 1 }} />
            {open.status === 'DRAFT' && (
              <>
                <button type="button" className="ghost small" disabled={busy} onClick={discard}>Discard draft</button>
                {isOwner && <button type="button" className="small" disabled={busy || open.payslips.length === 0} onClick={() => setApproving(true)}>Approve</button>}
              </>
            )}
          </div>

          {/* The summary answers each role's question: owner — what am I committing to; accountant — what is left to pay. */}
          <div className="row" style={{ gap: 18, flexWrap: 'wrap', fontVariantNumeric: 'tabular-nums' }}>
            <span><span className="muted">Total net pay</span> <strong>{rs(total)}</strong></span>
            <span><span className="muted">People</span> <strong>{open.payslips.length}</strong></span>
            {open.status === 'APPROVED' && (
              <span><span className="muted">Paid</span> <strong>{open.payslips.length - unpaid.length} of {open.payslips.length}</strong>
                {toHandOver > 0 && <> · <span className="muted">still to hand over</span> <strong>{rs(toHandOver)}</strong></>}
              </span>
            )}
          </div>

          {open.status === 'DRAFT' && !isOwner && (
            <p className="muted" style={{ margin: 0 }}>Draft — waiting for the owner to approve. Salaries can be recorded as paid once it is approved.</p>
          )}

          {open.excluded.length > 0 && (
            <div className="toast warn" style={{ margin: 0 }}>
              <strong>Not in this payroll (no salary set):</strong> {open.excluded.map((x) => `${x.email} (${x.employeeCode})`).join(', ')}.
              {' '}Ask the owner or campus admin to set their salary on the Staff screen, then discard this draft and draft it again.
            </div>
          )}

          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>Staff</th><th style={{ textAlign: 'right' }}>Salary</th><th>Why deducted</th><th style={{ textAlign: 'right' }}>Deduction</th><th style={{ textAlign: 'right' }}>Net to pay</th><th>Paid</th></tr></thead>
              <tbody>
                {open.payslips.map((p) => {
                  const b = p.breakdown;
                  const self = p.staffUserId === me?.id;
                  const deduction = Number(p.attendanceDeduction) + Number(p.otherDeductions);
                  const reasons = [
                    b.unpaidLeaveDays ? `${b.unpaidLeaveDays} unpaid leave ${b.unpaidLeaveDays === 1 ? 'day' : 'days'}` : '',
                    b.absentDays ? `${b.absentDays} absent ${b.absentDays === 1 ? 'day' : 'days'}${b.deductForAbsence ? '' : ' (not deducted — school setting)'}` : '',
                    b.fixedDeductions ? `fixed ${rs(b.fixedDeductions)}` : '',
                  ].filter(Boolean);
                  return (
                    <tr key={p.id}>
                      <td>
                        <strong>{p.staffName}</strong>{self && <span className="muted"> (you)</span>}
                        <div className="muted" style={{ fontSize: 12 }}>{p.employeeCode} · {p.designation}</div>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {rs(b.basic)}
                        {b.allowances > 0 && <div className="muted" style={{ fontSize: 12 }}>+ {rs(b.allowances)} allowances</div>}
                      </td>
                      <td style={{ fontSize: 13 }}>
                        {reasons.length ? reasons.join(' · ') : <span className="muted">Nothing</span>}
                        {reasons.length > 0 && <div className="muted" style={{ fontSize: 12 }}>{b.workingDays} working days this month</div>}
                      </td>
                      <td style={{ textAlign: 'right' }}>{deduction > 0 ? `− ${rs(deduction)}` : '—'}</td>
                      <td style={{ textAlign: 'right' }}><strong>{rs(p.netPay)}</strong></td>
                      <td>
                        {p.paidAt ? (
                          <span className="badge ok" title={p.paymentRef ?? undefined}>
                            {new Date(p.paidAt).toLocaleDateString('en-GB')} · {METHOD_LABEL[p.paymentMethod ?? ''] ?? 'Paid'}
                            {p.paidBy && <> · by {p.paidBy === me?.email ? 'you' : p.paidBy}</>}
                          </span>
                        ) : open.status !== 'APPROVED' ? (
                          <span className="muted">After approval</span>
                        ) : self ? (
                          <span className="muted" style={{ fontSize: 12 }}>Someone else records yours</span>
                        ) : (
                          <button type="button" className="small" onClick={() => setPaying(p)}>Mark paid</button>
                        )}
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
        {runs === null ? <span className="muted">Loading…</span> : runs.length === 0 ? <span className="muted">No payroll has been drafted yet.</span> : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>Month</th>{isOwner && <th>Campus</th>}<th>Status</th><th style={{ textAlign: 'right' }}>Net pay</th><th>Paid</th><th /></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{MONTHS[r.month - 1]} {r.year}</td>
                    {isOwner && <td>{r.campusName}</td>}
                    <td><span className={`badge ${r.status === 'APPROVED' ? 'ok' : 'warn'}`}>{r.status === 'APPROVED' ? 'Approved' : 'Draft'}</span></td>
                    <td style={{ textAlign: 'right' }}>{rs(r.totalNet)}</td>
                    <td>{r.status === 'APPROVED' ? `${r.paid} of ${r.payslips}` : '—'}</td>
                    <td style={{ textAlign: 'right' }}><button type="button" className="ghost small" onClick={() => openRun(r.id)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {approving && open && (
        <ReasonedActionDialog
          title={`Approve ${MONTHS[open.month - 1]} ${open.year} payroll?`}
          confirmLabel="Approve payroll"
          destructive={false}
          reasonLabel="Note for the record"
          reasonPlaceholder="e.g. Checked against the attendance register"
          consequence={<>{open.payslips.length} people, net <strong>{rs(total)}</strong>. Approving is final: the month&apos;s attendance and leave are locked, each person can see their payslip, and the accountant can start recording salaries as paid.</>}
          onConfirm={async () => {
            await api.payroll.approve(open.id);
            loadRuns();
            await openRun(open.id);
            return 'Approved. The accountant can now record salaries as paid.';
          }}
          onClose={() => setApproving(false)}
        />
      )}

      {paying && open && (
        <MarkPaid payslip={paying} period={`${MONTHS[open.month - 1]} ${open.year}`} onClose={() => setPaying(null)}
          onDone={async () => { setPaying(null); setMsg({ ok: true, text: `${paying.staffName}'s salary recorded as paid.` }); loadRuns(); await openRun(open.id); }} />
      )}
    </div>
  );
}

/** Record a salary as handed over. Cash is preselected — it is how the schools pay. */
function MarkPaid({ payslip, period, onClose, onDone }: { payslip: PayrollPayslip; period: string; onClose: () => void; onDone: () => void }) {
  const [method, setMethod] = useState<'CASH' | 'BANK_TRANSFER' | 'CHEQUE'>('CASH');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="mp-title"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 16 }}>
      <div className="card stack" style={{ width: 'min(420px, 100%)', gap: 10, background: 'var(--card, #fff)' }}>
        <h2 id="mp-title" style={{ margin: 0, fontSize: 17 }}>Record salary payment</h2>
        <div className="row" style={{ justifyContent: 'space-between', fontVariantNumeric: 'tabular-nums' }}>
          <span>{payslip.staffName} · {period}</span><strong>{rs(payslip.netPay)}</strong>
        </div>
        <div><label htmlFor="mp-method">Paid by</label>
          <select id="mp-method" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            <option value="CASH">Cash</option><option value="BANK_TRANSFER">Bank transfer</option><option value="CHEQUE">Cheque</option>
          </select>
        </div>
        <div><label htmlFor="mp-ref">{method === 'CASH' ? 'Note' : 'Reference'} <span className="muted">(optional)</span></label>
          <input id="mp-ref" maxLength={120} placeholder={method === 'CASH' ? 'e.g. handed over at the office' : 'e.g. transaction or cheque number'} value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
        <p className="field-hint" style={{ margin: 0 }}>Recorded once, in your name. It cannot be changed afterwards.</p>
        {err && <div className="toast err" style={{ margin: 0 }} role="alert">{err}</div>}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" disabled={busy} onClick={async () => {
            setBusy(true); setErr(null);
            try { await api.payroll.markPaid(payslip.id, { method, ...(reference.trim() ? { reference: reference.trim() } : {}) }); onDone(); }
            catch (e) {
              setErr(e instanceof ApiError
                ? (e.code === 'MFA_ENROLMENT_REQUIRED' ? 'Set up two-factor authentication under Security first.' : e.message)
                : 'Could not record the payment.');
              setBusy(false);
            }
          }}>{busy ? 'Saving…' : method === 'CASH' ? 'Record cash payment' : 'Record payment'}</button>
        </div>
      </div>
    </div>
  );
}
