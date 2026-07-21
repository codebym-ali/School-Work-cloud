'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  api, apiGet, ApiError,
  type AcademicYear, type Campus, type Klass, type ManagedTeacher, type Section, type Subject, type TeacherAssignment,
} from '@/lib/api';
import { useMe } from '@/lib/me-context';

type Msg = { ok: boolean; text: string } | null;
const today = () => new Date().toISOString().slice(0, 10);

const STAFF_TYPES = ['TEACHER', 'ADMIN', 'ACCOUNTANT', 'CLERK', 'SUPPORT'] as const;
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
  const [msg, setMsg] = useState<Msg>(null);

  // Filters — the "categorize by" controls.
  const [fCampus, setFCampus] = useState('');
  const [fType, setFType] = useState('');
  const [fSubject, setFSubject] = useState('');
  const [fSearch, setFSearch] = useState('');

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

  // Apply the filters (campus / type / subject / free text), then group what remains by campus.
  const filtered = useMemo(() => {
    const q = fSearch.trim().toLowerCase();
    return staff.filter((t) => {
      if (fCampus && t.user.campusId !== fCampus) return false;
      if (fType && t.staffType !== fType) return false;
      if (fSubject && !assignmentsOf(t.id).some((a) => a.subjectId === fSubject)) return false;
      if (q && !`${t.user.email} ${t.employeeCode} ${t.designation}`.toLowerCase().includes(q)) return false;
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
      <h1>Staff</h1>
      <p className="muted" style={{ margin: 0 }}>
        Everyone who works at the school. Add a staff member and give them a job title
        (Principal, Vice Principal, Director, Teacher …); filter by campus, type, or subject below.
      </p>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <AddStaff campuses={myCampuses} lockedCampus={isOwner ? null : (me?.campusId ?? null)}
        onCreate={(b) => run(() => api.staff.create(b), 'Staff member added')} />

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
            <StaffRow key={t.id} member={t}
              assignments={assignmentsOf(t.id)}
              classes={classes.filter((k) => k.campusId === g.id)} sections={sections} subjects={subjects}
              currentYear={currentYear}
              onAssign={(b) => run(() => api.teacherAssignments.create(b), 'Subject assigned')}
              onRemove={(id) => run(() => api.teacherAssignments.remove(id), 'Assignment removed')} />
          ))}
        </div>
      ))}
      {myCampuses.length === 0 && <p className="muted">No campuses yet — add one in Campus Hub first.</p>}
    </div>
  );
}

function AddStaff({ campuses, lockedCampus, onCreate }: {
  campuses: Campus[]; lockedCampus: string | null;
  onCreate: (b: { email: string; staffType: string; employeeCode: string; designation: string; joinedAt: string; campusId?: string }) => void;
}) {
  const [f, setF] = useState<Record<string, string>>({ joinedAt: today(), staffType: 'TEACHER', designation: 'Teacher', campusId: lockedCampus ?? '' });
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const campusId = lockedCampus ?? f.campusId;
  const ready = f.email && f.employeeCode && f.designation && f.joinedAt && f.staffType && campusId;

  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>Add staff member</h2>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px,1fr))' }}>
        <div><label>Email</label><input type="email" value={f.email ?? ''} onChange={(e) => set('email', e.target.value)} placeholder="person@school.pk" /></div>
        <div><label>Employee code</label><input value={f.employeeCode ?? ''} onChange={(e) => set('employeeCode', e.target.value)} placeholder="EMP-001" /></div>
        <div><label>Title / designation</label>
          <input list="designations" value={f.designation ?? ''} onChange={(e) => set('designation', e.target.value)} placeholder="Principal" />
          <datalist id="designations">{DESIGNATION_PRESETS.map((d) => <option key={d} value={d} />)}</datalist>
        </div>
        <div><label>Type</label>
          <select value={f.staffType} onChange={(e) => set('staffType', e.target.value)}>
            {STAFF_TYPES.map((t) => <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>)}
          </select>
        </div>
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
      <div>
        <button disabled={!ready}
          onClick={() => onCreate({ email: f.email, staffType: f.staffType, employeeCode: f.employeeCode, designation: f.designation, joinedAt: f.joinedAt, campusId })}>
          Add staff member
        </button>
        <span className="muted" style={{ marginLeft: 10, fontSize: 12 }}>Invited by email — they set their own password. Login access follows the type.</span>
      </div>
    </div>
  );
}

function StaffRow({ member, assignments, classes, sections, subjects, currentYear, onAssign, onRemove }: {
  member: ManagedTeacher; assignments: TeacherAssignment[]; classes: Klass[]; sections: Section[]; subjects: Subject[];
  currentYear: AcademicYear | null;
  onAssign: (b: { staffId: string; academicYearId: string; sectionId: string; subjectId?: string }) => void;
  onRemove: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
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
        <strong>{member.designation}</strong>
        <span className="muted" style={{ fontSize: 13 }}>{member.user.email} · {member.employeeCode}</span>
        <span className="badge">{member.staffType.charAt(0) + member.staffType.slice(1).toLowerCase()}</span>
        <span className={`badge ${member.user.status === 'ACTIVE' ? 'ok' : member.user.status === 'INVITED' ? 'warn' : 'bad'}`}>{member.user.status}</span>
        {isTeacher && (
          <button className="ghost small" style={{ marginLeft: 'auto' }} onClick={() => setOpen((v) => !v)} disabled={!currentYear}>
            {open ? 'Close' : '+ Assign subject'}
          </button>
        )}
      </div>

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
