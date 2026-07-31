'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  api, apiGet, ApiError,
  type AcademicYear, type Campus, type Klass, type ManagedTeacher, type Section, type Subject,
  type TeacherApplicationSummary, type TeacherAssignment, type UserModule,
} from '@/lib/api';
import { useMe } from '@/lib/me-context';

type Msg = { ok: boolean; text: string } | null;
const today = () => new Date().toISOString().slice(0, 10);

const STAFF_TYPES = ['TEACHER', 'ADMIN', 'ACCOUNTANT', 'CLERK', 'SUPPORT'] as const;

/** Readable temporary password: no look-alike characters (0/O, 1/l/I) because this gets
 *  written on paper and read aloud. 14 chars clears the API's 10-character minimum. */
function generatePassword(): string {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const num = '23456789';
  const all = `${abc}${abc.toLowerCase()}${num}`;
  const pick = (set: string) => set[Math.floor(Math.random() * set.length)];
  const body = Array.from({ length: 11 }, () => pick(all)).join('');
  // Guarantee at least one of each class regardless of the random draw.
  return `${pick(abc)}${body}${pick(num)}!`;
}
// Common job titles for the "role" categorization (Principal, VP, Director, …). Free-text,
// so admins can also type their own; these just seed the picker.
const DESIGNATION_PRESETS = [
  'Principal', 'Vice Principal', 'Director', 'Coordinator', 'Head of Department',
  'Senior Teacher', 'Teacher', 'Accountant', 'Clerk', 'Librarian', 'Lab Assistant',
  'Receptionist', 'Support Staff',
];

/**
 * Staff directory (HR §13). The whole school's staff in one place, filterable by campus,
 * type/role (Principal, Director, …), and subject. Owner sees every campus; a campus admin
 * is scoped to their own (API-enforced). Adding a teacher also lets you assign subjects.
 */
