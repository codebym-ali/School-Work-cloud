'use client';

import { humanizeStatus } from '@sw/ui';
import { useCallback, useEffect, useState } from 'react';
import {
  api, apiGet, apiPost, ApiError, idemKey,
  PAYMENT_METHOD_LABEL,
  type AcademicYear, type Campus, type FeeHead, type FeeStructure, type Invoice, type Klass,
  type Paged, type PaymentMethodKey, type SchoolSettings, type Student,
} from '@sw/api-client';
import { hasModule, useMe } from '@sw/session';
import { isSchoolWideAdmin } from '@sw/roles';
import { classLabeller } from '@school/lib/labels';
import { FeePlanPanel } from './fee-plan-panel';
import { ConfirmDialog } from '../classes/confirm-dialog';
import FeeClaimsPage from '../fee-claims/page';
import DefaultersPage from '../defaulters/page';

type FeeTab = 'invoices' | 'payments' | 'defaulters';

export default function FeesPage() {
  const [tab, setTab] = useState<FeeTab>('invoices');
  return (
    <div className="stack">
      <div className="row">
        <h1>Fees</h1>
        <div className="ov-tab-bar" style={{ display: 'flex', gap: 4, background: '#edf0f5', padding: 4, borderRadius: 10 }}>
          <button type="button" className={`ov-tab${tab === 'invoices' ? ' is-active' : ''}`} onClick={() => setTab('invoices')}>Invoices</button>
          <button type="button" className={`ov-tab${tab === 'payments' ? ' is-active' : ''}`} onClick={() => setTab('payments')}>Payments</button>
          <button type="button" className={`ov-tab${tab === 'defaulters' ? ' is-active' : ''}`} onClick={() => setTab('defaulters')}>Defaulters</button>
        </div>
      </div>
      {tab === 'invoices' && <FeesInvoicesPanel />}
      {tab === 'payments' && <FeeClaimsPage embedded />}
      {tab === 'defaulters' && <DefaultersPage embedded />}
    </div>
  );
}

