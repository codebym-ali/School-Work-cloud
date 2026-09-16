'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  api, apiGet, ApiError, type Invoice, type IssuedDocument, type IssuedDocumentType, type Paged, type StudentDetail,
} from '@sw/api-client';
import { FEE_CLEARANCE_OVERRIDE_ROLES, hasAnyRole, ISSUED_DOCUMENT_ROLES, WITHDRAW_ROLES } from '@sw/roles';
import { useMe } from '@sw/session';
import { ReasonedActionDialog } from '@school/components/reasoned-action-dialog';

const rs = (n: number) => `Rs ${n.toLocaleString()}`;
const today = () => new Date().toISOString().slice(0, 10);
const OWING = new Set(['PENDING', 'PARTIAL', 'OVERDUE']);

const DOC_LABEL: Record<string, string> = {
  LEAVING_CERT: 'School leaving certificate',
  CHARACTER_CERT: 'Character certificate',
  FEE_CLEARANCE: 'Fee clearance certificate',
};

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
 * The status screen had long said "leaving the school is handled by the withdrawal process" — a process
 * with no screen. This is it: one action that issues the leaving certificate, closes invoices for months
 * after the student left, disables their portal login, and records who did it and why.
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
          This student has been withdrawn. Their leaving certificate is under <strong>Certificates</strong> below.
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
            Issues the leaving certificate, stops billing, and turns off the student portal login.
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
              A <strong>leaving certificate</strong> is issued, the enrolment is closed from the leaving date, and the
              student portal login is turned off. This cannot be undone from here — a student who returns is admitted again.
            </>
          }
          onConfirm={async (reason) => {
            const res = await api.students.withdraw(student.id, {
              reason, leavingDate, ...(owing && allowOwing ? { overrideFeeClearance: true } : {}),
            });
            onChanged();
            const parts = [
              'Withdrawn. The leaving certificate has been issued.',
              res.feeClearanceId ? 'A fee clearance certificate was issued too.' : 'No fee clearance was issued, because fees are still owed.',
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
                    <span>Let them leave owing it. The balance <strong>stays on record</strong> as owed — this is not a waiver —
                      and no fee clearance certificate will be issued.</span>
                  </label>
                </div>
              )}
              {!owing && (
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>Nothing is owed. A fee clearance certificate will be issued too.</p>
              )}
            </>
          )}
        </ReasonedActionDialog>
      )}
    </div>
  );
}

/**
 * Certificates the school has issued, with download and issue (GAP-14).
 *
 * ⚠️ A FEE CLEARANCE is never offered as an override: it states the student has cleared all fee dues, and no
 * permission makes that true. A LEAVING certificate is offered only for a student who has left — issuing one
 * for an enrolled student would be a school document saying something false.
 */
export function IssuedDocumentsCard({ student }: { student: StudentDetail }) {
  const me = useMe();
  const canSee = hasAnyRole(me?.roles, ISSUED_DOCUMENT_ROLES);
  const canOverride = hasAnyRole(me?.roles, FEE_CLEARANCE_OVERRIDE_ROLES);
  const [docs, setDocs] = useState<IssuedDocument[] | null>(null);
  const [type, setType] = useState<IssuedDocumentType>('CHARACTER_CERT');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [needsOverride, setNeedsOverride] = useState(false);

  const load = useCallback(() => {
    api.issuedDocuments.list(student.id).then(setDocs).catch(() => setDocs([]));
  }, [student.id]);
  useEffect(() => { if (canSee) load(); }, [canSee, load]);

  if (!canSee) return null;

  const types: IssuedDocumentType[] = student.isActive ? ['CHARACTER_CERT', 'FEE_CLEARANCE'] : ['CHARACTER_CERT', 'FEE_CLEARANCE', 'LEAVING_CERT'];

  async function download(id: string) {
    try { window.open((await api.issuedDocuments.url(id)).url, '_blank', 'noopener'); }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not open that document.' }); }
  }

  async function issue(override?: { reason: string }) {
    setBusy(true); setMsg(null);
    try {
      await api.issuedDocuments.issue({ studentId: student.id, type, ...(override ? { overrideFeeClearance: true, reason: override.reason } : {}) });
      setNeedsOverride(false);
      setMsg({ ok: true, text: `${DOC_LABEL[type]} issued.` });
      load();
    } catch (e) {
      // A leaving certificate refused for unpaid fees can be released by the owner; offer exactly that.
      if (e instanceof ApiError && e.status === 409 && type === 'LEAVING_CERT' && canOverride) setNeedsOverride(true);
      else setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not issue that certificate.' });
    } finally { setBusy(false); }
  }

  return (
    <div className="card stack">
      <h3 style={{ margin: 0, fontSize: 15 }}>Certificates</h3>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`} style={{ margin: 0 }} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}

      {docs === null ? <p className="muted" style={{ margin: 0, fontSize: 13 }}>Loading…</p> : docs.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>No certificates issued yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead><tr><th>Certificate</th><th>Issued</th><th /></tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td>{DOC_LABEL[d.type] ?? d.type}</td>
                  <td>{new Date(d.issuedAt).toLocaleDateString()}</td>
                  <td style={{ textAlign: 'right' }}><button type="button" className="ghost small" onClick={() => download(d.id)}>Download</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 240 }}>
          <label htmlFor="issue-type">Issue a certificate</label>
          <select id="issue-type" value={type} onChange={(e) => { setType(e.target.value as IssuedDocumentType); setNeedsOverride(false); setMsg(null); }} disabled={busy}>
            {types.map((t) => <option key={t} value={t}>{DOC_LABEL[t]}</option>)}
          </select>
        </div>
        <button type="button" className="small" disabled={busy} onClick={() => issue()}>{busy ? 'Issuing…' : 'Issue'}</button>
      </div>
      {type === 'FEE_CLEARANCE' && (
        <p className="field-hint" style={{ margin: 0 }}>Only issued when nothing is owed. It states the fees are cleared, so it cannot be overridden.</p>
      )}

      {needsOverride && (
        <ReasonedActionDialog
          title="Release the leaving certificate while fees are owed?"
          confirmLabel="Issue anyway"
          reasonPlaceholder="e.g. New school needs it; balance agreed in instalments"
          consequence={<>Fees are still owed. The certificate is issued and the balance <strong>stays on record</strong> — this is not a waiver.</>}
          onConfirm={async (reason) => { await issue({ reason }); return `${DOC_LABEL.LEAVING_CERT} issued.`; }}
          onClose={() => setNeedsOverride(false)}
        />
      )}
    </div>
  );
}
