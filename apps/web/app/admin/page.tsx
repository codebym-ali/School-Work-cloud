'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { platformApi, type Tenant, type PlatformOverview } from '@/lib/platform-api';
import { usePlatformMe } from './me-context';

const PAGE_SIZE = 25;

export default function TenantsPage() {
  const me = usePlatformMe();
  // Only a SUPER_ADMIN may provision / suspend / reactivate. Every other operator role is
  // read-only, so the write controls are HIDDEN rather than offered and then 403'd — the console's
  // "don't offer a choice they can't make" rule. Reads (the list) stay visible to all roles.
  const canWrite = me.role === 'SUPER_ADMIN';

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // The tenant awaiting a suspension reason. Suspending now requires a reason (SA0), so the bare
  // button opens this inline form instead of firing the request directly.
  const [suspendTarget, setSuspendTarget] = useState<Tenant | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await platformApi.tenants({ search: query || undefined, page, pageSize: PAGE_SIZE });
      setTenants(res.data);
      setTotal(res.total);
    } finally { setLoading(false); }
  }, [query, page]);
  useEffect(() => { load().catch(() => {}); }, [load]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); await load(); setMsg({ ok: true, text: ok }); return true; }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed' }); return false; }
  }

  const applySearch = () => { setPage(1); setQuery(search.trim()); };
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);
  const colCount = canWrite ? 7 : 6;

  return (
    <div className="stack">
      <FleetOverview />

      <div className="row" style={{ marginTop: 8 }}>
        <h2 style={{ margin: 0 }}>Tenants <span className="muted" style={{ fontWeight: 400, fontSize: 15 }}>({total})</span></h2>
        {canWrite && <button onClick={() => setAdding((v) => !v)}>{adding ? 'Close' : '+ New tenant'}</button>}
      </div>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {canWrite && adding && (
        <NewTenant
          onDone={async (ok, text) => { setMsg({ ok, text }); if (ok) { setPage(1); setQuery(''); setSearch(''); await load(); } }}
          onClose={() => setAdding(false)}
        />
      )}

      {canWrite && suspendTarget && (
        <SuspendForm
          tenant={suspendTarget}
          onCancel={() => setSuspendTarget(null)}
          onConfirm={async (reason) => {
            const ok = await run(() => platformApi.suspend(suspendTarget.id, reason), `Suspended ${suspendTarget.subdomain}`);
            if (ok) setSuspendTarget(null);
          }}
        />
      )}

      <div className="inline-form">
        <div style={{ minWidth: 260 }}><label>Search (name / subdomain)</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && applySearch()} placeholder="e.g. greenwood" />
        </div>
        <button className="ghost" onClick={applySearch}>Search</button>
        {query && <button className="ghost" onClick={() => { setSearch(''); setQuery(''); setPage(1); }}>Clear</button>}
      </div>

      <table>
        <thead><tr><th>Name</th><th>Subdomain</th><th>Plan</th><th>Status</th><th>Users</th><th>Students</th>{canWrite && <th></th>}</tr></thead>
        <tbody>
          {tenants.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td>{t.subdomain}</td>
              <td>{t.planTier}</td>
              <td>{t.isActive ? <span className="badge ok">active</span> : <span className="badge bad">suspended</span>}</td>
              <td>{t.userCount}</td>
              <td>{t.studentCount}</td>
              {canWrite && (
                <td>
                  {t.isActive
                    ? <button className="ghost small" onClick={() => { setSuspendTarget(t); setMsg(null); }}>Suspend</button>
                    : <button className="ghost small" onClick={() => run(() => platformApi.reactivate(t.id), `Reactivated ${t.subdomain}`)}>Reactivate</button>}
                </td>
              )}
            </tr>
          ))}
          {tenants.length === 0 && <tr><td colSpan={colCount} className="muted">{loading ? 'Loading…' : query ? 'No tenants match.' : 'No tenants yet.'}</td></tr>}
        </tbody>
      </table>

      <div className="row">
        <span className="muted" style={{ fontSize: 13 }}>{total === 0 ? 'No results' : `Showing ${from}–${to} of ${total}`}</span>
        <div className="row" style={{ gap: 8 }}>
          <button className="ghost small" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>← Prev</button>
          <span className="muted" style={{ fontSize: 13 }}>Page {page} of {pageCount}</span>
          <button className="ghost small" disabled={page >= pageCount || loading} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}>Next →</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Fleet overview (SA1) — the "record of everything" the vendor asked for: how many schools, how
 * many students, how many staff, across the whole platform. It reads a nightly snapshot
 * (`GET /platform/overview`), so it is O(read one row), never a live fleet-wide COUNT. Totals only —
 * the containers, never a school's own records (SA-P1). A read, so every operator role sees it.
 */
