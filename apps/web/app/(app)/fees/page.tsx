'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  api, apiGet, apiPost, ApiError, idemKey,
  type AcademicYear, type Campus, type FeeHead, type FeeStructure, type Invoice, type Klass, type Paged, type Student,
} from '@/lib/api';
import { hasModule, useMe } from '@/lib/me-context';
import { classLabeller } from '@/lib/labels';
import { FeePlanPanel } from './fee-plan-panel';

const now = new Date();

export default function FeesPage() {
  const me = useMe();
  const isOwner = (me?.roles ?? []).includes('OWNER_ADMIN');
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
  const [pay, setPay] = useState({ amountPaid: '', method: 'CASH' });
  const [setupOpen, setSetupOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const classLabel = classLabeller(classes, campuses);

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
  }, [loadSetup]);

  const selectedHasStructure = !batch.classId || structures.some((s) => s.classId === batch.classId);

  async function generate() {
    try {
      const res = await apiPost<{ generated: number; alreadyExists: boolean }>('/fees/invoice-batches', { classId: batch.classId, month: Number(batch.month), year: Number(batch.year) });
      setMsg({ ok: true, text: res.alreadyExists ? 'Batch already existed' : `Generated ${res.generated} invoice(s)` });
      await loadInvoices();
    } catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed' }); }
  }

  async function collect(id: string) {
    try {
      await apiPost(`/fees/invoices/${id}/payments`, { amountPaid: Number(pay.amountPaid), method: pay.method }, idemKey());
      setMsg({ ok: true, text: 'Payment recorded' });
      setPaying(null); setPay({ amountPaid: '', method: 'CASH' });
      await loadInvoices();
    } catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Payment failed' }); }
  }

  const badge = (s: string) => s === 'PAID' ? 'ok' : s === 'OVERDUE' ? 'bad' : s === 'WAIVED' ? '' : 'warn';

  return (
    <div className="stack">
      <div className="row">
        <h1>Fees</h1>
        {isOwner && (
          <button className="ghost" onClick={() => setSetupOpen((v) => !v)}>
            {setupOpen ? 'Close fee setup' : '⚙ Fee setup'}
          </button>
        )}
      </div>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {isOwner && setupOpen && (
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
            <select value={batch.classId} onChange={(e) => setBatch({ ...batch, classId: e.target.value })}>
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
            {isOwner
              ? <> Open <b>⚙ Fee setup</b> above to add one.</>
              : <> Ask the school owner to add one under Fee setup.</>}
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>Invoices come from the class&apos;s fee structure. Idempotent per class + month + year.</p>
        )}
      </div>
      )}

      <table>
        <thead><tr><th>Student</th><th>Period</th><th>Total</th><th>Paid</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {invoices.map((i) => (
            <tr key={i.id}>
              <td>{names[i.studentId] ?? i.studentId.slice(0, 8)}</td>
              <td>{i.month ? `${i.month}/${i.year}` : i.year}</td>
              <td>Rs {Number(i.totalAmount).toLocaleString()}</td>
              <td>Rs {Number(i.paidAmount).toLocaleString()}</td>
              <td><span className={`badge ${badge(i.status)}`}>{i.status}</span></td>
              <td>
                {canPayments && i.status !== 'PAID' && i.status !== 'WAIVED' && (
                  paying === i.id ? (
                    <span className="inline-form">
                      <input style={{ width: 90 }} placeholder="Amount" value={pay.amountPaid} onChange={(e) => setPay({ ...pay, amountPaid: e.target.value })} />
                      <select style={{ width: 130 }} value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                        <option>CASH</option><option>BANK_TRANSFER</option><option>EASYPAISA</option><option>JAZZCASH</option><option>CARD</option><option>CHEQUE</option>
                      </select>
                      <button className="small" onClick={() => collect(i.id)}>Save</button>
                      <button className="ghost small" onClick={() => setPaying(null)}>×</button>
                    </span>
                  ) : <button className="ghost small" onClick={() => { setPaying(i.id); setPay({ amountPaid: String(Math.max(Number(i.totalAmount) - Number(i.paidAmount), 0)), method: 'CASH' }); }}>Collect</button>
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
  const currentYear = years.find((y) => y.isCurrent) ?? years[0] ?? null;

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
          {heads.map((h) => <span key={h.id} className="badge">{h.name}</span>)}
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
