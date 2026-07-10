'use client';

import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { platformApi, type Tenant } from '@/lib/platform-api';

export default function TenantsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    setTenants(await platformApi.tenants());
  }
  useEffect(() => { load().catch(() => {}); }, []);

  async function run(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); await load(); setMsg({ ok: true, text: ok }); return true; }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed' }); return false; }
  }

  return (
    <div className="stack">
      <div className="row">
        <h1>Tenants</h1>
        <button onClick={() => setAdding((v) => !v)}>{adding ? 'Close' : '+ New tenant'}</button>
      </div>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {adding && (
        <NewTenant onDone={async (ok, text) => { setMsg({ ok, text }); if (ok) { setAdding(false); await load(); } }} />
      )}

      <table>
        <thead><tr><th>Name</th><th>Subdomain</th><th>Plan</th><th>Status</th><th>Users</th><th>Students</th><th></th></tr></thead>
        <tbody>
          {tenants.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td>{t.subdomain}</td>
              <td>{t.planTier}</td>
              <td>{t.isActive ? <span className="badge ok">active</span> : <span className="badge bad">suspended</span>}</td>
              <td>{t.userCount}</td>
              <td>{t.studentCount}</td>
              <td>
                {t.isActive
                  ? <button className="ghost small" onClick={() => run(() => platformApi.suspend(t.id), `Suspended ${t.subdomain}`)}>Suspend</button>
                  : <button className="ghost small" onClick={() => run(() => platformApi.reactivate(t.id), `Reactivated ${t.subdomain}`)}>Reactivate</button>}
              </td>
            </tr>
          ))}
          {tenants.length === 0 && <tr><td colSpan={7} className="muted">No tenants yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function NewTenant({ onDone }: { onDone: (ok: boolean, text: string) => void }) {
  const [f, setF] = useState<Record<string, string>>({});
  const set = (k: string, v: string) => setF({ ...f, [k]: v });

  async function submit() {
    try {
      const res = await platformApi.provision({
        name: f.name, subdomain: f.subdomain, ownerEmail: f.ownerEmail, ownerPassword: f.ownerPassword,
      });
      onDone(true, `Provisioned ${res.subdomain}`);
    } catch (e) {
      onDone(false, e instanceof ApiError ? e.message : 'Failed to provision tenant');
    }
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>New tenant</h2>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px,1fr))' }}>
        <div><label>School name</label><input value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} /></div>
        <div><label>Subdomain</label><input value={f.subdomain ?? ''} onChange={(e) => set('subdomain', e.target.value)} placeholder="greenwood" /></div>
        <div><label>Owner email</label><input type="email" value={f.ownerEmail ?? ''} onChange={(e) => set('ownerEmail', e.target.value)} /></div>
        <div><label>Owner password</label><input type="password" value={f.ownerPassword ?? ''} onChange={(e) => set('ownerPassword', e.target.value)} /></div>
      </div>
      <div>
        <button onClick={submit} disabled={!f.name || !f.subdomain || !f.ownerEmail || (f.ownerPassword ?? '').length < 8}>Provision tenant</button>
      </div>
    </div>
  );
}
