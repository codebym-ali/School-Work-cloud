'use client';

import { useEffect, useState } from 'react';
import { api, apiGet, ApiError, type Campus, type ManagedUser } from '@/lib/api';
import { useMe } from '@/lib/me-context';

const ALL_ROLES = ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT', 'TEACHER', 'STAFF'];

export default function UsersPage() {
  const me = useMe();
  const isOwner = (me?.roles ?? []).includes('OWNER_ADMIN');
  const roleOptions = isOwner ? ALL_ROLES : ['ACCOUNTANT', 'TEACHER', 'STAFF'];

  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() { setUsers(await api.users.list()); }
  useEffect(() => {
    apiGet<Campus[]>('/campuses').then(setCampuses).catch(() => {});
    load().catch(() => {});
  }, []);

  return (
    <div className="stack">
      <div className="row">
        <h1>Users</h1>
        <button onClick={() => setAdding((v) => !v)}>{adding ? 'Close' : '+ New user'}</button>
      </div>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {adding && (
        <NewUser
          roleOptions={roleOptions}
          campuses={campuses}
          onDone={async (ok, text) => { setMsg({ ok, text }); if (ok) { setAdding(false); await load(); } }}
        />
      )}

      <table>
        <thead><tr><th>Email</th><th>Roles</th><th>Campus</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.email}</td>
              <td>{u.roles.join(', ')}</td>
              <td>{u.campusName ?? <span className="muted">school-wide</span>}</td>
              <td><span className={`badge ${u.status === 'ACTIVE' ? 'ok' : u.status === 'DISABLED' ? 'bad' : ''}`}>{u.status}</span></td>
              <td>{isOwner && <ResetPw id={u.id} onDone={(ok, text) => setMsg({ ok, text })} />}</td>
            </tr>
          ))}
          {users.length === 0 && <tr><td colSpan={5} className="muted">No staff users yet. Create one to give someone campus access.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function NewUser({
  roleOptions, campuses, onDone,
}: { roleOptions: string[]; campuses: Campus[]; onDone: (ok: boolean, text: string) => void }) {
  const [f, setF] = useState<Record<string, string>>({ role: roleOptions[0] });
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  const needsCampus = f.role !== 'OWNER_ADMIN';

  async function submit() {
    try {
      const body: { email: string; roles: string[]; password: string; campusId?: string } = {
        email: f.email, roles: [f.role], password: f.password,
      };
      if (needsCampus && f.campusId) body.campusId = f.campusId;
      const u = await api.users.create(body);
      onDone(true, `Created ${u.email} — they can sign in now with the password you set.`);
    } catch (e) {
      onDone(false, e instanceof ApiError ? e.message : 'Failed to create user');
    }
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>New user</h2>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))' }}>
        <div><label>Email</label><input type="email" value={f.email ?? ''} onChange={(e) => set('email', e.target.value)} placeholder="admin@school.pk" /></div>
        <div><label>Role</label><select value={f.role} onChange={(e) => set('role', e.target.value)}>{roleOptions.map((r) => <option key={r} value={r}>{r}</option>)}</select></div>
        {needsCampus && (
          <div><label>Campus</label>
            <select value={f.campusId ?? ''} onChange={(e) => set('campusId', e.target.value)}>
              <option value="">Select…</option>
              {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <div><label>Initial password</label><input type="text" value={f.password ?? ''} onChange={(e) => set('password', e.target.value)} placeholder="min 10 characters" /></div>
      </div>
      <div><button onClick={submit} disabled={!f.email || (f.password ?? '').length < 10 || (needsCampus && !f.campusId)}>Create user</button></div>
      <p className="muted" style={{ margin: 0 }}>
        Share the email + password with the person. A campus role only ever sees that campus&apos;s data. They can change their password after signing in.
      </p>
    </div>
  );
}

function ResetPw({ id, onDone }: { id: string; onDone: (ok: boolean, text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState('');
  async function submit() {
    try {
      await api.users.resetPassword(id, pw);
      onDone(true, 'Password reset.');
      setOpen(false);
      setPw('');
    } catch (e) {
      onDone(false, e instanceof ApiError ? e.message : 'Reset failed');
    }
  }
  if (!open) return <button className="ghost small" onClick={() => setOpen(true)}>Reset password</button>;
  return (
    <span className="row" style={{ gap: 4 }}>
      <input value={pw} onChange={(e) => setPw(e.target.value)} placeholder="new password" style={{ width: 150 }} />
      <button className="small" disabled={pw.length < 10} onClick={submit}>Set</button>
    </span>
  );
}
