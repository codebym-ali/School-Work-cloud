'use client';

import { useEffect, useState } from 'react';
import { api, apiGet, apiPost, apiDelete, ApiError, type Campus, type ManagedUser } from '@sw/api-client';
import { useMe } from '@sw/session';
import { doorOrigin, roleLabels } from '@sw/roles';
import { CampusComparison } from './campus-comparison';

type Msg = { ok: boolean; text: string } | null;

/**
 * ⚠️ **Seat roles are singular, and the screen has to say so before you act, not after.**
 *
 * A campus has exactly one campus admin, one admission officer and one accountant — enforced in
 * `UsersService` and by a partial unique index per role. The screen did not know that: it listed
 * "Campus Admins" (plural), always offered every role in the add form, and let the API answer with
 * a 409. Offering an action the server will refuse is the defect this project keeps correcting;
 * here it is fixed by showing **who holds the seat** instead of an invitation to fill it twice.
 *
 * `hint` is what to do when the seat is EMPTY — an empty seat is a real gap (nobody can take fees
 * at this campus), so it renders as a prompt rather than being hidden the way empty non-seat
 * groups are.
 */
const ROLE_GROUPS: Array<{ role: string; label: string; seat?: boolean; hint?: string }> = [
  { role: 'CAMPUS_ADMIN', label: 'Campus admin', seat: true, hint: 'Nobody runs this campus day to day.' },
  { role: 'ADMISSION_CONTROLLER', label: 'Admission officer', seat: true, hint: 'Nobody can admit students here.' },
  { role: 'ACCOUNTANT', label: 'Accountant', seat: true, hint: 'Nobody but an owner can take a fee payment here.' },
  { role: 'TEACHER', label: 'Teachers' },
  { role: 'STAFF', label: 'Staff' },
];
const SEAT_ROLES = ROLE_GROUPS.filter((g) => g.seat).map((g) => g.role);

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
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

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
  /** role → the email already holding that seat on this campus, for roles that are seats. */
  const seatHolders = (campusId: string): Record<string, string> => {
    const held: Record<string, string> = {};
    for (const role of SEAT_ROLES) {
      const holder = usersOf(campusId).find((u) => u.roles.includes(role));
      if (holder) held[role] = holder.email;
    }
    return held;
  };
  const schoolWide = users.filter((u) => u.campusId == null);
  // ⚠️ The STAFF door, never "this origin". Campus Hub is owner-only, so this origin is always the
  // owner door — which admits OWNER_ADMIN alone, and refuses anyone else with the same "invalid
  // credentials" a wrong password gets. A campus admin handed the old link could not sign in, and
  // had no way to learn why. Only the staff door honours `?campus=`.
  const loginLink = (name: string) =>
    typeof window === 'undefined' ? '' : `${doorOrigin('staff', window.location)}/login?campus=${encodeURIComponent(name)}`;

  return (
    <div className="stack">
      <h1>Campuses</h1>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {/* Figures first: "which campus is behind" is the question; managing the campuses comes after. */}
      {isOwner && <CampusComparison />}

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
            <AddUser campusId={c.id} campusName={c.name} taken={seatHolders(c.id)}
              onDone={async (ok, text) => { setMsg({ ok, text }); if (ok) { setOpenFor(null); await load(); } }} />
          )}

          {ROLE_GROUPS.map(({ role, label, seat, hint }) => {
            const group = usersOf(c.id).filter((u) => u.roles.includes(role));
            // A non-seat group with nobody in it is just absent. An empty SEAT is a gap worth
            // naming, so it renders with what the campus cannot currently do.
            if (group.length === 0 && !seat) return null;
            return (
              <div key={role}>
                <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</div>
                {group.length === 0 && (
                  <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>
                    Not assigned. {hint}
                    {isOwner ? ' Use “+ Add user” above.' : ''}
                  </p>
                )}
                {group.length > 0 && (
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
                )}
              </div>
            );
          })}
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
                <tr key={u.id}><td>{u.email}</td><td>{roleLabels(u.roles).join(', ')}</td><td><span className={`badge ${u.status === 'ACTIVE' ? 'ok' : 'bad'}`}>{u.status}</span></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const ADDABLE_ROLES: Array<{ value: string; label: string }> = [
  { value: 'CAMPUS_ADMIN', label: 'Campus Admin' },
  { value: 'ADMISSION_CONTROLLER', label: 'Admission Controller' },
  { value: 'ACCOUNTANT', label: 'Accountant' },
  { value: 'TEACHER', label: 'Teacher' },
  { value: 'STAFF', label: 'Staff' },
];

function AddUser({ campusId, campusName, taken, onDone }: {
  campusId: string; campusName: string; taken: Record<string, string>;
  onDone: (ok: boolean, text: string) => void;
}) {
  // ⚠️ Default to a role that can actually be created. `CAMPUS_ADMIN` was hard-coded, so on any
  // configured campus the form opened pre-set to a seat that was already filled — the one choice
  // guaranteed to 409.
  const firstFree = ADDABLE_ROLES.find((r) => !taken[r.value])?.value ?? 'TEACHER';
  const [f, setF] = useState<Record<string, string>>({ role: firstFree });
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  const takenBy = taken[f.role];
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
            {ADDABLE_ROLES.map((r) => (
              // Disabled rather than hidden: "Accountant — held by x@y.pk" answers the question the
              // owner is actually asking, where a missing option would just look like a bug.
              <option key={r.value} value={r.value} disabled={!!taken[r.value]}>
                {taken[r.value] ? `${r.label} — held by ${taken[r.value]}` : r.label}
              </option>
            ))}
          </select>
        </div>
        <div><label>Initial password</label><input type="text" value={f.password ?? ''} onChange={(e) => set('password', e.target.value)} placeholder="min 10 characters" /></div>
      </div>
      {takenBy && (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          This campus already has {ADDABLE_ROLES.find((r) => r.value === f.role)?.label.toLowerCase()} ({takenBy}).
          Remove or reassign them before adding another.
        </p>
      )}
      <div><button onClick={submit} disabled={!f.email || (f.password ?? '').length < 10 || !!takenBy}>Create login for {campusName}</button></div>
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
