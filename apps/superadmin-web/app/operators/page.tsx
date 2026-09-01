'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@sw/http';
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
  const [adding, setAdding] = useState(false);
  const [invite, setInvite] = useState<{ email: string; url: string } | null>(null);

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
      <div className="row">
        <h1 style={{ margin: 0 }}>Operators <span className="muted" style={{ fontWeight: 400, fontSize: 15 }}>({ops.length})</span></h1>
        <button onClick={() => { setAdding((v) => !v); setInvite(null); }}>{adding ? 'Close' : '+ New operator'}</button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        Your vendor team. Roles decide what an operator may do; disabling one revokes their access on the
        next request. You can&apos;t change your own role or status — another Super Admin must.
      </p>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {invite && <OperatorInviteLink email={invite.email} url={invite.url} onClose={() => setInvite(null)} />}

      {adding && !invite && (
        <NewOperatorForm
          onDone={(ok, text) => setMsg({ ok, text })}
          onCreated={async (email, onboardingToken) => {
            setAdding(false);
            setInvite({ email, url: `${window.location.origin}/set-password?token=${encodeURIComponent(onboardingToken)}` });
            await load();
          }}
        />
      )}

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

/** Invite a new operator (SA4b). No password is set here — the API returns a one-time onboarding
 *  token, which the parent turns into a set-password link to hand over (mirrors tenant provisioning). */
function NewOperatorForm({ onDone, onCreated }: { onDone: (ok: boolean, text: string) => void; onCreated: (email: string, onboardingToken: string) => void }) {
  const [f, setF] = useState<{ email?: string; name?: string; role?: string }>({});
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      const res = await platformApi.createOperator({ email: f.email ?? '', name: f.name, role: f.role ?? 'ANALYST' });
      onCreated(res.email, res.onboardingToken);
    } catch (e) {
      onDone(false, e instanceof ApiError ? e.message : 'Failed to create operator');
    } finally { setBusy(false); }
  }
  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 16 }}>New operator</h2>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        No password is set here — you&apos;ll get a one-time link to send them, and they set their own.
      </p>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))' }}>
        <div><label>Email</label><input type="email" value={f.email ?? ''} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="name@vendor.pk" /></div>
        <div><label>Name</label><input value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div><label>Role</label>
          <select value={f.role ?? 'ANALYST'} onChange={(e) => setF({ ...f, role: e.target.value })}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      </div>
      <div><button onClick={submit} disabled={busy || !f.email}>{busy ? 'Creating…' : 'Create & get link'}</button></div>
    </div>
  );
}

/** The operator invite link, shown ONCE after creation (SA-P3) — copyable, dismiss is deliberate. */
function OperatorInviteLink({ email, url, onClose }: { email: string; url: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() { try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setCopied(false); } }
  return (
    <div className="card stack" style={{ borderColor: '#86efac', background: '#f0fdf4' }}>
      <div className="row">
        <strong style={{ fontSize: 15 }}>Invited {email} — share this set-password link</strong>
        <span className="badge warn">Shown once</span>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        Send this to the new operator — it lets them set their own password (valid 7 days, single use).
        It can&apos;t be shown again, so copy it now.
      </p>
      <code style={{ display: 'block', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, wordBreak: 'break-all', background: '#fff', fontSize: 13 }}>{url}</code>
      <div className="row" style={{ justifyContent: 'flex-start', gap: 8 }}>
        <button className="ghost small" onClick={copy}>{copied ? 'Copied ✓' : 'Copy link'}</button>
        <button className="small" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
