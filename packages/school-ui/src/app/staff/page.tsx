'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  api, apiGet, ApiError,
  type AcademicYear, type Campus, type Klass, type ManagedTeacher, type Section, type Subject,
  type HrSummary, type TeacherAssignment, type UserModule,
} from '@sw/api-client';
import { useMe } from '@sw/session';
import { Metric, MetricFilter } from '@sw/ui';
import { useCampusLens } from '@sw/session';

type Msg = { ok: boolean; text: string } | null;
const today = () => new Date().toISOString().slice(0, 10);

const STAFF_TYPES = ['TEACHER', 'ADMIN', 'ACCOUNTANT', 'CLERK', 'SUPPORT'] as const;

/** Which worklist the directory is narrowed to. '' = the whole directory. */
type StaffFocus = '' | 'setup';

/**
 * What makes owning the staff record a job rather than data entry.
 *
 * Filling a form is not work anyone needs a dedicated role for — the work is everything still
 * wrong afterwards: people who cannot sign in, teachers assigned to nothing, and subjects with
 * nobody teaching them. Each block below is a worklist with a finish line, not a vanity metric.
 */
function HrOverview({ summary, focus, setFocus, anyFilter, clearFilters }: {
  summary: HrSummary | null;
  focus: StaffFocus; setFocus: (f: StaffFocus) => void;
  anyFilter: boolean; clearFilters: () => void;
}) {
  if (!summary) return null;
  const { headcount, joinersThisMonth, joinersThisYear, needsSetup, coverageGaps } = summary;

  return (
    <div className="stack">
      <div className="grid">
        {/* Clears every filter — the number means "everyone", so clicking it should show everyone. */}
        <MetricFilter label="Staff on record" value={headcount} active={!anyFilter && focus === ''}
          title="Show everyone" onClick={clearFilters} />

        {/* ⚠️ Context, NOT filters, and deliberately so. These counts are computed on the server
            from `joinedAt >= monthStart`, where `monthStart` is built from the SERVER's local
            clock — `new Date(now.getFullYear(), now.getMonth(), 1)` — and the server never asks
            the school's timezone. A client-side filter would use the BROWSER's month boundary, so
            the tile and the list would disagree for any school not sharing the server's zone.
            That is exactly the "Present tile counted late arrivals, PRESENT filter did not" defect
            these components were extracted to prevent, so these stay unclickable until the summary
            returns the ids behind the count. Filed — the timezone half is a G4 violation. */}
        <Metric label="Joined this month" value={joinersThisMonth} />
        <Metric label="Joined this year" value={joinersThisYear} />

        {/* Safe to filter: the summary returns the staffIds, so the tile and the list are the same
            set by construction rather than by two agreeing definitions. */}
        <MetricFilter label="Setup unfinished" value={needsSetup.length} alert={needsSetup.length > 0}
          active={focus === 'setup'} title="Show only these people"
          onClick={() => setFocus(focus === 'setup' ? '' : 'setup')} />
      </div>

      {needsSetup.length > 0 && (
        <div className="card stack" style={{ gap: 8 }}>
          <div className="row">
            <strong style={{ fontSize: 14 }}>⚠ Finish setting these people up</strong>
            <span className="badge warn">{needsSetup.length}</span>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            A record on its own isn&apos;t enough — until these are done the person cannot sign in
            or has nothing to teach.
          </p>
          <div className="chips">
            {needsSetup.map((p) => (
              <span key={p.staffId} className="badge warn" title={p.email}>
                {p.fullName ?? p.email} — {p.reason}
              </span>
            ))}
          </div>
        </div>
      )}

      {coverageGaps.length > 0 && (
        <div className="card stack" style={{ gap: 8 }}>
          <div className="row">
            <strong style={{ fontSize: 14 }}>📌 Subjects with no teacher</strong>
            <span className="badge warn">{coverageGaps.length}</span>
          </div>
          {/* This replaces the old vacancy board. It is derived from the real class structure,
              so it cannot go stale — nobody has to remember to post or close anything. */}
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            Worked out from your classes and sections, so it&apos;s always current. Assign a teacher
            on the class page, or hire someone for the gap.
          </p>
          <div className="chips">
            {coverageGaps.slice(0, 40).map((g) => (
              <Link key={`${g.sectionId}:${g.subjectId}`} className="chip" href={`/classes/${g.classId}`}>
                {g.className} {g.sectionName} · {g.subjectName}
              </Link>
            ))}
            {coverageGaps.length > 40 && (
              <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>
                +{coverageGaps.length - 40} more
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

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
  const lens = useCampusLens();

  const [staff, setStaff] = useState<ManagedTeacher[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [classes, setClasses] = useState<Klass[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [summary, setSummary] = useState<HrSummary | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  // Filters — the "categorize by" controls.
  const [fType, setFType] = useState('');
  const [fSubject, setFSubject] = useState('');
  const [fSearch, setFSearch] = useState('');
  const [fFocus, setFFocus] = useState<StaffFocus>('');
  const [addingStaff, setAddingStaff] = useState(false);
  // Credentials to hand over, shown once after a staff member is created with a login.
  const [newLogin, setNewLogin] = useState<{ name: string; email: string; password: string } | null>(null);

  const currentYear = years.find((y) => y.isCurrent) ?? null;

  async function load() {
    const [s, c, k, sec, y, a] = await Promise.all([
      api.staff.list(),
      apiGet<Campus[]>('/campuses'),
      apiGet<Klass[]>('/classes'),
      apiGet<Section[]>('/sections'),
      apiGet<AcademicYear[]>('/academic-years'),
      api.teacherAssignments.list(),
    ]);
    api.hr.summary().then(setSummary).catch(() => setSummary(null));
    setStaff(s); setCampuses(c); setClasses(k); setSections(sec); setYears(y); setAssignments(a);
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

  // Apply the filters (campus / type / subject / free text / worklist), then group by campus.
  //
  // ⚠️ The worklist filter matches on the IDS THE SERVER SENT, not on a re-derivation of "who needs
  // setup". The server decides that from `user.status === 'INVITED'` and an empty assignment list;
  // re-deciding it here would be a second implementation of one rule, free to disagree with the
  // number on the tile above it.
  const setupIds = useMemo(
    () => new Set((summary?.needsSetup ?? []).map((p) => p.staffId)),
    [summary],
  );
  const filtered = useMemo(() => {
    const q = fSearch.trim().toLowerCase();
    return staff.filter((t) => {
      if (fFocus === 'setup' && !setupIds.has(t.id)) return false;
      if (lens.campusId && t.user.campusId !== lens.campusId) return false;
      if (fType && t.staffType !== fType) return false;
      if (fSubject && !assignmentsOf(t.id).some((a) => a.subjectId === fSubject)) return false;
      if (q && !`${t.fullName ?? ''} ${t.user.email} ${t.employeeCode} ${t.designation}`.toLowerCase().includes(q)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff, assignments, lens.campusId, fType, fSubject, fSearch, fFocus, setupIds]);

  // The lens decides which campuses appear as headers; the local filters decide who is inside them.
  const shownCampuses = lens.campusId ? myCampuses.filter((c) => c.id === lens.campusId) : myCampuses;
  const groups = shownCampuses
    .map((c) => ({ id: c.id, name: c.name, items: filtered.filter((t) => t.user.campusId === c.id) }))
    .filter((g) => g.items.length > 0 || (!fType && !fSubject && !fSearch && !fFocus));

  const clearFilters = () => { setFType(''); setFSubject(''); setFSearch(''); setFFocus(''); };
  const anyFilter = Boolean(fType || fSubject || fSearch || fFocus);

  return (
    <div className="stack">
      <div className="row">
        <h1>Staff</h1>
        <div className="row" style={{ gap: 8 }}>
          <button onClick={() => setAddingStaff((v) => !v)}>{addingStaff ? 'Close' : '+ Add teacher'}</button>
        </div>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Everyone who works at the school — the single directory of people. Add a staff member and
        give them a job title (Principal, Vice Principal, Director, Teacher …); filter by campus,
        type, or subject below.{isOwner && <> Logins and passwords are managed in <b>Campus Hub</b>.</>}
      </p>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <HrOverview
        summary={summary}
        focus={fFocus}
        setFocus={setFFocus}
        anyFilter={anyFilter}
        clearFilters={clearFilters}
      />


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

      {/* Categorize-by filters. Campus is not here any more — it lives in the shell lens, so a
          director sets the branch once and every oversight screen follows. */}
      <div className="inline-form">
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
        {/* The owner's deputy. Distinct, weightier card because it is a near-owner grant — and
            owner-only: the backend grant-ceiling refuses this toggle for anyone but the owner. */}
        {(() => {
          const has = roles.includes('OPERATIONS_ADMIN');
          return (
            <div style={{ border: '1px solid var(--accent, #a1741c)', borderRadius: 8, padding: 10, background: '#fffdf7' }}>
              <div className="row" style={{ alignItems: 'center' }}>
                <div>
                  <strong style={{ fontSize: 13 }}>Ops Admin</strong>
                  <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>Deputy — runs the school on your behalf</span>
                  {has && <span className="badge ok" style={{ marginLeft: 8 }}>on</span>}
                </div>
                <button className={has ? 'ghost small' : 'small'} disabled={busy === 'OPERATIONS_ADMIN'}
                  onClick={() => toggleRole('OPERATIONS_ADMIN', !has)}>
                  {busy === 'OPERATIONS_ADMIN' ? '…' : has ? 'Remove' : 'Appoint'}
                </button>
              </div>
              <p className="muted" style={{ margin: '6px 0 0', fontSize: 11 }}>
                A school-wide deputy: manages staff, admissions, fees, attendance and campus settings on your
                behalf. Cannot appoint another Ops Admin, remove staff, or change owner-only settings. Signs in
                with two-factor.
              </p>
            </div>
          );
        })()}
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

function StaffRow({ member, isOwner, assignments, classes, sections, subjects, currentYear, onMsg, reload, onAssign, onRemove }: {
  member: ManagedTeacher; isOwner: boolean; assignments: TeacherAssignment[]; classes: Klass[]; sections: Section[]; subjects: Subject[];
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
