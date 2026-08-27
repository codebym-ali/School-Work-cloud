'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { platformApi, type Tenant, type Invoice, type BillingOverview, type BillingSettings } from '@/lib/platform-api';
import { usePlatformMe } from '../me-context';

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PAY_METHODS = ['BANK_TRANSFER', 'CASH', 'CHEQUE', 'OTHER'];

const money = (v: string, currency = 'PKR') =>
  `${currency} ${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const period = (y: number, m: number) => `${MONTHS[m] ?? m} ${y}`;

/**
 * Vendor billing (SA6, decision D3 — in-house, per-student). The vendor charges each school a monthly
 * rate per ACTIVE student, set here per school. SUPER_ADMIN + BILLING only (the API 403s everyone else,
 * and the nav link is hidden). Payments are recorded OFFLINE (bank transfer / cash / cheque) — no card
 * rails in v1. Money never moves through this console; it only records what was invoiced and collected.
 */
export default function BillingPage() {
  const me = usePlatformMe();
  const canBill = me.role === 'SUPER_ADMIN' || me.role === 'BILLING';

  const [overview, setOverview] = useState<BillingOverview | null>(null);
  const [settings, setSettings] = useState<BillingSettings | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [payTarget, setPayTarget] = useState<Invoice | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ov, st, tp, inv] = await Promise.all([
        platformApi.billingOverview(),
        platformApi.billingSettings(),
        platformApi.tenants({ pageSize: 100 }),
        platformApi.invoices({ status: statusFilter || undefined, pageSize: 100 }),
      ]);
      setOverview(ov);
      setSettings(st);
      setTenants(tp.data);
      setInvoices(inv.data);
    } finally { setLoading(false); }
  }, [statusFilter]);
  useEffect(() => { if (canBill) load().catch(() => {}); else setLoading(false); }, [canBill, load]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); await load(); setMsg({ ok: true, text: ok }); return true; }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed' }); return false; }
  }

  if (!canBill) {
    return (
      <div className="stack">
        <h1 style={{ margin: 0 }}>Billing</h1>
        <div className="toast err">Only Super Admin or Billing operators can view billing.</div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row">
        <h1 style={{ margin: 0 }}>Billing</h1>
        <span className="muted" style={{ fontSize: 12 }}>Per-student, invoiced monthly · payments recorded offline</span>
      </div>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {overview && <OverviewCards o={overview} />}

      {settings && (
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 16, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ maxWidth: 640 }}>
            <strong style={{ fontSize: 15 }}>Auto-reactivate on payment</strong>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
              When a school suspended <em>for non-payment</em> clears its overdue balance, bring it back online
              automatically. Off by default — a school you suspended by hand is never auto-reactivated.
            </p>
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap', fontSize: 14 }}>
            <input type="checkbox" checked={settings.autoReactivateOnPayment}
              onChange={(e) => run(() => platformApi.setAutoReactivate(e.target.checked), `Auto-reactivate turned ${e.target.checked ? 'on' : 'off'}`)} />
            {settings.autoReactivateOnPayment ? 'On' : 'Off'}
          </label>
        </div>
      )}

      <PricingTable tenants={tenants} loading={loading} run={run} />

      {payTarget && (
        <PayForm
          invoice={payTarget}
          onCancel={() => setPayTarget(null)}
          onConfirm={async (method, reference, paidAt) => {
            const ok = await run(() => platformApi.payInvoice(payTarget.id, method, reference, paidAt), `Payment recorded for ${payTarget.tenantSubdomain}`);
            if (ok) setPayTarget(null);
          }}
        />
      )}

      <InvoicesSection
        tenants={tenants}
        invoices={invoices}
        loading={loading}
        statusFilter={statusFilter}
        onStatusFilter={setStatusFilter}
        onGenerate={(tenantId, year, month) => run(() => platformApi.generateInvoice(tenantId, year, month), 'Invoice generated')}
        onPay={(inv) => { setPayTarget(inv); setMsg(null); }}
        onVoid={async (inv) => {
          const reason = window.prompt(`Void the ${period(inv.periodYear, inv.periodMonth)} invoice for ${inv.tenantSubdomain}? Give a reason (recorded):`);
          if (reason && reason.trim()) await run(() => platformApi.voidInvoice(inv.id, reason.trim()), 'Invoice voided');
        }}
      />
    </div>
  );
}

/** The revenue dashboard (SA6) — MRR, what's outstanding/overdue, and what's been collected. */
function OverviewCards({ o }: { o: BillingOverview }) {
  return (
    <div className="stack">
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
        <div className="metric">
          <div className="value">{money(o.mrr, o.currency)}</div>
          <div className="label">MRR · price × active students</div>
          <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span className="badge ok">{o.pricedSchools} priced</span>
            {o.unpricedActiveSchools > 0 && <span className="badge warn">{o.unpricedActiveSchools} unpriced</span>}
          </div>
        </div>
        <div className="metric">
          <div className="value">{money(o.outstanding, o.currency)}</div>
          <div className="label">Outstanding · issued & unpaid</div>
          <div style={{ marginTop: 8 }}><span className="muted" style={{ fontSize: 12 }}>{o.issuedCount} invoice{o.issuedCount === 1 ? '' : 's'}</span></div>
        </div>
        <div className="metric">
          <div className="value">{money(o.overdue, o.currency)}</div>
          <div className="label">Overdue · past due date</div>
          {o.overdueCount > 0 && <div style={{ marginTop: 8 }}><span className="badge bad">{o.overdueCount} overdue</span></div>}
        </div>
        <div className="metric">
          <div className="value">{money(o.collectedThisMonth, o.currency)}</div>
          <div className="label">Collected · this month</div>
          <div style={{ marginTop: 8 }}><span className="muted" style={{ fontSize: 12 }}>{money(o.collectedAllTime, o.currency)} all-time</span></div>
        </div>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        MRR is the live monthly value of the priced fleet (each school&apos;s price × its active students).
        Invoices freeze the amount at issue, so re-pricing later never rewrites a past invoice.
      </p>
    </div>
  );
}

/** Per-school pricing (SA6). Set the monthly per-student rate; a school with no price can&apos;t be invoiced. */
function PricingTable({ tenants, loading, run }: { tenants: Tenant[]; loading: boolean; run: (fn: () => Promise<unknown>, ok: string) => Promise<boolean> }) {
  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 16 }}>Per-student pricing</h2>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        The monthly rate the vendor charges each school per active student. Set it once, or negotiate per school.
        Leave it unset and the school can&apos;t be invoiced until you price it.
      </p>
      <table>
        <thead><tr><th>School</th><th>Subdomain</th><th>Active students</th><th>Price / student</th><th>Est. monthly</th><th></th></tr></thead>
        <tbody>
          {tenants.map((t) => (
            <PriceRow key={t.id} t={t} run={run} />
          ))}
          {tenants.length === 0 && <tr><td colSpan={6} className="muted">{loading ? 'Loading…' : 'No tenants.'}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function PriceRow({ t, run }: { t: Tenant; run: (fn: () => Promise<unknown>, ok: string) => Promise<boolean> }) {
  const [value, setValue] = useState(t.pricePerStudent ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setValue(t.pricePerStudent ?? ''); }, [t.pricePerStudent]);
  const parsed = Number(value);
  const valid = value !== '' && Number.isFinite(parsed) && parsed >= 0;
  const dirty = (t.pricePerStudent ?? '') !== value;
  const est = t.pricePerStudent != null ? Number(t.pricePerStudent) * t.activeStudents : null;

  async function save() {
    if (!valid) return;
    setBusy(true);
    try { await run(() => platformApi.setPrice(t.id, parsed), `${t.subdomain}: price set to ${parsed.toFixed(2)}`); }
    finally { setBusy(false); }
  }

  return (
    <tr>
      <td>{t.name}{!t.isActive && <span className="badge bad" style={{ marginLeft: 6 }}>suspended</span>}</td>
      <td>{t.subdomain}</td>
      <td>{t.activeStudents}</td>
      <td>
        <input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" aria-label={`Price per student for ${t.subdomain}`}
          onKeyDown={(e) => { if (e.key === 'Enter' && valid && dirty) void save(); }}
          placeholder="unpriced" style={{ width: 110 }} />
      </td>
      <td>{est != null ? money(est.toFixed(2)) : <span className="muted">—</span>}</td>
      <td><button className="ghost small" disabled={busy || !valid || !dirty} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button></td>
    </tr>
  );
}

/** Generate invoices and work the invoice ledger (SA6). */
function InvoicesSection({
  tenants, invoices, loading, statusFilter, onStatusFilter, onGenerate, onPay, onVoid,
}: {
  tenants: Tenant[]; invoices: Invoice[]; loading: boolean; statusFilter: string;
  onStatusFilter: (s: string) => void;
  onGenerate: (tenantId: string, year: number, month: number) => Promise<boolean>;
  onPay: (inv: Invoice) => void;
  onVoid: (inv: Invoice) => void;
}) {
  const now = new Date();
  const priced = tenants.filter((t) => t.pricePerStudent != null);
  const [tenantId, setTenantId] = useState('');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [busy, setBusy] = useState(false);

  async function generate() {
    if (!tenantId) return;
    setBusy(true);
    try { await onGenerate(tenantId, year, month); } finally { setBusy(false); }
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 16 }}>Invoices</h2>

      <div className="inline-form" style={{ alignItems: 'flex-end' }}>
        <div><label>School</label>
          <select value={tenantId} onChange={(e) => setTenantId(e.target.value)} aria-label="School to invoice">
            <option value="">Select a priced school…</option>
            {priced.map((t) => <option key={t.id} value={t.id}>{t.subdomain} — {money(t.pricePerStudent as string)}/student</option>)}
          </select>
        </div>
        <div><label>Year</label><input type="number" value={year} min={2000} max={2100} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 90 }} /></div>
        <div><label>Month</label>
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))} aria-label="Billing month">
            {MONTHS.slice(1).map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <button disabled={busy || !tenantId} onClick={() => void generate()}>{busy ? 'Generating…' : 'Generate invoice'}</button>
      </div>
      {priced.length === 0 && <p className="muted" style={{ margin: 0, fontSize: 12 }}>Price at least one school above before generating invoices.</p>}

      <div className="inline-form" style={{ marginTop: 4 }}>
        <div><label>Filter status</label>
          <select value={statusFilter} onChange={(e) => onStatusFilter(e.target.value)} aria-label="Filter invoices by status">
            <option value="">All</option>
            <option value="ISSUED">Issued</option>
            <option value="PAID">Paid</option>
            <option value="VOID">Void</option>
          </select>
        </div>
      </div>

      <table>
        <thead><tr><th>Period</th><th>School</th><th>Students</th><th>Amount</th><th>Status</th><th>Due</th><th></th></tr></thead>
        <tbody>
          {invoices.map((inv) => (
            <tr key={inv.id}>
              <td>{period(inv.periodYear, inv.periodMonth)}</td>
              <td>{inv.tenantSubdomain}</td>
              <td>{inv.studentCount} × {money(inv.pricePerStudent)}</td>
              <td>{money(inv.amount, inv.currency)}</td>
              <td>
                {inv.status === 'PAID' && <span className="badge ok">paid</span>}
                {inv.status === 'VOID' && <span className="badge bad">void</span>}
                {inv.status === 'ISSUED' && (inv.isOverdue ? <span className="badge bad">overdue</span> : <span className="badge warn">issued</span>)}
              </td>
              <td className="muted" style={{ fontSize: 13 }}>
                {inv.status === 'PAID'
                  ? <>paid {inv.paidAt ? new Date(inv.paidAt).toLocaleDateString() : ''}{inv.paymentMethod ? ` · ${inv.paymentMethod.toLowerCase().replace('_', ' ')}` : ''}</>
                  : inv.status === 'VOID'
                    ? (inv.note ?? '—')
                    : new Date(inv.dueAt).toLocaleDateString()}
              </td>
              <td>
                {inv.status === 'ISSUED' && (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="ghost small" onClick={() => onPay(inv)}>Record payment</button>
                    <button className="ghost small" onClick={() => onVoid(inv)}>Void</button>
                  </div>
                )}
              </td>
            </tr>
          ))}
          {invoices.length === 0 && <tr><td colSpan={7} className="muted">{loading ? 'Loading…' : 'No invoices yet.'}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/** Record an offline payment against one invoice (SA6). Method + optional reference/date. */
function PayForm({ invoice, onConfirm, onCancel }: { invoice: Invoice; onConfirm: (method: string, reference?: string, paidAt?: string) => void; onCancel: () => void }) {
  const [method, setMethod] = useState('BANK_TRANSFER');
  const [reference, setReference] = useState('');
  const [paidAt, setPaidAt] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try { await onConfirm(method, reference.trim() || undefined, paidAt || undefined); } finally { setBusy(false); }
  }

  return (
    <div className="card stack" style={{ borderColor: 'var(--brand)' }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>Record payment — {invoice.tenantSubdomain} · {period(invoice.periodYear, invoice.periodMonth)}</h2>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        {money(invoice.amount, invoice.currency)}. This records a payment you received offline (bank transfer, cash, cheque). No money moves here.
      </p>
      <div className="inline-form" style={{ alignItems: 'flex-end' }}>
        <div><label>Method</label>
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            {PAY_METHODS.map((m) => <option key={m} value={m}>{m.toLowerCase().replace('_', ' ')}</option>)}
          </select>
        </div>
        <div><label>Reference (optional)</label><input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. transfer ID / cheque no." /></div>
        <div><label>Paid on (optional)</label><input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} /></div>
      </div>
      <div className="row" style={{ justifyContent: 'flex-start', gap: 8 }}>
        <button disabled={busy} onClick={submit}>{busy ? 'Recording…' : 'Record payment'}</button>
        <button className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
