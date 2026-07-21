'use client';

import { useEffect, useState } from 'react';
import { api, apiGet, ApiError, type Campus, type ManagedTeacher, type Vacancy } from '@/lib/api';
import { useMe } from '@/lib/me-context';

type Msg = { ok: boolean; text: string } | null;
const EMPLOYMENT = [
  { v: 'FULL_TIME', label: 'Full-time' },
  { v: 'PART_TIME', label: 'Part-time' },
  { v: 'CONTRACT', label: 'Contract' },
];
const STATUSES = ['OPEN', 'ON_HOLD', 'CLOSED'];
const empLabel = (v: string) => EMPLOYMENT.find((e) => e.v === v)?.label ?? v;

/**
 * Recruitment — vacancies (HR module, first slice). List/create/close job openings.
 * All four data states are implemented: loading → data → empty → error (with Retry +
 * requestId). Owner sees all campuses; a campus admin is scoped to their own by the API.
 */
export default function RecruitmentPage() {
  const me = useMe();
  const isOwner = (me?.roles ?? []).includes('OWNER_ADMIN');

  const [vacancies, setVacancies] = useState<Vacancy[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [fStatus, setFStatus] = useState('');
  const [adding, setAdding] = useState(false);
  const [managingAccess, setManagingAccess] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const [v, c] = await Promise.all([
        api.vacancies.list(fStatus ? { status: fStatus } : undefined),
        apiGet<Campus[]>('/campuses'),
      ]);
      setVacancies(v);
      setCampuses(c);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', 'Failed to load vacancies'));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load().catch(() => {}); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [fStatus]);

  const myCampuses = isOwner ? campuses : campuses.filter((c) => c.id === me?.campusId);

  async function closeVacancy(v: Vacancy) {
    if (!window.confirm(`Close the vacancy "${v.title}"? It will stop accepting applications. This can't be undone.`)) return;
    try {
      await api.vacancies.close(v.id);
      setMsg({ ok: true, text: `Closed "${v.title}"` });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to close vacancy' });
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <h1>Recruitment</h1>
        <div className="row" style={{ gap: 8 }}>
          {isOwner && <button className="ghost" onClick={() => setManagingAccess((v) => !v)}>{managingAccess ? 'Close access' : 'Manage access'}</button>}
          <button onClick={() => setAdding((v) => !v)}>{adding ? 'Close' : '+ Post vacancy'}</button>
        </div>
      </div>
      <p className="muted" style={{ margin: 0 }}>Job openings across the school. Post a vacancy for a campus, then close it once filled.</p>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {isOwner && managingAccess && (
        <AccessManager onMsg={(ok, text) => setMsg({ ok, text })} />
      )}

      {adding && (
        <PostVacancy campuses={myCampuses} lockedCampus={isOwner ? null : (me?.campusId ?? null)}
          onDone={async (ok, text) => { setMsg({ ok, text }); if (ok) { setAdding(false); await load(); } }} />
      )}

      <div className="inline-form">
        <div><label>Status</label>
          <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase().replace('_', ' ')}</option>)}
          </select>
        </div>
      </div>

      {/* Four states: loading → error → empty → data */}
      {loading ? (
        <div className="card"><p className="muted">Loading vacancies…</p></div>
      ) : loadError ? (
        <div className="card stack">
          <div className="toast err">{loadError.message}</div>
          {loadError.requestId && <p className="muted" style={{ margin: 0, fontSize: 12 }}>Request ID: <code>{loadError.requestId}</code></p>}
          <div><button className="ghost" onClick={() => load()}>Retry</button></div>
        </div>
      ) : vacancies.length === 0 ? (
        <div className="card stack">
          <p className="muted" style={{ margin: 0 }}>{fStatus ? 'No vacancies with this status.' : 'No vacancies yet.'}</p>
          <div><button onClick={() => setAdding(true)}>Post the first vacancy</button></div>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead><tr><th>Title</th><th>Department</th><th>Campus</th><th>Type</th><th>Positions</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {vacancies.map((v) => (
                <tr key={v.id}>
                  <td>{v.title}</td>
                  <td>{v.department}</td>
                  <td>{v.campusName ?? '—'}</td>
                  <td>{empLabel(v.employmentType)}</td>
                  <td>{v.positions}</td>
                  <td><span className={`badge ${v.status === 'OPEN' ? 'ok' : v.status === 'ON_HOLD' ? 'warn' : 'bad'}`}>{v.status.replace('_', ' ')}</span></td>
                  <td style={{ textAlign: 'right' }}>
                    {v.status !== 'CLOSED' && <button className="ghost small" onClick={() => closeVacancy(v)}>Close</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PostVacancy({ campuses, lockedCampus, onDone }: {
  campuses: Campus[]; lockedCampus: string | null; onDone: (ok: boolean, text: string) => void;
}) {
  const [f, setF] = useState<Record<string, string>>({ employmentType: 'FULL_TIME', positions: '1', campusId: lockedCampus ?? '' });
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const [busy, setBusy] = useState(false);
  const [fieldIssues, setFieldIssues] = useState<string[]>([]);
  const campusId = lockedCampus ?? f.campusId;
  const ready = f.title && f.department && f.description && campusId && Number(f.positions) >= 1;

  async function submit() {
    setBusy(true);
    setFieldIssues([]);
    try {
      await api.vacancies.create({
        campusId, title: f.title, department: f.department, description: f.description,
        employmentType: f.employmentType, positions: Number(f.positions),
      });
      onDone(true, `Posted "${f.title}"`);
    } catch (e) {
      if (e instanceof ApiError && e.fieldIssues.length) setFieldIssues(e.fieldIssues);
      onDone(false, e instanceof ApiError ? e.message : 'Failed to post vacancy');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>Post a vacancy</h2>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px,1fr))' }}>
        <div><label>Title</label><input value={f.title ?? ''} onChange={(e) => set('title', e.target.value)} placeholder="Mathematics Teacher" /></div>
        <div><label>Department</label><input value={f.department ?? ''} onChange={(e) => set('department', e.target.value)} placeholder="Science" /></div>
        <div><label>Employment type</label>
          <select value={f.employmentType} onChange={(e) => set('employmentType', e.target.value)}>
            {EMPLOYMENT.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}
          </select>
        </div>
        <div><label>Positions</label><input type="number" min={1} value={f.positions ?? ''} onChange={(e) => set('positions', e.target.value)} /></div>
        {!lockedCampus && (
          <div><label>Campus</label>
            <select value={f.campusId ?? ''} onChange={(e) => set('campusId', e.target.value)}>
              <option value="">Select…</option>
              {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
      </div>
      <div><label>Description</label>
        <textarea value={f.description ?? ''} onChange={(e) => set('description', e.target.value)} rows={3} style={{ width: '100%' }} placeholder="Role summary, requirements…" />
      </div>
      {fieldIssues.length > 0 && (
        <ul className="toast err" style={{ margin: 0, paddingLeft: 22 }}>
          {fieldIssues.map((i, n) => <li key={n}>{i}</li>)}
        </ul>
      )}
      <div><button disabled={!ready || busy} onClick={submit}>{busy ? 'Posting…' : 'Post vacancy'}</button></div>
    </div>
  );
}

/**
 * Owner-only: grant/revoke recruitment (HR) access to existing employees. Reuses their
 * account (no new login) by adding/removing the HR_MANAGER role via the users API.
 */
function AccessManager({ onMsg }: { onMsg: (ok: boolean, text: string) => void }) {
  const [staff, setStaff] = useState<ManagedTeacher[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  async function load() {
    setLoading(true);
    try { setStaff(await api.staff.list()); }
    catch (e) { onMsg(false, e instanceof ApiError ? e.message : 'Failed to load staff'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load().catch(() => {}); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function toggle(fn: () => Promise<unknown>, text: string) {
    try { await fn(); onMsg(true, text); await load(); }
    catch (e) { onMsg(false, e instanceof ApiError ? e.message : 'Failed to update access'); }
  }

  const q = search.trim().toLowerCase();
  const rows = staff.filter((s) => !q || `${s.user.email} ${s.designation} ${s.employeeCode}`.toLowerCase().includes(q));

  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>Access &amp; roles</h2>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        Grant an existing employee access to <strong>Recruitment</strong> or make them the <strong>Campus Admin (principal)</strong> of
        their campus. They keep their own login — the access appears for them once granted.
      </p>
      <div className="inline-form">
        <div style={{ minWidth: 220 }}><label>Search employee</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="name / title / code" />
        </div>
      </div>
      {loading ? (
        <p className="muted" style={{ margin: 0 }}>Loading employees…</p>
      ) : rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>{staff.length === 0 ? 'No staff yet — add employees on the Staff screen first.' : 'No employees match.'}</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead><tr><th>Employee</th><th>Title</th><th>Campus</th><th>Recruitment access</th><th>Campus Admin</th></tr></thead>
            <tbody>
              {rows.map((s) => {
                const hasHr = s.user.roles.includes('HR_MANAGER');
                const hasCa = s.user.roles.includes('CAMPUS_ADMIN');
                return (
                  <tr key={s.id}>
                    <td>{s.user.email}</td>
                    <td>{s.designation}</td>
                    <td>{s.user.campus?.name ?? '—'}</td>
                    <td>
                      {hasHr
                        ? <span className="row" style={{ gap: 6 }}><span className="badge ok">🎯 Granted</span><button className="ghost small" onClick={() => toggle(() => api.users.setHrAccess(s.user.id, false), `Recruitment access removed from ${s.user.email}`)}>Remove</button></span>
                        : <button className="small" onClick={() => toggle(() => api.users.setHrAccess(s.user.id, true), `Recruitment access granted to ${s.user.email}`)}>Grant</button>}
                    </td>
                    <td>
                      {hasCa
                        ? <span className="row" style={{ gap: 6 }}><span className="badge ok">🏫 Principal</span><button className="ghost small" onClick={() => toggle(() => api.users.setCampusAdmin(s.user.id, false), `Campus admin removed from ${s.user.email}`)}>Remove</button></span>
                        : <button className="small" onClick={() => toggle(() => api.users.setCampusAdmin(s.user.id, true), `${s.user.email} is now Campus Admin`)}>Make admin</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
