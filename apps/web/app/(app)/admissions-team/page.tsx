'use client';

import { useEffect, useState } from 'react';
import { api, apiGet, ApiError, type Campus, type ManagedUser } from '@/lib/api';
import { useMe } from '@/lib/me-context';

type Msg = { ok: boolean; text: string } | null;

/**
 * Admission Portal setup (§23). Each campus has its own Admission Portal — a login,
 * provisioned here by the campus admin, that manages ONLY that campus's admissions
 * pipeline. The owner sees every campus; a campus admin sees only their own.
 * (Password resets are owner-only, matching the users policy in §23.)
 */
export default function AdmissionsTeamPage() {
  const me = useMe();
  const isOwner = (me?.roles ?? []).includes('OWNER_ADMIN');
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [msg, setMsg] = useState<Msg>(null);

  async function load() {
    const [c, u] = await Promise.all([apiGet<Campus[]>('/campuses'), api.users.list()]);
    setCampuses(c);
    setUsers(u);
  }
  useEffect(() => { load().catch(() => {}); }, []);

  // Campus admins only manage their own campus; owners manage all.
  const myCampuses = isOwner ? campuses : campuses.filter((c) => c.id === me?.campusId);
  const controllersOf = (campusId: string) =>
    users.filter((u) => u.campusId === campusId && u.roles.includes('ADMISSION_CONTROLLER'));
  // Each campus gets its own dedicated, branded Admission Portal link.
  const portalLink = (name: string) =>
    typeof window === 'undefined' ? '' : `${window.location.origin}/admission-portal/${encodeURIComponent(name)}`;

  return (
    <div className="stack">
      <h1>Admission Portal</h1>
      <p className="muted" style={{ margin: 0 }}>
        Each campus has its own Admission Portal. Create a login below — that person (the
        admission controller) signs in through the campus login link and manages only this
        campus&apos;s admissions: inquiries, entry tests, and admitting students.
      </p>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {myCampuses.map((c) => {
        const controllers = controllersOf(c.id);
        return (
          <div className="card stack" key={c.id}>
            <h2 style={{ margin: 0, fontSize: 18 }}>{c.name}</h2>

            {/* The dedicated Admission Portal link — the primary thing here. Hand it to the
                admission controller; they open it and sign in to this campus's admissions. */}
            <div className="stack" style={{ gap: 6, padding: 12, border: '1px solid #c7d2fe', background: '#eef2ff', borderRadius: 8 }}>
              <div className="muted" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>🎓 Admission Portal link</div>
              <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <a href={portalLink(c.name)} target="_blank" rel="noreferrer" style={{ fontSize: 13, wordBreak: 'break-all' }}>{portalLink(c.name)}</a>
                <button className="ghost small" onClick={() => { navigator.clipboard?.writeText(portalLink(c.name)); setMsg({ ok: true, text: 'Admission Portal link copied' }); }}>Copy</button>
              </div>
              <div className="muted" style={{ fontSize: 12 }}>Give this link to the admission controller — it opens the {c.name} Admission Portal sign-in.</div>
            </div>

            {controllers.length > 0 ? (
              <table>
                <tbody>
                  {controllers.map((u) => (
                    <tr key={u.id}>
                      <td>{u.email}</td>
                      <td><span className={`badge ${u.status === 'ACTIVE' ? 'ok' : 'bad'}`}>{u.status}</span></td>
                      <td style={{ textAlign: 'right' }}><ResetPw id={u.id} onDone={(ok, text) => setMsg({ ok, text })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>No admission login yet for this campus.</p>
            )}

            <AddController campusId={c.id} campusName={c.name}
              onDone={async (ok, text) => { setMsg({ ok, text }); if (ok) await load(); }} />
          </div>
        );
      })}

      {myCampuses.length === 0 && (
        <p className="muted">
          {isOwner ? 'No campuses yet — add one in Campus Hub first.' : 'Your account isn’t bound to a campus.'}
        </p>
      )}
    </div>
  );
}

function AddController({ campusId, campusName, onDone }: { campusId: string; campusName: string; onDone: (ok: boolean, text: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  async function submit() {
    try {
      const u = await api.users.create({ email, roles: ['ADMISSION_CONTROLLER'], campusId, password });
      onDone(true, `${u.email} can now sign in to the ${campusName} Admission Portal.`);
      setEmail('');
      setPassword('');
    } catch (e) {
      onDone(false, e instanceof ApiError ? e.message : 'Failed to create admission login');
    }
  }
  return (
    <div className="inline-form">
      <div><label>Email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admissions@school.pk" /></div>
      <div><label>Initial password</label><input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="min 10 characters" /></div>
      <button onClick={submit} disabled={!email || password.length < 10}>Create admission login</button>
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
