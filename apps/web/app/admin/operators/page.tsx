'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { platformApi, type PlatformOperator, type PlatformRole } from '@/lib/platform-api';
import { usePlatformMe } from '../me-context';

const ROLES: PlatformRole[] = ['SUPER_ADMIN', 'SUPPORT', 'BILLING', 'ANALYST'];

/**
 * Operator management (SA4) — the vendor team. SUPER_ADMIN only (the API 403s everyone else, and the
 * nav link is hidden). Roles decide what an operator may do; disabling one revokes access on their
 * next request (the guard re-checks status live). An operator can't change their OWN role or status —
 * which also protects the last Super Admin — so those controls are hidden on your own row.
 */
export default function OperatorsPage() {
  const me = usePlatformMe();
  const isSuper = me.role === 'SUPER_ADMIN';
  const [ops, setOps] = useState<PlatformOperator[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setOps(await platformApi.operators()); } finally { setLoading(false); }
  }, []);
  useEffect(() => { if (isSuper) load().catch(() => {}); else setLoading(false); }, [isSuper, load]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); await load(); setMsg({ ok: true, text: ok }); }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed' }); }
  }

  if (!isSuper) {
    return (
      <div className="stack">
        <h1 style={{ margin: 0 }}>Operators</h1>
        <div className="toast err">Only a Super Admin can manage operators.</div>
      </div>
    );
  }

  return (
    <div className="stack">
      <h1 style={{ margin: 0 }}>Operators <span className="muted" style={{ fontWeight: 400, fontSize: 15 }}>({ops.length})</span></h1>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        Your vendor team. Roles decide what an operator may do; disabling one revokes their access on the
        next request. You can&apos;t change your own role or status — another Super Admin must.
      </p>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <table>
        <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>MFA</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead>
        <tbody>
          {ops.map((o) => {
            const self = o.id === me.id;
            return (
              <tr key={o.id}>
                <td>{o.email}{self && <span className="muted"> (you)</span>}</td>
                <td>{o.name || <span className="muted">—</span>}</td>
                <td>
                  {self
                    ? o.role
                    : <select value={o.role} aria-label={`Role for ${o.email}`}
                        onChange={(e) => run(() => platformApi.updateOperator(o.id, { role: e.target.value }), `${o.email}: role → ${e.target.value}`)}>
                        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>}
                </td>
                <td>{o.mfaEnabled ? <span className="badge ok">on</span> : <span className="badge warn">off</span>}</td>
                <td>{o.status === 'ACTIVE' ? <span className="badge ok">active</span> : <span className="badge bad">{o.status.toLowerCase()}</span>}</td>
                <td className="muted" style={{ fontSize: 13 }}>{o.lastLoginAt ? new Date(o.lastLoginAt).toLocaleDateString() : '—'}</td>
                <td>
                  {!self && o.status === 'ACTIVE' && (
                    <button className="ghost small" onClick={() => run(() => platformApi.updateOperator(o.id, { status: 'DISABLED' }), `${o.email} disabled`)}>Disable</button>
                  )}
                  {!self && o.status === 'DISABLED' && (
                    <button className="ghost small" onClick={() => run(() => platformApi.updateOperator(o.id, { status: 'ACTIVE' }), `${o.email} enabled`)}>Enable</button>
                  )}
                </td>
              </tr>
            );
          })}
          {ops.length === 0 && <tr><td colSpan={7} className="muted">{loading ? 'Loading…' : 'No operators.'}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
