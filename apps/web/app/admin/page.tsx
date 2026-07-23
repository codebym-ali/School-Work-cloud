'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { platformApi, type Tenant } from '@/lib/platform-api';

const PAGE_SIZE = 25;

export default function TenantsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

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

  return (
    <div className="stack">
      <div className="row">
        <h1>Tenants <span className="muted" style={{ fontWeight: 400, fontSize: 15 }}>({total})</span></h1>
        <button onClick={() => setAdding((v) => !v)}>{adding ? 'Close' : '+ New tenant'}</button>
      </div>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {adding && (
        <NewTenant onDone={async (ok, text) => { setMsg({ ok, text }); if (ok) { setAdding(false); setPage(1); setQuery(''); setSearch(''); await load(); } }} />
      )}

      <div className="inline-form">
        <div style={{ minWidth: 260 }}><label>Search (name / subdomain)</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && applySearch()} placeholder="e.g. greenwood" />
        </div>
        <button className="ghost" onClick={applySearch}>Search</button>
        {query && <button className="ghost" onClick={() => { setSearch(''); setQuery(''); setPage(1); }}>Clear</button>}
      </div>

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
          {tenants.length === 0 && <tr><td colSpan={7} className="muted">{loading ? 'Loading…' : query ? 'No tenants match.' : 'No tenants yet.'}</td></tr>}
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