function FleetOverview() {
  const [o, setO] = useState<PlatformOverview | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    platformApi.overview().then(setO).catch(() => setFailed(true));
  }, []);

  // A dashboard fetch failure must not blank the console — the tenants table below still works.
  if (failed) return null;
  if (!o) return <div className="muted" style={{ fontSize: 13 }}>Loading overview…</div>;

  const asOf = o.capturedAt
    ? `snapshot as of ${new Date(o.capturedAt).toLocaleString()}`
    : 'no snapshot yet — the nightly job will populate this';

  return (
    <div className="stack">
      <div className="row">
        <h1 style={{ margin: 0 }}>Fleet overview</h1>
        <span className="muted" style={{ fontSize: 12 }}>{asOf}</span>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        The whole platform at a glance. Totals only — no individual school&apos;s records are shown here.
      </p>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
        <div className="metric">
          <div className="value">{o.schoolsTotal.toLocaleString()}</div>
          <div className="label">Schools</div>
          <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span className="badge ok">{o.schoolsActive} active</span>
            {o.schoolsSuspended > 0 && <span className="badge bad">{o.schoolsSuspended} suspended</span>}
          </div>
        </div>
        <div className="metric">
          <div className="value">{o.studentsActive.toLocaleString()}</div>
          <div className="label">Students · active enrollments</div>
        </div>
        <div className="metric">
          <div className="value">{o.staffEmployed.toLocaleString()}</div>
          <div className="label">Staff · employed</div>
        </div>
        <div className="metric">
          <div className="value">{o.newSchools30d.toLocaleString()}</div>
          <div className="label">New schools · last 30 days</div>
        </div>
      </div>
    </div>
  );
}

/** Suspending a tenant requires a reason (SA0) — it is recorded against the tenant, so the button
 *  cannot fire until one is given. */
function SuspendForm({ tenant, onConfirm, onCancel }: { tenant: Tenant; onConfirm: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const trimmed = reason.trim();

  async function submit() {
    setBusy(true);
    try { await onConfirm(trimmed); } finally { setBusy(false); }
  }

  return (
    <div className="card stack" style={{ borderColor: 'var(--danger)' }}>
      <h2 style={{ margin: 0, fontSize: 17 }}>Suspend {tenant.name}</h2>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        <code>{tenant.subdomain}</code> will be locked out until reactivated. Give a reason — it is recorded against the tenant.
      </p>
      <div>
        <label htmlFor="suspend-reason">Reason</label>
        <input id="suspend-reason" autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && trimmed) submit(); }} placeholder="e.g. non-payment" />
      </div>
      <div className="row" style={{ justifyContent: 'flex-start', gap: 8 }}>
        <button disabled={!trimmed || busy} onClick={submit}>{busy ? 'Suspending…' : 'Suspend tenant'}</button>
        <button className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * Provision a school (SA2, SA-P3). No password is ever typed here — on success the API returns a
 * one-time onboarding token, which this turns into a set-password link on the new school's own host
 * for the operator to hand over. The form stays mounted to show that link once (it can't be shown
 * again — only the token's hash is stored), and closes on the operator's deliberate "Done".
 */
function NewTenant({ onDone, onClose }: { onDone: (ok: boolean, text: string) => void; onClose: () => void }) {
  const [f, setF] = useState<Record<string, string>>({});
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ subdomain: string; url: string } | null>(null);

  async function submit() {
    setBusy(true);
    try {
      const res = await platformApi.provision({ name: f.name, subdomain: f.subdomain, ownerEmail: f.ownerEmail });
      if (res.onboardingToken) {
        // Build the owner's link on THEIR tenant host. The console lives at admin.<apex>, so strip
        // that label to get the apex → <subdomain>.<apex>. The browser owns the origin/port the
        // server can't know (the URL-composition gotcha), so the link is built here, not server-side.
        const apex = window.location.host.replace(/^admin\./, '');
        const url = `${window.location.protocol}//${res.subdomain}.${apex}/set-password?token=${encodeURIComponent(res.onboardingToken)}`;
        setResult({ subdomain: res.subdomain, url });
      }
      onDone(true, `Provisioned ${res.subdomain}`);
    } catch (e) {
      onDone(false, e instanceof ApiError ? e.message : 'Failed to provision tenant');
    } finally { setBusy(false); }
  }

  if (result) return <OnboardingLink subdomain={result.subdomain} url={result.url} onClose={onClose} />;

  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>New tenant</h2>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        No password is set here. After provisioning you&apos;ll get a one-time link to hand to the owner — they set their own password.
      </p>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px,1fr))' }}>
        <div><label>School name</label><input value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} /></div>
        <div><label>Subdomain</label><input value={f.subdomain ?? ''} onChange={(e) => set('subdomain', e.target.value)} placeholder="e.g. greenwood" /></div>
        <div><label>Owner email</label><input type="email" value={f.ownerEmail ?? ''} onChange={(e) => set('ownerEmail', e.target.value)} placeholder="e.g. owner@greenwood.pk" /></div>
      </div>
      <div>
        <button onClick={submit} disabled={busy || !f.name || !f.subdomain || !f.ownerEmail}>{busy ? 'Provisioning…' : 'Provision tenant'}</button>
      </div>
    </div>
  );
}

/** The onboarding link, shown ONCE after provisioning (SA-P3). It cannot be shown again — only the
 *  token's hash is stored — so copy is offered up front and dismissing takes a deliberate click.
 *  Mirrors the recovery-codes card on /admin/security. */
function OnboardingLink({ subdomain, url, onClose }: { subdomain: string; url: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setCopied(false); }
  }
  return (
    <div className="card stack" style={{ borderColor: '#86efac', background: '#f0fdf4' }}>
      <div className="row">
        <strong style={{ fontSize: 15 }}>{subdomain} provisioned — share this onboarding link</strong>
        <span className="badge warn">Shown once</span>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        Send this to the school owner — it lets them set their own password (valid 7 days, single use).
        No password was ever typed into the console. It can&apos;t be shown again, so copy it now.
      </p>
      <code style={{ display: 'block', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, wordBreak: 'break-all', background: '#fff', fontSize: 13 }}>{url}</code>
      <div className="row" style={{ justifyContent: 'flex-start', gap: 8 }}>
        <button className="ghost small" onClick={copy}>{copied ? 'Copied ✓' : 'Copy link'}</button>
        <button className="small" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
