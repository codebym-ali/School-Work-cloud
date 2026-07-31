'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type CampusAdmissionOfficer, type ManagedUser } from '@/lib/api';
import { useMe } from '@/lib/me-context';

type Msg = { ok: boolean; text: string } | null;

/**
 * Admission Portal — the per-campus admission seat (§8/§23).
 *
 * A campus has exactly ONE admission officer, so this screen is organised by CAMPUS, not by
 * person: the question a school actually asks is "who handles admissions at Falcon Girls?",
 * which a per-person permission list cannot answer (and cannot show you a campus with nobody).
 *
 * This is the only place the seat is assigned. It is deliberately not also a toggle on the
 * Staff page: two write paths for one rule is how the same rule ends up enforced two
 * different ways. Assigning reuses the employee's existing login — no new credentials.
 */
export default function AdmissionsTeamPage() {
  const me = useMe();
  const isOwner = (me?.roles ?? []).includes('OWNER_ADMIN');
  const [rows, setRows] = useState<CampusAdmissionOfficer[]>([]);
  const [staff, setStaff] = useState<ManagedUser[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [officers, users] = await Promise.all([api.admissionOfficers.list(), api.users.list()]);
      setRows(officers);
      setStaff(users);
      setErr(false);
    } catch {
      setErr(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Each campus gets its own dedicated, branded Admission Portal sign-in.
  const portalLink = (name: string) =>
    typeof window === 'undefined' ? '' : `${window.location.origin}/admission-portal/${encodeURIComponent(name)}`;

  /** Only this campus's own people can hold its seat — the server enforces it too. */
  const candidatesFor = (campusId: string, currentId?: string) =>
    staff.filter((u) => u.campusId === campusId && u.status === 'ACTIVE' && u.id !== currentId);

  async function act(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      await load();
      setEditing(null);
      setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Something went wrong' });
    }
  }

  if (loading) return <p className="muted">Loading…</p>;
  if (err) return <p className="muted">Couldn&apos;t load the admission officers.</p>;

  return (
    <div className="stack">
      <h1>Admission Portal</h1>
      <p className="muted" style={{ margin: 0 }}>
        Each campus has <b>one</b> admission officer — the person who admits students there.
        Give the job to someone already on that campus&apos;s staff; they keep their existing
        login and simply gain the Admission Portal.
      </p>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {rows.map((c) => {
        const candidates = candidatesFor(c.campusId, c.officer?.id);
        const isEditing = editing === c.campusId;
        return (
          <div className="card stack" key={c.campusId}>
            <div className="row">
              <h2 style={{ margin: 0, fontSize: 18 }}>{c.campusName}</h2>
              {isOwner && !isEditing && (
                <div className="row" style={{ gap: 8 }}>
                  <button className="ghost small" onClick={() => setEditing(c.campusId)}>
                    {c.officer ? 'Change person' : 'Assign officer'}
                  </button>
                  {c.officer && (
                    <button
                      className="ghost small"
                      onClick={() => {
                        if (confirm(`Remove ${c.officer?.email} as ${c.campusName}'s admission officer? They keep their login and every other role.`)) {
                          act(() => api.admissionOfficers.remove(c.campusId), `${c.campusName} has no admission officer now`);
                        }
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              )}
            </div>

            {c.officer ? (
              <div className="row" style={{ justifyContent: 'flex-start', gap: 8, alignItems: 'center' }}>
                <span className="badge ok">Admission officer</span>
                <b>{c.officer.email}</b>
                {c.officer.status !== 'ACTIVE' && <span className="badge bad">{c.officer.status}</span>}
              </div>
            ) : (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                No admission officer yet — nobody can admit students at {c.campusName}.
              </p>
            )}

            {isEditing && (
              <AssignOfficer
                campusName={c.campusName}
                current={c.officer?.email ?? null}
                candidates={candidates}
                onCancel={() => setEditing(null)}
                onPick={(userId, email) =>
                  act(
                    () => api.admissionOfficers.set(c.campusId, userId),
                    c.officer
                      ? `${email} is now ${c.campusName}'s admission officer (taken over from ${c.officer.email})`
                      : `${email} is now ${c.campusName}'s admission officer`,
                  )
                }
              />
            )}

            {/* The branded sign-in for this campus — hand it to whoever holds the seat. */}
            <div className="stack" style={{ gap: 6, padding: 12, border: '1px solid #c7d2fe', background: '#eef2ff', borderRadius: 8 }}>
              <div className="muted" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>🎓 Admission Portal link</div>
              <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <a href={portalLink(c.campusName)} target="_blank" rel="noreferrer" style={{ fontSize: 13, wordBreak: 'break-all' }}>{portalLink(c.campusName)}</a>
                <button className="ghost small" onClick={() => { navigator.clipboard?.writeText(portalLink(c.campusName)); setMsg({ ok: true, text: 'Admission Portal link copied' }); }}>Copy</button>
              </div>
            </div>
          </div>
        );
      })}

      {rows.length === 0 && (
        <p className="muted">
          {isOwner ? 'No campuses yet — add one in Campus Hub first.' : 'Your account isn’t bound to a campus.'}
        </p>
      )}
    </div>
  );
}

function AssignOfficer({ campusName, current, candidates, onPick, onCancel }: {
  campusName: string;
  current: string | null;
  candidates: ManagedUser[];
  onPick: (userId: string, email: string) => void;
  onCancel: () => void;
}) {
  const [userId, setUserId] = useState('');
  const picked = candidates.find((u) => u.id === userId);

  if (candidates.length === 0) {
    return (
      <div className="stack" style={{ gap: 6 }}>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Nobody else on {campusName} can take this yet — add a staff member to this campus
          first, on the Staff screen.
        </p>
        <div><button className="ghost small" onClick={onCancel}>Cancel</button></div>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <label style={{ fontSize: 13 }}>
        {current ? `Hand ${campusName}'s admission access over to` : `Who handles admissions at ${campusName}?`}
      </label>
      <div className="inline-form">
        <select value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Select a staff member…</option>
          {candidates.map((u) => (
            <option key={u.id} value={u.id}>{u.email}</option>
          ))}
        </select>
        <button disabled={!userId} onClick={() => picked && onPick(picked.id, picked.email)}>
          {current ? 'Hand over' : 'Assign'}
        </button>
        <button className="ghost" onClick={onCancel}>Cancel</button>
      </div>
      {current && userId && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          {current} will lose the Admission Portal — they keep their login and every other role.
        </p>
      )}
    </div>
  );
}