function FeesInvoicesPanel() {
  const now = new Date();
  const me = useMe();
  const canConfigure = isSchoolWideAdmin(me?.roles);
  const canInvoicing = hasModule(me, 'fees.invoicing');
  const canPayments = hasModule(me, 'fees.payments');
  const [classes, setClasses] = useState<Klass[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [heads, setHeads] = useState<FeeHead[]>([]);
  const [structures, setStructures] = useState<FeeStructure[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [batch, setBatch] = useState({ classId: '', month: String(now.getMonth() + 1), year: String(now.getFullYear()) });
  const [paying, setPaying] = useState<string | null>(null);
  const [pay, setPay] = useState({ amountPaid: '', method: 'CASH', transactionRef: '', proofFileKey: '' });
  const [uploading, setUploading] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [justPaid, setJustPaid] = useState<{ paymentId: string; receiptNo: number } | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [settings, setSettings] = useState<SchoolSettings | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const classLabel = classLabeller(classes, campuses);

  /**
   * Hand the family a link instead of chasing a WhatsApp screenshot.
   *
   * Copied to the clipboard rather than opened: the clerk pastes it into WhatsApp or an SMS,
   * which is how these actually reach a parent here. The link is a bearer credential for one
   * invoice, so the button is deliberately per-row and never bulk.
   */
  async function copyLink(invoiceId: string) {
    setLinking(invoiceId);
    try {
      const { url } = await apiPost<{ url: string }>(`/fees/invoices/${invoiceId}/guardian-link`, {});
      await navigator.clipboard.writeText(url);
      setCopied(invoiceId);
      setMsg({ ok: true, text: 'Payment link copied — send it to the guardian.' });
      setTimeout(() => setCopied(null), 4000);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not make a link' });
    } finally {
      setLinking(null);
    }
  }

  async function loadInvoices() {
    const res = await apiGet<Paged<Invoice>>('/fees/invoices?pageSize=100');
    setInvoices(res.data);
  }
  const loadSetup = useCallback(async () => {
    const [h, s] = await Promise.all([
      api.feeSetup.heads().catch(() => [] as FeeHead[]),
      api.feeSetup.structures().catch(() => [] as FeeStructure[]),
    ]);
    setHeads(h); setStructures(s);
  }, []);
  useEffect(() => {
    apiGet<Klass[]>('/classes').then(setClasses).catch(() => {});
    apiGet<Campus[]>('/campuses').then(setCampuses).catch(() => {});
    apiGet<AcademicYear[]>('/academic-years').then(setYears).catch(() => {});
    apiGet<Paged<Student>>('/students?pageSize=100').then((r) => setNames(Object.fromEntries(r.data.map((s) => [s.id, `${s.fullName} (${s.grNumber})`])))).catch(() => {});
    loadInvoices().catch(() => {});
    loadSetup().catch(() => {});
    // Fails silently for a role the API denies (an accountant reads it, a clerk may not) —
    // the form then falls back to cash, which every school accepts.
    api.schoolSettings.get().then(setSettings).catch(() => {});
  }, [loadSetup]);

  const selectedHasStructure = !batch.classId || structures.some((s) => s.classId === batch.classId);

  async function generate() {
    try {
      const res = await apiPost<{ generated: number; alreadyExists: boolean }>('/fees/invoice-batches', { classId: batch.classId, month: Number(batch.month), year: Number(batch.year) });
      setMsg({ ok: true, text: res.alreadyExists ? 'Batch already existed' : `Generated ${res.generated} invoice(s)` });
      await loadInvoices();
    } catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed' }); }
  }

  /**
   * A cheque is not money until it clears (D3), so it is recorded as a SUBMISSION rather than
   * collected into a receipt. The clerk still does one thing at the counter; what changes is that
   * the family is told when it becomes a payment, instead of being handed a receipt for money the
   * school does not have yet.
   */
  async function recordCheque(id: string) {
    try {
      const claim = await api.feeSetup.submitClaim({
        invoiceId: id,
        amount: Number(pay.amountPaid),
        method: 'CHEQUE',
        ...(pay.transactionRef.trim() ? { transactionRef: pay.transactionRef.trim() } : {}),
        paidOn: new Date().toISOString().slice(0, 10),
        ...(pay.proofFileKey ? { proofFileKey: pay.proofFileKey } : {}),
      });
      const clears = claim.clearsOn ? new Date(claim.clearsOn).toLocaleDateString('en-GB') : null;
      setMsg({
        ok: true,
        text: clears
          ? `Cheque recorded. It clears on ${clears} — verify it under Payment submissions then, or reject it if it bounces.`
          : 'Cheque recorded as a submission.',
      });
      setPaying(null); setPay({ amountPaid: '', method: acceptedMethods[0], transactionRef: '', proofFileKey: '' });
      await loadInvoices();
    } catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not record that cheque' }); }
  }

  async function collect(id: string) {
    // The server refuses a direct cheque payment; routing here keeps the clerk from meeting that
    // refusal as an error when what they did was perfectly reasonable.
    if (pay.method === 'CHEQUE') return recordCheque(id);
    try {
      const res = await apiPost<{ paymentId: string; receiptNo: number }>(`/fees/invoices/${id}/payments`, {
        amountPaid: Number(pay.amountPaid),
        method: pay.method,
        ...(pay.transactionRef.trim() ? { transactionRef: pay.transactionRef.trim() } : {}),
        ...(pay.proofFileKey ? { proofFileKey: pay.proofFileKey } : {}),
      }, idemKey());
      setMsg({ ok: true, text: `Payment recorded — receipt #${res.receiptNo}` });
      // The family is standing at the counter NOW, so the receipt is offered here rather than
      // being something the clerk has to go and find afterwards.
      setJustPaid({ paymentId: res.paymentId, receiptNo: res.receiptNo });
      setPaying(null); setPay({ amountPaid: '', method: acceptedMethods[0], transactionRef: '', proofFileKey: '' });
      await loadInvoices();
    } catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Payment failed' }); }
  }

  /** Presigned and short-lived, so it is fetched on the click, not rendered as a stale href. */
  async function openReceipt(paymentId: string) {
    try {
      const { url } = await apiGet<{ url: string }>(`/fees/payments/${paymentId}/receipt`);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not open that receipt' });
    }
  }

  /** Straight to storage, virus-scanned, then we keep only the key it comes back with. */
  async function attachProof(file: File) {
    setUploading(true);
    try {
      const { fileKey } = await api.uploads.upload(file);
      setPay((p) => ({ ...p, proofFileKey: fileKey }));
      setMsg({ ok: true, text: 'Proof attached' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Could not attach that file' });
    } finally { setUploading(false); }
  }

  const acceptedMethods = settings?.feeSubmission.methods ?? (['CASH'] as PaymentMethodKey[]);
  const proofPolicy = settings?.feeSubmission.proofPolicy ?? 'OPTIONAL';

  const badge = (s: string) => s === 'PAID' ? 'ok' : s === 'OVERDUE' ? 'bad' : s === 'WAIVED' ? '' : 'warn';

  return (
    <div className="stack">
      {canConfigure && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="ghost" onClick={() => setSetupOpen((v) => !v)}>
            {setupOpen ? 'Close fee setup' : '⚙ Fee setup'}
          </button>
        </div>
      )}
      {invoices.length > 0 && (() => {
        const billed = invoices.reduce((s, i) => s + Number(i.totalAmount), 0);
        const collected = invoices.reduce((s, i) => s + Number(i.paidAmount), 0);
        const outstanding = billed - collected;
        const overdue = invoices.filter((i) => i.status === 'OVERDUE').reduce((s, i) => s + Number(i.totalAmount) - Number(i.paidAmount), 0);
        const rs = (n: number) => `Rs ${Math.round(n).toLocaleString()}`;
        return (
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div className="card" style={{ flex: 1, minWidth: 140, padding: '12px 16px' }}>
              <div className="muted" style={{ fontSize: 12 }}>Total billed</div>
              <strong style={{ fontSize: 18 }}>{rs(billed)}</strong>
            </div>
            <div className="card" style={{ flex: 1, minWidth: 140, padding: '12px 16px' }}>
              <div className="muted" style={{ fontSize: 12 }}>Collected</div>
              <strong style={{ fontSize: 18, color: 'var(--green, #16a34a)' }}>{rs(collected)}</strong>
            </div>
            <div className="card" style={{ flex: 1, minWidth: 140, padding: '12px 16px' }}>
              <div className="muted" style={{ fontSize: 12 }}>Outstanding</div>
              <strong style={{ fontSize: 18, color: 'var(--amber, #d97706)' }}>{rs(outstanding)}</strong>
            </div>
            {overdue > 0 && (
              <div className="card" style={{ flex: 1, minWidth: 140, padding: '12px 16px' }}>
                <div className="muted" style={{ fontSize: 12 }}>Overdue</div>
                <strong style={{ fontSize: 18, color: 'var(--red, #dc2626)' }}>{rs(overdue)}</strong>
              </div>
            )}
          </div>
        );
      })()}
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}
      {/* Offered at the counter, in the moment — not a thing the clerk has to go and find. */}
      {justPaid && (
        <div className="card row" style={{ alignItems: 'center', gap: 10 }}>
          <strong>Receipt #{justPaid.receiptNo} is ready</strong>
          <span className="row" style={{ gap: 8, marginLeft: 'auto' }}>
            <button className="small" onClick={() => void openReceipt(justPaid.paymentId)}>⬇ Open receipt (PDF)</button>
            <button className="ghost small" onClick={() => setJustPaid(null)}>Dismiss</button>
          </span>
        </div>
      )}

      {canConfigure && setupOpen && (
        <FeeSetupPanel
          heads={heads} structures={structures} classes={classes} years={years}
          classLabel={classLabel}
          onMsg={(ok, text) => setMsg({ ok, text })}
          reload={loadSetup} />
      )}

      {canInvoicing && (
      <div className="card stack">
        <h2 style={{ margin: 0, fontSize: 17 }}>Generate invoices (monthly)</h2>
        <div className="inline-form">
          <div><label>Class</label>
            <select aria-label="Class" value={batch.classId} onChange={(e) => setBatch({ ...batch, classId: e.target.value })}>
              <option value="">Select…</option>{classes.map((c) => <option key={c.id} value={c.id}>{classLabel(c)}</option>)}
            </select>
          </div>
          <div style={{ maxWidth: 90 }}><label>Month</label><input value={batch.month} onChange={(e) => setBatch({ ...batch, month: e.target.value })} /></div>
          <div style={{ maxWidth: 110 }}><label>Year</label><input value={batch.year} onChange={(e) => setBatch({ ...batch, year: e.target.value })} /></div>
          <button onClick={generate} disabled={!batch.classId || !selectedHasStructure}>Generate</button>
        </div>
        {!selectedHasStructure ? (
          <div className="toast err" style={{ margin: 0 }}>
            This class has no fee structure yet, so no invoices can be generated.
            {canConfigure
              ? <> Open <b>⚙ Fee setup</b> above to add one.</>
              : <> Ask the owner or an operations admin to add one under Fee setup.</>}
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>Invoices come from the class&apos;s fee structure. Already generated? Running again won&apos;t create duplicates.</p>
        )}
      </div>
      )}

      <table>
        <thead><tr><th>Student</th><th>Period</th><th>Total</th><th>Paid</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {invoices.map((i) => (
            <tr key={i.id}>
              {/* From the row. The map fallback below only covers the first page of students. */}
              <td>{i.student ? `${i.student.fullName} (${i.student.grNumber})` : names[i.studentId] ?? i.studentId.slice(0, 8)}</td>
              <td>{i.month ? `${i.month}/${i.year}` : i.year}</td>
              <td>Rs {Number(i.totalAmount).toLocaleString()}</td>
              <td>Rs {Number(i.paidAmount).toLocaleString()}</td>
              <td><span className={`badge ${badge(i.status)}`}>{humanizeStatus(i.status)}</span></td>
              <td>
                {canPayments && i.status !== 'PAID' && i.status !== 'WAIVED' && (
                  paying === i.id ? (
                    <span className="inline-form">
                      <input style={{ width: 90 }} placeholder="Amount" value={pay.amountPaid} onChange={(e) => setPay({ ...pay, amountPaid: e.target.value })} />
                      {/* Only what the school actually accepts — the API refuses anything else,
                          so offering a method here that would be rejected is a trap. */}
                      <select style={{ width: 150 }} value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                        {acceptedMethods.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABEL[m]}</option>)}
                      </select>
                      {/* Cash over the counter has no reference and no screenshot; asking for
                          either would make the commonest payment the most awkward one. */}
                      {pay.method !== 'CASH' && (
                        <input style={{ width: 130 }} placeholder="Reference no."
                          value={pay.transactionRef} onChange={(e) => setPay({ ...pay, transactionRef: e.target.value })} />
                      )}
                      {pay.method !== 'CASH' && proofPolicy !== 'OFF' && (
                        pay.proofFileKey ? (
                          <span className="badge ok">✓ proof attached</span>
                        ) : (
                          <label className="ghost small" style={{ padding: '4px 8px', cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 6 }}>
                            {uploading ? 'Uploading…' : proofPolicy === 'REQUIRED' ? '📎 Attach proof *' : '📎 Attach proof'}
                            <input type="file" accept="image/jpeg,image/png,application/pdf" style={{ display: 'none' }}
                              onChange={(e) => { const f = e.target.files?.[0]; if (f) void attachProof(f); }} />
                          </label>
                        )
                      )}
                      <button className="small"
                        disabled={uploading || (proofPolicy === 'REQUIRED' && pay.method !== 'CASH' && !pay.proofFileKey)}
                        onClick={() => collect(i.id)}>Save</button>
                      <button className="ghost small" onClick={() => setPaying(null)}>×</button>
                    </span>
                  ) : (
                    <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      {/* Only when the school has switched the link on, and only for a bill that
                          still owes something — a link to a settled invoice is a dead end. */}
                      {settings?.feeSubmission.guardianUploadLink && i.status !== 'PAID' && (
                        <button className="ghost small" disabled={linking === i.id} onClick={() => void copyLink(i.id)}>
                          {linking === i.id ? 'Making…' : copied === i.id ? '✓ Copied' : '🔗 Payment link'}
                        </button>
                      )}
                      <button className="ghost small" onClick={() => { setPaying(i.id); setPay({ amountPaid: String(Math.max(Number(i.totalAmount) - Number(i.paidAmount), 0)), method: acceptedMethods[0], transactionRef: '', proofFileKey: '' }); }}>Record payment</button>
                    </span>
                  )
                )}
              </td>
            </tr>
          ))}
          {invoices.length === 0 && <tr><td colSpan={6} className="muted">No invoices yet. Generate a batch above.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Fee setup (OWNER_ADMIN). Invoicing needs a fee structure per class, and a structure needs a
 * fee head — neither had any UI, which made invoice generation unreachable without calling
 * the API directly.
 */
function FeeSetupPanel({ heads, structures, classes, years, classLabel, onMsg, reload }: {
  heads: FeeHead[]; structures: FeeStructure[]; classes: Klass[]; years: AcademicYear[];
  classLabel: (c: Klass) => string;
  onMsg: (ok: boolean, text: string) => void;
  reload: () => Promise<void>;
}) {
  const [headName, setHeadName] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try { await fn(); await reload(); onMsg(true, ok); }
    catch (e) { onMsg(false, e instanceof ApiError ? e.message : 'Failed'); }
    finally { setBusy(false); }
  }

  async function addHead() {
    const name = headName.trim();
    await run(() => api.feeSetup.createHead(name), `Added fee head "${name}"`);
    setHeadName('');
  }

  return (
    <div className="stack">
      <div className="card stack">
        <h2 style={{ margin: 0, fontSize: 17 }}>Fee heads</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>The chargeable items (Tuition, Transport, Lab …). A fee structure prices one head for one class.</p>
        <div className="row" style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
          {heads.length === 0 && <span className="muted" style={{ fontSize: 13 }}>None yet — add the first one below.</span>}
          {heads.map((h) => (
            <FeeHeadChip key={h.id} head={h} busy={busy}
              onRename={(name) => run(() => api.feeSetup.renameHead(h.id, name), 'Fee renamed')}
              onDelete={() => run(() => api.feeSetup.deleteHead(h.id), `Removed “${h.name}”`)} />
          ))}
        </div>
        <div className="inline-form">
          <div><label>New fee head</label><input value={headName} onChange={(e) => setHeadName(e.target.value)} placeholder="Tuition" /></div>
          <button disabled={!headName.trim() || busy} onClick={addHead}>Add head</button>
        </div>
      </div>

      {/* One card per class, with a monthly total. Replaces a flat table of every price in
          the school, which could not answer "what does 9th cost?" without adding rows up. */}
      <FeePlanPanel heads={heads} structures={structures} classes={classes} years={years}
        classLabel={classLabel} onMsg={onMsg} reload={reload} />

      <LateFeeCard onMsg={onMsg} />
    </div>
  );
}

/** School-wide late-fee policy (one per school) — loaded on mount, upserted on save. */
function LateFeeCard({ onMsg }: { onMsg: (ok: boolean, text: string) => void }) {
  const [f, setF] = useState({ graceDays: '', mode: 'FLAT', amount: '', maxAmount: '' });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.feeSetup.lateFeePolicy()
      .then((p) => {
        if (p) setF({ graceDays: String(p.graceDays), mode: p.mode, amount: String(p.amount), maxAmount: p.maxAmount ? String(p.maxAmount) : '' });
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  async function save() {
    setBusy(true);
    try {
      await api.feeSetup.upsertLateFeePolicy({
        graceDays: Number(f.graceDays), mode: f.mode, amount: Number(f.amount),
        maxAmount: f.maxAmount ? Number(f.maxAmount) : undefined,
      });
      onMsg(true, 'Late-fee policy saved');
    } catch (e) { onMsg(false, e instanceof ApiError ? e.message : 'Failed to save policy'); }
    finally { setBusy(false); }
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>Late-fee policy</h2>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>Applied by the nightly overdue job after the grace period. One policy per school.</p>
      {!loaded ? <p className="muted" style={{ margin: 0 }}>Loading…</p> : (
        <div className="inline-form">
          <div style={{ maxWidth: 120 }}><label>Grace days</label>
            <input type="number" min={0} max={60} value={f.graceDays} onChange={(e) => setF({ ...f, graceDays: e.target.value })} />
          </div>
          <div><label>Mode</label>
            <select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
              <option value="FLAT">Flat</option>
              <option value="PER_DAY">Per day</option>
            </select>
          </div>
          <div style={{ maxWidth: 130 }}><label>Amount (Rs)</label>
            <input type="number" min={1} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </div>
          <div style={{ maxWidth: 140 }}><label>Max (optional)</label>
            <input type="number" min={1} value={f.maxAmount} onChange={(e) => setF({ ...f, maxAmount: e.target.value })} />
          </div>
          <button disabled={f.graceDays === '' || Number(f.amount) <= 0 || busy} onClick={save}>Save policy</button>
        </div>
      )}
    </div>
  );
}

/**
 * One chargeable item, renameable and removable.
 *
 * Fee heads were create-and-read only, so the list only ever grew — every typo and every name a
 * test run left behind stayed in the dropdown for ever, with no way for a school to tidy it.
 * Deleting is refused server-side while any class price, invoice line or discount references
 * the head, and the message names which — so the button stays available and the explanation
 * arrives when it is actually true.
 */
function FeeHeadChip({ head, busy, onRename, onDelete }: {
  head: FeeHead; busy: boolean;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (editing !== null) {
    return (
      <span className="inline-form" style={{ gap: 4 }}>
        <input autoFocus value={editing} style={{ width: 150 }}
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && editing.trim()) { onRename(editing.trim()); setEditing(null); }
            if (e.key === 'Escape') setEditing(null);
          }} />
        <button className="small" disabled={!editing.trim() || busy}
          onClick={() => { onRename(editing.trim()); setEditing(null); }}>Save</button>
        <button className="ghost small" onClick={() => setEditing(null)}>Cancel</button>
      </span>
    );
  }

  return (
    <>
      <span className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {head.name}
        <button type="button" className="ghost small" style={{ padding: '2px 6px', minHeight: 24 }}
          aria-label={`Rename ${head.name}`} onClick={() => setEditing(head.name)}>Rename</button>
        {/* Worded, spaced, and CONFIRMED. The first version was a bare ✕ flush against Rename
            with no confirmation, and it cost a real fee head within minutes of shipping — the
            same rule the Classes screen already learned: a destructive control must never sit
            one stray pixel from a harmless one, and must state its blast radius first. */}
        <button type="button" className="ghost small" style={{ padding: '2px 8px', minHeight: 24, marginLeft: 2, color: '#b91c1c' }}
          aria-label={`Delete ${head.name}`} disabled={busy} onClick={() => setConfirming(true)}>Delete</button>
      </span>
      {confirming && (
        <ConfirmDialog
          title={`Delete “${head.name}”?`}
          body={'It disappears from every class’s fee list. Removal is refused while any class price, invoice line or discount still uses it.'}
          confirmLabel="Delete fee"
          onConfirm={() => { onDelete(); }}
          onClose={() => setConfirming(false)} />
      )}
    </>
  );
}
