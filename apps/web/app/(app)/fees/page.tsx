'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiPost, ApiError, idemKey, type Invoice, type Klass, type Paged, type Student } from '@/lib/api';
import { hasModule, useMe } from '@/lib/me-context';

const now = new Date();

export default function FeesPage() {
  const me = useMe();
  const canInvoicing = hasModule(me, 'fees.invoicing');
  const canPayments = hasModule(me, 'fees.payments');
  const [classes, setClasses] = useState<Klass[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [batch, setBatch] = useState({ classId: '', month: String(now.getMonth() + 1), year: String(now.getFullYear()) });
  const [paying, setPaying] = useState<string | null>(null);
  const [pay, setPay] = useState({ amountPaid: '', method: 'CASH' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function loadInvoices() {
    const res = await apiGet<Paged<Invoice>>('/fees/invoices?pageSize=100');
    setInvoices(res.data);
  }
  useEffect(() => {
    apiGet<Klass[]>('/classes').then(setClasses).catch(() => {});
    apiGet<Paged<Student>>('/students?pageSize=100').then((r) => setNames(Object.fromEntries(r.data.map((s) => [s.id, `${s.fullName} (${s.grNumber})`])))).catch(() => {});
    loadInvoices().catch(() => {});
  }, []);

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
      <h1>Fees</h1>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {canInvoicing && (
      <div className="card stack">
        <h2 style={{ margin: 0, fontSize: 17 }}>Generate invoices (monthly)</h2>
        <div className="inline-form">
          <div><label>Class</label>
            <select value={batch.classId} onChange={(e) => setBatch({ ...batch, classId: e.target.value })}>
              <option value="">Select…</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div style={{ maxWidth: 90 }}><label>Month</label><input value={batch.month} onChange={(e) => setBatch({ ...batch, month: e.target.value })} /></div>
          <div style={{ maxWidth: 110 }}><label>Year</label><input value={batch.year} onChange={(e) => setBatch({ ...batch, year: e.target.value })} /></div>
          <button onClick={generate} disabled={!batch.classId}>Generate</button>
        </div>
        <p className="muted" style={{ margin: 0 }}>Needs a fee structure for the class (create one via the API / Swagger for now). Idempotent per class+month+year.</p>
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
