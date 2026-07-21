'use client';

import { useEffect, useState } from 'react';
import { api, apiGet, apiPost, apiDelete, ApiError, type Campus, type ManagedUser } from '@/lib/api';
import { useMe } from '@/lib/me-context';

type Msg = { ok: boolean; text: string } | null;
const ROLE_GROUPS: Array<{ role: string; label: string }> = [
  { role: 'CAMPUS_ADMIN', label: 'Campus Admins' },
  { role: 'ADMISSION_CONTROLLER', label: 'Admission Controllers' },
  { role: 'ACCOUNTANT', label: 'Accountants' },
  { role: 'TEACHER', label: 'Teachers' },
  { role: 'STAFF', label: 'Staff' },
];

export default function CampusesPage() {
  const me = useMe();
  const isOwner = (me?.roles ?? []).includes('OWNER_ADMIN');
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [newCampus, setNewCampus] = useState('');
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<Msg>(null);

  async function load() {
    const [c, u] = await Promise.all([apiGet<Campus[]>('/campuses'), api.users.list()]);
    setCampuses(c);
    setUsers(u);
    setSelected(new Set());
  }
  useEffect(() => { load().catch(() => {}); }, []);

  const toggleSelected = (id: string) =>
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function bulkDelete() {
    if (!window.confirm(`Remove ${selected.size} selected user(s)? They'll be taken off their campus and can no longer sign in.`)) return;
    try {
      const res = await api.users.bulkDelete(Array.from(selected));
      setMsg({ ok: true, text: `Removed ${res.removed} user(s)${res.skipped ? ` · ${res.skipped} skipped (owner/self/other campus)` : ''}` });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Bulk remove failed' });
    }
  }

  async function addCampus() {
    try {
      await apiPost('/campuses', { name: newCampus.trim() });
      setNewCampus('');
      setMsg({ ok: true, text: 'Campus created' });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to add campus' });
    }
  }

  async function removeCampus(c: Campus) {
    if (!window.confirm(`Delete campus "${c.name}"? This can't be undone.`)) return;
    try {
      await apiDelete(`/campuses/${c.id}`);
      setMsg({ ok: true, text: `Deleted "${c.name}"` });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to delete campus' });
    }
  }

  // Owner removes an admin/user of a campus — they're taken off the directory and can't sign in.
  async function removeUser(u: ManagedUser) {
    if (!window.confirm(`Remove ${u.email}? They'll be taken off this campus and can no longer sign in. This can't be undone from here.`)) return;
    try {
      await api.users.remove(u.id);
      setMsg({ ok: true, text: `Removed ${u.email}` });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to remove user' });
    }
  }

  const usersOf = (campusId: string) => users.filter((u) => u.campusId === campusId);
  const schoolWide = users.filter((u) => u.campusId == null);
  const loginLink = (name: string) =>
    typeof window === 'undefined' ? '' : `${window.location.origin}/login?campus=${encodeURIComponent(name)}`;

  return (
    <div className="stack">
      <h1>Campuses</h1>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {isOwner && selected.size > 0 && (
        <div className="card row" style={{ alignItems: 'center', gap: 12 }}>
          <strong>{selected.size} selected</strong>
          <span className="row" style={{ gap: 8, marginLeft: 'auto' }}>
            <button className="ghost small" onClick={() => setSelected(new Set())}>Clear</button>
            <button className="small" style={{ background: '#c0392b' }} onClick={bulkDelete}>Remove selected</button>
          </span>
        </div>
      )}

      {isOwner && (
        <div className="inline-form">
          <div style={{ minWidth: 280 }}>
            <label>New campus name</label>
            <input value={newCampus} onChange={(e) => setNewCampus(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && newCampus.trim() && addCampus()} placeholder="e.g. Falcon Girls Campus" />
          </div>
          <button disabled={!newCampus.trim()} onClick={addCampus}>Add campus</button>
        </div>
      )}

      {campuses.map((c) => (
        <div className="card stack" key={c.id}>
          <div className="row">
            <h2 style={{ margin: 0, fontSize: 18 }}>{c.name}</h2>
            {isOwner && (
              <span className="row" style={{ gap: 6 }}>
                <button className="ghost small" onClick={() => setOpenFor(openFor === c.id ? null : c.id)}>{openFor === c.id ? 'Close' : '+ Add user'}</button>
                <button className="ghost small" style={{ color: '#c0392b' }} onClick={() => removeCampus(c)}>Delete</button>
              </span>
            )}
          </div>

          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <button onClick={() => window.open(loginLink(c.name), '_blank', 'noopener,noreferrer')}>
              🔗 Campus login ↗
            </button>
            <span className="muted" style={{ fontSize: 12 }}>Opens the {c.name} login page in a new tab.</span>
          </div>

          {openFor === c.id && isOwner && (
            <AddUser campusId={c.id} campusName={c.name}
              onDone={async (ok, text) => { setMsg({ ok, text }); if (ok) { setOpenFor(null); await load(); } }} />
          )}

          {ROLE_GROUPS.map(({ role, label }) => {
            const group = usersOf(c.id).filter((u) => u.roles.includes(role));
            if (group.length === 0) return null;
            return (
              <div key={role}>
                <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</div>
                <table>
                  <tbody>
                    {group.map((u) => (
                      <tr key={u.id}>
                        {isOwner && (
                          <td style={{ width: 28 }}>
                            <input type="checkbox" aria-label={`Select ${u.email}`} checked={selected.has(u.id)} onChange={() => toggleSelected(u.id)} />
                          </td>
                        )}
                        <td>{u.email}</td>
                        <td><span className={`badge ${u.status === 'ACTIVE' ? 'ok' : 'bad'}`}>{u.status}</span></td>
                        {isOwner && (
                          <td style={{ textAlign: 'right' }}>
                            <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                              <ResetPw id={u.id} onDone={(ok, text) => setMsg({ ok, text })} />
                              <button className="ghost small" style={{ color: '#c0392b' }} onClick={() => removeUser(u)}>Remove</button>
                            </span>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
          {usersOf(c.id).length === 0 && <p className="muted" style={{ margin: 0 }}>No users yet. Add a campus admin so someone can log in and manage this campus.</p>}
        </div>
      ))}
      {campuses.length === 0 && <p className="muted">No campuses yet.{isOwner ? ' Add one above.' : ''}</p>}

      {schoolWide.length > 0 && (
        <div className="card stack">
          <h2 style={{ margin: 0, fontSize: 18 }}>School-wide</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>Owners aren&apos;t tied to a campus — they see the whole school.</p>
          <table>
            <tbody>
              {schoolWide.map((u) => (
                <tr key={u.id}><td>{u.email}</td><td>{u.roles.join(', ')}</td><td><span className={`badge ${u.status === 'ACTIVE' ? 'ok' : 'bad'}`}>{u.status}</span></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AddUser({ campusId, campusName, onDone }: { campusId: string; campusName: string; onDone: (ok: boolean, text: string) => void }) {
  const [f, setF] = useState<Record<string, string>>({ role: 'CAMPUS_ADMIN' });
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  async function submit() {
    try {
      const u = await api.users.create({ email: f.email, roles: [f.role], campusId, password: f.password });
      onDone(true, `${u.email} can now sign in for ${campusName}.`);
    } catch (e) {
      onDone(false, e instanceof ApiError ? e.message : 'Failed to create user');
    }
  }
  return (
    <div className="card stack">
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px,1fr))' }}>
        <div><label>Email</label><input type="email" value={f.email ?? ''} onChange={(e) => set('email', e.target.value)} placeholder="admin@school.pk" /></div>
        <div><label>Role</label>
          <select value={f.role} onChange={(e) => set('role', e.target.value)}>
            <option value="CAMPUS_ADMIN">Campus Admin</option>
            <option value="ADMISSION_CONTROLLER">Admission Controller</option>
            <option value="ACCOUNTANT">Accountant</option>
            <option value="TEACHER">Teacher</option>
            <option value="STAFF">Staff</option>
          </select>
        </div>
        <div><label>Initial password</label><input type="text" value={f.password ?? ''} onChange={(e) => set('password', e.target.value)} placeholder="min 10 characters" /></div>
      </div>
      <div><button onClick={submit} disabled={!f.email || (f.password ?? '').length < 10}>Create login for {campusName}</button></div>
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
    <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
      <input value={pw} onChange={(e) => setPw(e.target.value)} placeholder="new password" style={{ width: 150 }} />
      <button className="small" disabled={pw.length < 10} onClick={submit}>Set</button>
    </span>
  );
}
