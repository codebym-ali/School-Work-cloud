'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  api, apiGet, ApiError,
  type Campus, type ManagedTeacher, type RecruitmentSummary, type TeacherApplicationSummary, type Vacancy,
} from '@/lib/api';
import { hasModule, useMe } from '@/lib/me-context';

type Msg = { ok: boolean; text: string } | null;
const EMPLOYMENT = [
  { v: 'FULL_TIME', label: 'Full-time' },
  { v: 'PART_TIME', label: 'Part-time' },
  { v: 'CONTRACT', label: 'Contract' },
];
const STATUSES = ['OPEN', 'ON_HOLD', 'CLOSED'];
const PIPELINE: { key: string; label: string }[] = [
  { key: 'SUBMITTED', label: 'New applications' },
  { key: 'SHORTLISTED', label: 'Shortlisted' },
  { key: 'HIRED', label: 'Hired' },
  { key: 'REJECTED', label: 'Rejected' },
];
const empLabel = (v: string) => EMPLOYMENT.find((e) => e.v === v)?.label ?? v;
const title = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace('_', ' ');

export default function RecruitmentPage() {
  const me = useMe();
  const isOwner = (me?.roles ?? []).includes('OWNER_ADMIN');
  const canVacancies = hasModule(me, 'recruitment.vacancies');
  const canApplications = hasModule(me, 'recruitment.applications');
  const canHire = hasModule(me, 'recruitment.hire');

  const [summary, setSummary] = useState<RecruitmentSummary | null>(null);
  const [vacancies, setVacancies] = useState<Vacancy[]>([]);
  const [applications, setApplications] = useState<TeacherApplicationSummary[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [fStatus, setFStatus] = useState('');
  const [adding, setAdding] = useState(false);
  const [managingAccess, setManagingAccess] = useState(false);
  const [hiring, setHiring] = useState<TeacherApplicationSummary | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [s, v, a, c] = await Promise.all([
        api.vacancies.summary(),
        api.vacancies.list(fStatus ? { status: fStatus } : undefined),
        api.teacherApplications.list(),
        apiGet<Campus[]>('/campuses'),
      ]);
      setSummary(s);
      setVacancies(v);
      setApplications(a);
      setCampuses(c);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', 'Failed to load recruitment'));
    } finally {
      setLoading(false);
    }
  }, [fStatus]);
  useEffect(() => { load().catch(() => {}); }, [load]);

  const myCampuses = isOwner ? campuses : campuses.filter((c) => c.id === me?.campusId);

  async function closeVacancy(v: Vacancy) {
    if (!window.confirm(`Close the vacancy "${v.title}"? It will stop accepting applications.`)) return;
    try {
      await api.vacancies.close(v.id);
      setMsg({ ok: true, text: `Closed "${v.title}"` });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to close vacancy' });
    }
  }

  async function setStatus(a: TeacherApplicationSummary, status: 'SHORTLISTED' | 'REJECTED') {
    try {
      await api.teacherApplications.updateStatus(a.id, status);
      setMsg({ ok: true, text: `${a.fullName} → ${title(status)}` });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to update application' });
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <h1>Recruitment</h1>
        <div className="row" style={{ gap: 8 }}>
          {isOwner && <button className="ghost" onClick={() => setManagingAccess((v) => !v)}>{managingAccess ? 'Close access' : 'Manage access'}</button>}
          {canVacancies && <button onClick={() => setAdding((v) => !v)}>{adding ? 'Close' : '+ Post vacancy'}</button>}
        </div>
      </div>
      <p className="muted" style={{ margin: 0 }}>Hire teachers end-to-end: post a vacancy, review applicants, shortlist, and hire — which creates their staff login.</p>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {summary && (
        <div className="grid">
          <div className="metric"><div className="value">{summary.openVacancies}</div><div className="label">Open vacancies</div></div>
          <div className="metric"><div className="value">{summary.openPositions}</div><div className="label">Open positions</div></div>
          <div className="metric"><div className="value">{summary.applicationsByStatus.SUBMITTED ?? 0}</div><div className="label">New applications</div></div>
          <div className="metric"><div className="value">{summary.applicationsByStatus.SHORTLISTED ?? 0}</div><div className="label">Shortlisted</div></div>
          <div className="metric"><div className="value">{summary.newApplicationsThisWeek}</div><div className="label">New this week</div></div>
          <div className="metric"><div className="value">{summary.hiredThisMonth}</div><div className="label">Hired this month</div></div>
        </div>
      )}

      {isOwner && managingAccess && <AccessManager onMsg={(ok, text) => setMsg({ ok, text })} />}

      {adding && (
        <PostVacancy campuses={myCampuses} lockedCampus={isOwner ? null : (me?.campusId ?? null)}
          onDone={async (ok, text) => { setMsg({ ok, text }); if (ok) { setAdding(false); await load(); } }} />
      )}

      {hiring && (
        <HireModal application={hiring} onClose={() => setHiring(null)}
          onDone={async (ok, text) => { setMsg({ ok, text }); if (ok) { setHiring(null); await load(); } }} />
      )}

      <div className="card stack">
        <h2 style={{ margin: 0, fontSize: 17 }}>Applicant pipeline</h2>
        {loading ? (
          <p className="muted" style={{ margin: 0 }}>Loading applicants…</p>
        ) : applications.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No applications yet. Add a teacher from the <b>Staff</b> screen (“Add teacher”); they appear here to shortlist and hire.</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px,1fr))', gap: 12 }}>
            {PIPELINE.map((col) => {
              const items = applications.filter((a) => a.status === col.key);
              return (
                <div key={col.key} style={{ background: '#f9fafb', border: '1px solid var(--border)', borderRadius: 10, padding: 10 }}>
                  <div className="row" style={{ marginBottom: 8 }}>
                    <strong style={{ fontSize: 13 }}>{col.label}</strong>
                    <span className="badge">{items.length}</span>
                  </div>
                  <div className="stack" style={{ gap: 8 }}>
                    {items.map((a) => (
                      <div key={a.id} className="card" style={{ padding: 10 }}>
                        <div style={{ fontWeight: 600 }}>{a.fullName}</div>
                        <div className="muted" style={{ fontSize: 12 }}>{a.positionAppliedFor} · {a.department}</div>
                        <div className="muted" style={{ fontSize: 12 }}>{empLabel(a.employmentType)}{a.campusName ? ` · ${a.campusName}` : ''}</div>
                        {(col.key === 'SUBMITTED' || col.key === 'SHORTLISTED') && (canApplications || canHire) && (
                          <div className="row" style={{ gap: 6, marginTop: 8, justifyContent: 'flex-start', flexWrap: 'wrap' }}>
                            {col.key === 'SUBMITTED' && canApplications && <button className="small" onClick={() => setStatus(a, 'SHORTLISTED')}>Shortlist</button>}
                            {canHire && <button className="small" onClick={() => setHiring(a)}>Hire</button>}
                            {canApplications && <button className="ghost small" onClick={() => setStatus(a, 'REJECTED')}>Reject</button>}
                          </div>
                        )}
                      </div>
                    ))}
                    {items.length === 0 && <p className="muted" style={{ margin: 0, fontSize: 12 }}>None</p>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card stack">
        <div className="row">
          <h2 style={{ margin: 0, fontSize: 17 }}>Vacancies</h2>
          <div className="inline-form" style={{ margin: 0 }}>
            <div><label>Status</label>
              <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
                <option value="">All statuses</option>
                {STATUSES.map((s) => <option key={s} value={s}>{title(s)}</option>)}
              </select>
            </div>
          </div>
        </div>
        {loading ? (
          <p className="muted" style={{ margin: 0 }}>Loading vacancies…</p>
        ) : loadError ? (
          <div className="stack">
            <div className="toast err">{loadError.message}</div>
            {loadError.requestId && <p className="muted" style={{ margin: 0, fontSize: 12 }}>Request ID: <code>{loadError.requestId}</code></p>}
            <div><button className="ghost" onClick={() => load()}>Retry</button></div>
          </div>
        ) : vacancies.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{fStatus ? 'No vacancies with this status.' : 'No vacancies yet.'}</p>
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
    </div>
  );
}

function HireModal({ application, onClose, onDone }: {
  application: TeacherApplicationSummary; onClose: () => void; onDone: (ok: boolean, text: string) => void;
}) {
  const [f, setF] = useState<Record<string, string>>({
    employeeCode: '', designation: application.positionAppliedFor, joinedAt: new Date().toISOString().slice(0, 10), staffType: 'TEACHER',
  });
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const [busy, setBusy] = useState(false);
  const [fieldIssues, setFieldIssues] = useState<string[]>([]);

  async function submit() {
    setBusy(true);
    setFieldIssues([]);
    try {
      await api.teacherApplications.hire(application.id, {
        employeeCode: f.employeeCode.trim(),
        designation: f.designation.trim() || undefined,
        joinedAt: f.joinedAt || undefined,
        staffType: f.staffType || undefined,
      });
      onDone(true, `Hired ${application.fullName} — staff login created`);
    } catch (e) {
      if (e instanceof ApiError && e.fieldIssues.length) setFieldIssues(e.fieldIssues);
      onDone(false, e instanceof ApiError ? e.message : 'Failed to hire applicant');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0, fontSize: 17 }}>Hire {application.fullName}</h2>
        <button className="ghost small" onClick={onClose}>Cancel</button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>Creates a staff record + login (invited) for {application.email} and marks the application hired.</p>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px,1fr))' }}>
        <div><label>Employee code</label><input value={f.employeeCode} onChange={(e) => set('employeeCode', e.target.value)} placeholder="EMP-001" /></div>
        <div><label>Designation</label><input value={f.designation} onChange={(e) => set('designation', e.target.value)} /></div>
        <div><label>Joining date</label><input type="date" value={f.joinedAt} onChange={(e) => set('joinedAt', e.target.value)} /></div>
        <div><label>Staff type</label>
          <select value={f.staffType} onChange={(e) => set('staffType', e.target.value)}>
            <option value="TEACHER">Teacher</option>
            <option value="ADMIN">Admin</option>
            <option value="SUPPORT">Support</option>
          </select>
        </div>
      </div>
      {fieldIssues.length > 0 && (
        <ul className="toast err" style={{ margin: 0, paddingLeft: 22 }}>{fieldIssues.map((i, n) => <li key={n}>{i}</li>)}</ul>
      )}
      <div><button disabled={!f.employeeCode.trim() || busy} onClick={submit}>{busy ? 'Hiring…' : 'Confirm hire'}</button></div>
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
        <ul className="toast err" style={{ margin: 0, paddingLeft: 22 }}>{fieldIssues.map((i, n) => <li key={n}>{i}</li>)}</ul>
      )}
      <div><button disabled={!ready || busy} onClick={submit}>{busy ? 'Posting…' : 'Post vacancy'}</button></div>
    </div>
  );
}

function AccessManager({ onMsg }: { onMsg: (ok: boolean, text: string) => void }) {
  const [staff, setStaff] = useState<ManagedTeacher[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setStaff(await api.staff.list()); }
    catch (e) { onMsg(false, e instanceof ApiError ? e.message : 'Failed to load staff'); }
    finally { setLoading(false); }
  }, [onMsg]);
  useEffect(() => { load().catch(() => {}); }, [load]);

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
                        ? <span className="row" style={{ gap: 6 }}><span className="badge ok">Granted</span><button className="ghost small" onClick={() => toggle(() => api.users.setHrAccess(s.user.id, false), `Recruitment access removed from ${s.user.email}`)}>Remove</button></span>
                        : <button className="small" onClick={() => toggle(() => api.users.setHrAccess(s.user.id, true), `Recruitment access granted to ${s.user.email}`)}>Grant</button>}
                    </td>
                    <td>
                      {hasCa
                        ? <span className="row" style={{ gap: 6 }}><span className="badge ok">Principal</span><button className="ghost small" onClick={() => toggle(() => api.users.setCampusAdmin(s.user.id, false), `Campus admin removed from ${s.user.email}`)}>Remove</button></span>
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