export default function StaffPage() {
  const me = useMe();
  const isOwner = (me?.roles ?? []).includes('OWNER_ADMIN');

  const [staff, setStaff] = useState<ManagedTeacher[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [classes, setClasses] = useState<Klass[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [profiles, setProfiles] = useState<TeacherApplicationSummary[]>([]);
  const [msg, setMsg] = useState<Msg>(null);

  // Filters — the "categorize by" controls.
  const [fCampus, setFCampus] = useState('');
  const [fType, setFType] = useState('');
  const [fSubject, setFSubject] = useState('');
  const [fSearch, setFSearch] = useState('');
  const [addingStaff, setAddingStaff] = useState(false);
  // Credentials to hand over, shown once after a staff member is created with a login.
  const [newLogin, setNewLogin] = useState<{ name: string; email: string; password: string } | null>(null);

  const currentYear = years.find((y) => y.isCurrent) ?? null;

  async function load() {
    const [s, c, k, sec, y, a, p] = await Promise.all([
      api.staff.list(),
      apiGet<Campus[]>('/campuses'),
      apiGet<Klass[]>('/classes'),
      apiGet<Section[]>('/sections'),
      apiGet<AcademicYear[]>('/academic-years'),
      api.teacherAssignments.list(),
      api.teacherApplications.list().catch(() => [] as TeacherApplicationSummary[]),
    ]);
    setStaff(s); setCampuses(c); setClasses(k); setSections(sec); setYears(y); setAssignments(a); setProfiles(p);
    const subjArrays = await Promise.all(k.map((cls) => api.subjects.list(cls.id).catch(() => [] as Subject[])));
    setSubjects(subjArrays.flat());
  }
  useEffect(() => { load().catch(() => {}); }, []);

  async function run(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); await load(); setMsg({ ok: true, text: ok }); }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed' }); }
  }

  const myCampuses = isOwner ? campuses : campuses.filter((c) => c.id === me?.campusId);
  const assignmentsOf = (staffId: string) => assignments.filter((a) => a.staffId === staffId);
  // A teacher onboarded through the full-profile form has a matching application (same email),
  // which is what the per-row "Profile" link opens.
  const profileByEmail = useMemo(() => new Map(profiles.map((p) => [p.email.toLowerCase(), p])), [profiles]);

  // Apply the filters (campus / type / subject / free text), then group what remains by campus.
  const filtered = useMemo(() => {
    const q = fSearch.trim().toLowerCase();
    return staff.filter((t) => {
      if (fCampus && t.user.campusId !== fCampus) return false;
      if (fType && t.staffType !== fType) return false;
      if (fSubject && !assignmentsOf(t.id).some((a) => a.subjectId === fSubject)) return false;
      if (q && !`${t.fullName ?? ''} ${t.user.email} ${t.employeeCode} ${t.designation}`.toLowerCase().includes(q)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff, assignments, fCampus, fType, fSubject, fSearch]);

  const groups = myCampuses
    .map((c) => ({ id: c.id, name: c.name, items: filtered.filter((t) => t.user.campusId === c.id) }))
    .filter((g) => g.items.length > 0 || (!fCampus && !fType && !fSubject && !fSearch));

  const clearFilters = () => { setFCampus(''); setFType(''); setFSubject(''); setFSearch(''); };
  const anyFilter = fCampus || fType || fSubject || fSearch;

  return (
    <div className="stack">
      <div className="row">
        <h1>Staff</h1>
        <div className="row" style={{ gap: 8 }}>
          <button onClick={() => setAddingStaff((v) => !v)}>{addingStaff ? 'Close' : '+ Add teacher'}</button>
          <Link className="chip" href="/teachers">🧑‍🏫 Add teacher (full profile)</Link>
        </div>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Everyone who works at the school — the single directory of people. Add a staff member and
        give them a job title (Principal, Vice Principal, Director, Teacher …); filter by campus,
        type, or subject below.{isOwner && <> Logins and passwords are managed in <b>Campus Hub</b>.</>}
      </p>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {/* Shown once, right after creation — the password is never retrievable again. */}
      {newLogin && (
        <div className="card stack" style={{ borderColor: '#86efac', background: '#f0fdf4' }}>
          <div className="row">
            <strong>{newLogin.name} can sign in now</strong>
            <button className="ghost small" onClick={() => setNewLogin(null)}>Dismiss</button>
          </div>
          <div className="form-grid">
            <div className="f-half"><label>Email</label><input readOnly value={newLogin.email} onFocus={(e) => e.currentTarget.select()} /></div>
            <div className="f-half"><label>Temporary password</label><input readOnly value={newLogin.password} onFocus={(e) => e.currentTarget.select()} /></div>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            Copy these now — the password can&apos;t be shown again. Ask them to change it under 🔒 Security after their first sign-in.
          </p>
        </div>
      )}

      {addingStaff && (
        <AddStaff campuses={myCampuses} lockedCampus={isOwner ? null : (me?.campusId ?? null)}
          onCreate={async (b) => {
            try {
              const res = await api.staff.create(b);
              await load();
              setMsg({ ok: true, text: 'Staff member added' });
              setAddingStaff(false);
              if (res.loginActive && b.password) setNewLogin({ name: b.fullName ?? res.email, email: res.email, password: b.password });
            } catch (e) {
              setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed' });
            }
          }} />
      )}

      {/* Categorize-by filters */}
      <div className="inline-form">
        <div><label>Campus</label>
          <select value={fCampus} onChange={(e) => setFCampus(e.target.value)}>
            <option value="">All campuses</option>
            {myCampuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div><label>Type</label>
          <select value={fType} onChange={(e) => setFType(e.target.value)}>
            <option value="">All types</option>
            {STAFF_TYPES.map((t) => <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>)}
          </select>
        </div>
        <div><label>Subject</label>
          <select value={fSubject} onChange={(e) => setFSubject(e.target.value)}>
            <option value="">All subjects</option>
            {Array.from(new Map(subjects.map((s) => [s.name, s])).values()).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div style={{ minWidth: 200 }}><label>Search (email / code / title)</label>
          <input value={fSearch} onChange={(e) => setFSearch(e.target.value)} placeholder="e.g. Principal" />
        </div>
        {anyFilter && <button className="ghost" onClick={clearFilters}>Clear</button>}
      </div>

      {!currentYear && <div className="toast err">No current academic year — set one in Setup before assigning subjects.</div>}

      {groups.map((g) => (
        <div className="card stack" key={g.id}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{g.name} <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>({g.items.length})</span></h2>
          {g.items.length === 0 ? (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>No staff match here.</p>
          ) : g.items.map((t) => (
            <StaffRow key={t.id} member={t} isOwner={isOwner}
              profileId={profileByEmail.get(t.user.email.toLowerCase())?.id ?? null}
              assignments={assignmentsOf(t.id)}
              classes={classes.filter((k) => k.campusId === g.id)} sections={sections} subjects={subjects}
              currentYear={currentYear}
              onMsg={(ok, text) => setMsg({ ok, text })}
              reload={load}
              onAssign={(b) => run(() => api.teacherAssignments.create(b), 'Subject assigned')}
              onRemove={(id) => run(() => api.teacherAssignments.remove(id), 'Assignment removed')} />
          ))}
        </div>
      ))}
      {myCampuses.length === 0 && <p className="muted">{isOwner ? 'No campuses yet — add one in Campus Hub first.' : 'No campus is assigned to your account — contact the school owner.'}</p>}
    </div>
  );
}

/**
 * Capabilities toggled per person. ADMISSION_CONTROLLER is deliberately NOT here: a campus
 * has exactly one admission officer, which is a fact about the CAMPUS, not a permission on a
 * person — a per-person toggle can neither show you a campus with nobody nor express a
 * handover. It lives on the Admission Portal screen, and having it in both places would mean
 * two ways to enforce one rule.
 */
const CAPABILITIES = [
  { role: 'HR_MANAGER', label: 'HR Manager', hint: 'Recruitment' },
  { role: 'CAMPUS_ADMIN', label: 'Campus Admin', hint: 'Principal' },
  { role: 'ACCOUNTANT', label: 'Accountant', hint: 'Fees' },
];

function AccessPanel({ userId, roles, campusId, onMsg, onRolesChanged }: {
  userId: string; roles: string[]; campusId: string | null;
  onMsg: (ok: boolean, text: string) => void; onRolesChanged: () => Promise<void>;
}) {
  const [modules, setModules] = useState<UserModule[] | null>(null);
  const [busy, setBusy] = useState('');

  const loadModules = useCallback(async () => {
    try { setModules(await api.users.modules(userId)); } catch { setModules([]); }
  }, [userId]);
  useEffect(() => { loadModules(); }, [loadModules]);

  async function toggleRole(role: string, grant: boolean) {
    setBusy(role);
    try {
      await api.users.setAccess(userId, role, grant);
      onMsg(true, `${grant ? 'Granted' : 'Removed'} ${role.replace(/_/g, ' ').toLowerCase()}`);
      await onRolesChanged();
      await loadModules();
    } catch (e) {
      onMsg(false, e instanceof ApiError ? e.message : 'Failed to change access');
    } finally { setBusy(''); }
  }

  async function toggleModule(m: UserModule) {
    setBusy(m.key);
    try {
      await api.users.setModule(userId, m.key, !m.allowed);
      setModules((prev) => (prev ?? []).map((x) => (x.key === m.key ? { ...x, allowed: !m.allowed } : x)));
      onMsg(true, `${!m.allowed ? 'Enabled' : 'Disabled'} ${m.label}`);
    } catch (e) {
      onMsg(false, e instanceof ApiError ? e.message : 'Failed to change module');
    } finally { setBusy(''); }
  }

  const modulesByRole = new Map<string, UserModule[]>();
  for (const m of modules ?? []) {
    if (!modulesByRole.has(m.role)) modulesByRole.set(m.role, []);
    modulesByRole.get(m.role)!.push(m);
  }

  return (
    <div className="card stack" style={{ background: '#f9fafb', marginTop: 4 }}>
      <div>
        <strong style={{ fontSize: 14 }}>Access &amp; modules</strong>
        <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
          Toggle a capability on this person&apos;s existing login — no new credentials. Then switch individual modules off if needed.
          {' '}Admissions is set per campus on the <b>Admission Portal</b> screen.
        </p>
      </div>

      <div className="stack" style={{ gap: 8 }}>
        {CAPABILITIES.map((cap) => {
          const has = roles.includes(cap.role);
          const mods = modulesByRole.get(cap.role) ?? [];
          const noCampus = cap.role === 'CAMPUS_ADMIN' && !campusId;
          return (
            <div key={cap.role} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, background: '#fff' }}>
              <div className="row" style={{ alignItems: 'center' }}>
                <div>
                  <strong style={{ fontSize: 13 }}>{cap.label}</strong>
                  <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>{cap.hint}</span>
                  {has && <span className="badge ok" style={{ marginLeft: 8 }}>on</span>}
                </div>
                <button className={has ? 'ghost small' : 'small'} disabled={busy === cap.role || noCampus}
                  onClick={() => toggleRole(cap.role, !has)}>
                  {busy === cap.role ? '…' : has ? 'Remove' : noCampus ? 'Needs a campus' : 'Grant'}
                </button>
              </div>
              {has && mods.length > 0 && (
                <div className="stack" style={{ gap: 4, marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border)' }}>
                  {mods.map((m) => (
                    <div key={m.key} className="row" style={{ alignItems: 'center' }}>
                      <div>
                        <span style={{ fontSize: 13 }}>{m.label}</span>
                        <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{m.description}</span>
                      </div>
                      <button className={m.allowed ? 'ghost small' : 'small'} disabled={busy === m.key}
                        onClick={() => toggleModule(m)}>
                        {busy === m.key ? '…' : m.allowed ? 'On' : 'Off'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AddStaff({ campuses, lockedCampus, onCreate }: {
  campuses: Campus[]; lockedCampus: string | null;
  onCreate: (b: { email: string; staffType: string; fullName?: string; employeeCode: string; designation: string; joinedAt: string; campusId?: string; password?: string }) => void;
}) {
  const [f, setF] = useState<Record<string, string>>({
    joinedAt: today(), staffType: 'TEACHER', designation: 'Teacher', campusId: lockedCampus ?? '',
    password: generatePassword(),
  });
  // On by default: a teacher who cannot sign in is not much use, and the alternative is the
  // owner going to Campus Hub afterwards to set a password by hand.
  const [createLogin, setCreateLogin] = useState(true);
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const campusId = lockedCampus ?? f.campusId;
  const passwordOk = !createLogin || (f.password ?? '').length >= 10;
  const ready = f.fullName && f.email && f.employeeCode && f.designation && f.joinedAt && campusId && passwordOk;

  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>Add teacher</h2>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px,1fr))' }}>
        <div><label>Full name</label><input value={f.fullName ?? ''} onChange={(e) => set('fullName', e.target.value)} placeholder="Ayesha Khan" /></div>
        <div><label>Email</label><input type="email" value={f.email ?? ''} onChange={(e) => set('email', e.target.value)} placeholder="person@school.pk" /></div>
        <div><label>Employee code</label><input value={f.employeeCode ?? ''} onChange={(e) => set('employeeCode', e.target.value)} placeholder="EMP-001" /></div>
        <div><label>Title / designation</label>
          <input list="designations" value={f.designation ?? ''} onChange={(e) => set('designation', e.target.value)} placeholder="Principal" />
          <datalist id="designations">{DESIGNATION_PRESETS.map((d) => <option key={d} value={d} />)}</datalist>
        </div>
        {/* No type/role picker: this form adds a TEACHER. The job title above is what varies,
            and the login role follows the type — asking for both invited mismatched pairs. */}
        <div><label>Joined</label><input type="date" value={f.joinedAt ?? ''} onChange={(e) => set('joinedAt', e.target.value)} /></div>
        {!lockedCampus && (
          <div><label>Campus</label>
            <select value={f.campusId ?? ''} onChange={(e) => set('campusId', e.target.value)}>
              <option value="">Select…</option>
              {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
      </div>
      <div className="stack" style={{ gap: 8, padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0, fontSize: 14, color: 'var(--ink)' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={createLogin} onChange={(e) => setCreateLogin(e.target.checked)} />
          Create their login now — they can sign in straight away
        </label>
        {createLogin ? (
          <>
            <div className="inline-form">
              <div style={{ flex: 1, minWidth: 220 }}>
                <label>Temporary password</label>
                <input value={f.password ?? ''} onChange={(e) => set('password', e.target.value)} />
              </div>
              <button className="ghost" type="button" onClick={() => set('password', generatePassword())}>Generate</button>
            </div>
            {!passwordOk && <div className="field-error">Password must be at least 10 characters.</div>}
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              Give these to the teacher — they sign in at this school&apos;s address with their email and this password,
              then change it under 🔒 Security.
            </p>
          </>
        ) : (
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            The account will be created but cannot sign in until an owner sets a password in <b>Campus Hub</b>.
          </p>
        )}
      </div>

      <div>
        <button disabled={!ready}
          onClick={() => onCreate({
            email: f.email, staffType: f.staffType, fullName: f.fullName, employeeCode: f.employeeCode,
            designation: f.designation, joinedAt: f.joinedAt, campusId,
            ...(createLogin ? { password: f.password } : {}),
          })}>
          Add teacher
        </button>
        <span className="muted" style={{ marginLeft: 10, fontSize: 12 }}>Assign their classes and subjects from the list below once added.</span>
      </div>
    </div>
  );
}

function StaffRow({ member, isOwner, profileId, assignments, classes, sections, subjects, currentYear, onMsg, reload, onAssign, onRemove }: {
  member: ManagedTeacher; isOwner: boolean; profileId: string | null; assignments: TeacherAssignment[]; classes: Klass[]; sections: Section[]; subjects: Subject[];
  currentYear: AcademicYear | null;
  onMsg: (ok: boolean, text: string) => void;
  reload: () => Promise<void>;
  onAssign: (b: { staffId: string; academicYearId: string; sectionId: string; subjectId?: string }) => void;
  onRemove: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [classId, setClassId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const isTeacher = member.staffType === 'TEACHER';

  const sectionName = (id: string) => {
    const s = sections.find((x) => x.id === id);
    const k = s && classes.find((c) => c.id === s.classId);
    return s ? `${k?.name ?? '?'}-${s.name}` : '?';
  };
  const subjectName = (id: string | null) => (id ? subjects.find((s) => s.id === id)?.name ?? 'Subject' : 'Class teacher');
  const classSections = sections.filter((s) => s.classId === classId);
  const classSubjects = subjects.filter((s) => s.classId === classId);

  function assign() {
    if (!currentYear || !sectionId) return;
    onAssign({ staffId: member.id, academicYearId: currentYear.id, sectionId, subjectId: subjectId || undefined });
    setOpen(false); setClassId(''); setSectionId(''); setSubjectId('');
  }

  return (
    <div className="stack" style={{ gap: 8, padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8 }}>
      <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        {/* Lead with the person's name — a staff directory keyed on email reads like a mailing list. */}
        <strong>{member.fullName ?? member.user.email}</strong>
        <span className="muted" style={{ fontSize: 13 }}>
          {member.designation} · {member.employeeCode}{member.fullName && ` · ${member.user.email}`}
        </span>
        <span className="badge">{member.staffType.charAt(0) + member.staffType.slice(1).toLowerCase()}</span>
        <span className={`badge ${member.user.status === 'ACTIVE' ? 'ok' : member.user.status === 'INVITED' ? 'warn' : 'bad'}`}>{member.user.status}</span>
        <div className="row" style={{ gap: 8, marginLeft: 'auto' }}>
          {profileId && (
            <Link className="ghost small" href={`/teachers?id=${profileId}`} style={{ textDecoration: 'none' }}>Profile</Link>
          )}
          {isOwner && (
            <button className="ghost small" onClick={() => setAccessOpen((v) => !v)}>
              {accessOpen ? 'Close access' : '⚙ Manage access'}
            </button>
          )}
          {isTeacher && (
            <button className="ghost small" onClick={() => setOpen((v) => !v)} disabled={!currentYear}>
              {open ? 'Close' : '+ Assign subject'}
            </button>
          )}
        </div>
      </div>

      {accessOpen && isOwner && (
        <AccessPanel userId={member.user.id} roles={member.user.roles} campusId={member.user.campusId}
          onMsg={onMsg} onRolesChanged={reload} />
      )}

      {isTeacher && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {assignments.length === 0 && <span className="muted" style={{ fontSize: 12 }}>No subjects assigned yet.</span>}
          {assignments.map((a) => (
            <span key={a.id} className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {subjectName(a.subjectId)} · {sectionName(a.sectionId)}
              <button onClick={() => onRemove(a.id)} title="Remove" style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#991b1b', padding: 0, lineHeight: 1 }}>✕</button>
            </span>
          ))}
        </div>
      )}

      {open && isTeacher && (
        <div className="inline-form" style={{ marginTop: 4 }}>
          <div><label>Class</label>
            <select value={classId} onChange={(e) => { setClassId(e.target.value); setSectionId(''); setSubjectId(''); }}>
              <option value="">Select…</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div><label>Section</label>
            <select value={sectionId} onChange={(e) => setSectionId(e.target.value)} disabled={!classId}>
              <option value="">Select…</option>
              {classSections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div><label>Subject</label>
            <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)} disabled={!classId}>
              <option value="">Class teacher (no subject)</option>
              {classSubjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <button disabled={!sectionId} onClick={assign}>Assign</button>
        </div>
      )}
    </div>
  );
}
