'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  api, apiGet, ApiError,
  type Campus, type CreateTeacherApplicationBody, type ManagedTeacher,
  type TeacherApplicationDetail, type TeacherApplicationSummary, type TeacherExperience,
} from '@/lib/api';
import { useMe } from '@/lib/me-context';

type Msg = { ok: boolean; text: string } | null;
const EMP = [{ v: 'FULL_TIME', l: 'Full-time' }, { v: 'PART_TIME', l: 'Part-time' }, { v: 'VISITING', l: 'Visiting' }];
const empLabel = (v: string) => EMP.find((e) => e.v === v)?.l ?? v;
const opt = (v?: string) => (v && v.trim() ? v.trim() : undefined);

/**
 * Teachers (HR). A whole-school directory — every teacher, grouped by campus, sourced
 * from the real staff/login records (so it always matches who can actually log in and
 * teach), not a separate application queue. "Add teacher" still captures the full
 * onboarding profile (personal/contact/education/experience/skills); on submit it creates
 * both the real staff record (so the teacher appears here immediately) and the detailed
 * profile (best-effort — a profile-save failure doesn't undo the real account).
 */
export default function TeachersPage() {
  const me = useMe();
  const isOwner = (me?.roles ?? []).includes('OWNER_ADMIN');

  const [teachers, setTeachers] = useState<ManagedTeacher[]>([]);
  const [profiles, setProfiles] = useState<TeacherApplicationSummary[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [fCampus, setFCampus] = useState('');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [detail, setDetail] = useState<{ applicationId: string | null; fallback?: ManagedTeacher } | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  async function load() {
    setLoading(true); setLoadError(null);
    try {
      const [staff, apps, c] = await Promise.all([
        api.staff.list(),
        api.teacherApplications.list().catch(() => [] as TeacherApplicationSummary[]),
        apiGet<Campus[]>('/campuses'),
      ]);
      setTeachers(staff.filter((s) => s.staffType === 'TEACHER'));
      setProfiles(apps);
      setCampuses(c);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', 'Failed to load'));
    } finally { setLoading(false); }
  }
  useEffect(() => { load().catch(() => {}); }, []);

  const myCampuses = isOwner ? campuses : campuses.filter((c) => c.id === me?.campusId);
  // A teacher added through this page's form has a matching application (same email) — used
  // to show the rich onboarding profile on "View"; teachers added via Staff simply won't have one.
  const profileByEmail = useMemo(() => new Map(profiles.map((p) => [p.email.toLowerCase(), p])), [profiles]);

  const q = search.trim().toLowerCase();
  const filtered = teachers.filter((t) => {
    if (fCampus && t.user.campusId !== fCampus) return false;
    if (q && !`${t.user.email} ${t.employeeCode} ${t.designation}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const groups = myCampuses
    .map((c) => ({ id: c.id, name: c.name, items: filtered.filter((t) => t.user.campusId === c.id) }))
    .filter((g) => g.items.length > 0 || (!fCampus && !q));

  if (detail) {
    return detail.applicationId
      ? <TeacherDetail id={detail.applicationId} onBack={() => setDetail(null)} />
      : <TeacherFallbackDetail teacher={detail.fallback!} onBack={() => setDetail(null)} />;
  }

  return (
    <div className="stack">
      <div className="row">
        <h1>Teachers</h1>
        <button onClick={() => setAdding((v) => !v)}>{adding ? 'Close' : '+ Add teacher'}</button>
      </div>
      <p className="muted" style={{ margin: 0 }}>Every teacher across the school, grouped by campus.</p>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {adding && (
        <AddTeacherForm campuses={myCampuses} lockedCampus={isOwner ? null : (me?.campusId ?? null)}
          onDone={async (ok, text) => { setMsg({ ok, text }); if (ok) { setAdding(false); await load(); } }} />
      )}

      <div className="inline-form">
        <div><label>Campus</label>
          <select value={fCampus} onChange={(e) => setFCampus(e.target.value)}>
            <option value="">All campuses</option>
            {myCampuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div style={{ minWidth: 220 }}><label>Search (name / email / code)</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {loading ? (
        <div className="card"><p className="muted">Loading teachers…</p></div>
      ) : loadError ? (
        <div className="card stack">
          <div className="toast err">{loadError.message}</div>
          {loadError.requestId && <p className="muted" style={{ margin: 0, fontSize: 12 }}>Request ID: <code>{loadError.requestId}</code></p>}
          <div><button className="ghost" onClick={() => load()}>Retry</button></div>
        </div>
      ) : groups.every((g) => g.items.length === 0) ? (
        <div className="card stack">
          <p className="muted" style={{ margin: 0 }}>{fCampus || search ? 'No teachers match.' : 'No teachers added yet.'}</p>
          <div><button onClick={() => setAdding(true)}>Add the first teacher</button></div>
        </div>
      ) : (
        groups.map((g) => (
          <div className="card stack" key={g.id}>
            <h2 style={{ margin: 0, fontSize: 18 }}>{g.name} <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>({g.items.length})</span></h2>
            {g.items.length === 0 ? (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>No teachers here yet.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead><tr><th>Name / Email</th><th>Code</th><th>Designation</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    {g.items.map((t) => {
                      const profile = profileByEmail.get(t.user.email.toLowerCase());
                      return (
                        <tr key={t.id}>
                          <td>{profile?.fullName ?? t.user.email}<div className="muted" style={{ fontSize: 12 }}>{t.user.email}</div></td>
                          <td>{t.employeeCode}</td>
                          <td>{t.designation}</td>
                          <td><span className={`badge ${t.user.status === 'ACTIVE' ? 'ok' : t.user.status === 'INVITED' ? 'warn' : 'bad'}`}>{t.user.status}</span></td>
                          <td style={{ textAlign: 'right' }}>
                            <button className="ghost small" onClick={() => setDetail(profile ? { applicationId: profile.id } : { applicationId: null, fallback: t })}>View</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function AddTeacherForm({ campuses, lockedCampus, onDone }: {
  campuses: Campus[]; lockedCampus: string | null; onDone: (ok: boolean, text: string) => void;
}) {
  const [f, setF] = useState<Record<string, string>>({ employmentType: 'FULL_TIME', gender: 'MALE', campusId: lockedCampus ?? '' });
  const [experiences, setExperiences] = useState<TeacherExperience[]>([]);
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const campusId = lockedCampus ?? f.campusId;

  const required = ['fullName', 'email', 'mobile', 'positionAppliedFor', 'department', 'fatherName', 'dateOfBirth', 'cnic', 'currentAddress', 'city', 'highestQualification'];
  const ready = Boolean(campusId) && required.every((k) => f[k]?.trim());

  const T = (label: string, key: string, opts: { type?: string; ph?: string; req?: boolean } = {}) => (
    <div>
      <label>{label}{opts.req ? ' *' : ''}</label>
      <input type={opts.type ?? 'text'} value={f[key] ?? ''} onChange={(e) => set(key, e.target.value)} placeholder={opts.ph} />
    </div>
  );
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px,1fr))', gap: 10 } as const;
  const secTitle = (t: string) => <div className="muted" style={{ fontWeight: 600, textTransform: 'uppercase', fontSize: 12, letterSpacing: 0.4, marginTop: 6 }}>{t}</div>;

  async function submit() {
    setBusy(true); setIssues([]);
    try {
      // 1. The real, load-bearing record: a staff/teacher login bound to the campus. This is
      //    what makes the teacher show up in the directory and (once activated) able to log in.
      const employeeCode = `T-${Date.now().toString(36).toUpperCase()}`;
      await api.staff.create({
        email: f.email, staffType: 'TEACHER', employeeCode,
        designation: f.positionAppliedFor, joinedAt: f.availableJoiningDate || new Date().toISOString().slice(0, 10),
        campusId,
      });

      // 2. Best-effort: the detailed onboarding profile. If this fails, the teacher is still a
      //    real, visible staff member — only the extended profile is missing.
      const body: CreateTeacherApplicationBody = {
        campusId, fullName: f.fullName, email: f.email, mobile: f.mobile,
        positionAppliedFor: f.positionAppliedFor, department: f.department, employmentType: f.employmentType,
        expectedSalary: f.expectedSalary ? Number(f.expectedSalary) : undefined,
        availableJoiningDate: opt(f.availableJoiningDate),
        details: {
          fatherName: f.fatherName, dateOfBirth: f.dateOfBirth, gender: f.gender, cnic: f.cnic,
          maritalStatus: opt(f.maritalStatus), nationality: opt(f.nationality), photoUrl: opt(f.photoUrl),
          whatsapp: opt(f.whatsapp), currentAddress: f.currentAddress, permanentAddress: opt(f.permanentAddress),
          city: f.city, province: opt(f.province), postalCode: opt(f.postalCode),
          preferredSubjects: opt(f.preferredSubjects), gradeLevels: opt(f.gradeLevels),
          highestQualification: f.highestQualification, degreeTitle: opt(f.degreeTitle), majorSubject: opt(f.majorSubject),
          university: opt(f.university), passingYear: f.passingYear ? Number(f.passingYear) : undefined, cgpa: opt(f.cgpa),
          totalExperience: opt(f.totalExperience), experiences: experiences.filter((e) => e.schoolName?.trim()),
          languages: opt(f.languages), computerSkills: opt(f.computerSkills), lmsExperience: opt(f.lmsExperience),
          msOfficeSkills: opt(f.msOfficeSkills), classroomManagement: opt(f.classroomManagement),
        },
      };
      try {
        await api.teacherApplications.create(body);
        onDone(true, `Added ${f.fullName} — they'll appear in the directory and can be invited to sign in.`);
      } catch {
        onDone(true, `Added ${f.fullName} as a teacher, but the detailed profile couldn't be saved (you can still see them in the directory).`);
      }
    } catch (e) {
      if (e instanceof ApiError && e.fieldIssues.length) setIssues(e.fieldIssues);
      onDone(false, e instanceof ApiError ? e.message : 'Failed to add teacher');
    } finally { setBusy(false); }
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>Add teacher</h2>

      {secTitle('Position')}
      <div style={grid}>
        {!lockedCampus && (
          <div><label>Campus *</label>
            <select value={f.campusId ?? ''} onChange={(e) => set('campusId', e.target.value)}>
              <option value="">Select…</option>{campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        {T('Position applied for', 'positionAppliedFor', { req: true, ph: 'Physics Teacher' })}
        {T('Department', 'department', { req: true, ph: 'Science' })}
        <div><label>Employment type</label>
          <select value={f.employmentType} onChange={(e) => set('employmentType', e.target.value)}>{EMP.map((x) => <option key={x.v} value={x.v}>{x.l}</option>)}</select>
        </div>
        {T('Preferred subjects', 'preferredSubjects', { ph: 'Physics, Maths' })}
        {T('Grade levels', 'gradeLevels', { ph: '9–12' })}
        {T('Expected salary', 'expectedSalary', { type: 'number' })}
        {T('Available joining date', 'availableJoiningDate', { type: 'date' })}
      </div>

      {secTitle('Personal')}
      <div style={grid}>
        {T('Full name', 'fullName', { req: true })}
        {T('Father / guardian name', 'fatherName', { req: true })}
        {T('Date of birth', 'dateOfBirth', { type: 'date', req: true })}
        <div><label>Gender *</label>
          <select value={f.gender} onChange={(e) => set('gender', e.target.value)}><option>MALE</option><option>FEMALE</option><option>OTHER</option></select>
        </div>
        {T('CNIC / National ID', 'cnic', { req: true, ph: '35202-1234567-8' })}
        {T('Marital status', 'maritalStatus')}
        {T('Nationality', 'nationality', { ph: 'Pakistani' })}
        {T('Photo URL', 'photoUrl', { ph: 'https://…' })}
      </div>

      {secTitle('Contact')}
      <div style={grid}>
        {T('Email', 'email', { type: 'email', req: true })}
        {T('Mobile number', 'mobile', { req: true, ph: '03001234567' })}
        {T('WhatsApp number', 'whatsapp')}
        {T('City', 'city', { req: true })}
        {T('Province', 'province')}
        {T('Postal code', 'postalCode')}
        {T('Current address', 'currentAddress', { req: true })}
        {T('Permanent address', 'permanentAddress')}
      </div>

      {secTitle('Education')}
      <div style={grid}>
        {T('Highest qualification', 'highestQualification', { req: true, ph: 'M.Sc Physics' })}
        {T('Degree title', 'degreeTitle')}
        {T('Major subject', 'majorSubject')}
        {T('University', 'university')}
        {T('Passing year', 'passingYear', { type: 'number' })}
        {T('CGPA / percentage', 'cgpa')}
      </div>

      {secTitle('Experience')}
      <div style={grid}>{T('Total teaching experience', 'totalExperience', { ph: '6 years' })}</div>
      {experiences.map((ex, i) => (
        <div key={i} style={{ ...grid, border: '1px solid #e5e7eb', borderRadius: 8, padding: 10 }}>
          <div><label>School name</label><input value={ex.schoolName} onChange={(e) => setExperiences((p) => p.map((x, n) => n === i ? { ...x, schoolName: e.target.value } : x))} /></div>
          <div><label>Position</label><input value={ex.position ?? ''} onChange={(e) => setExperiences((p) => p.map((x, n) => n === i ? { ...x, position: e.target.value } : x))} /></div>
          <div><label>Subjects taught</label><input value={ex.subjectsTaught ?? ''} onChange={(e) => setExperiences((p) => p.map((x, n) => n === i ? { ...x, subjectsTaught: e.target.value } : x))} /></div>
          <div><label>Grades taught</label><input value={ex.gradesTaught ?? ''} onChange={(e) => setExperiences((p) => p.map((x, n) => n === i ? { ...x, gradesTaught: e.target.value } : x))} /></div>
          <div><label>Duration</label><input value={ex.duration ?? ''} onChange={(e) => setExperiences((p) => p.map((x, n) => n === i ? { ...x, duration: e.target.value } : x))} placeholder="2018–2024" /></div>
          <div><label>Reason for leaving</label><input value={ex.reasonForLeaving ?? ''} onChange={(e) => setExperiences((p) => p.map((x, n) => n === i ? { ...x, reasonForLeaving: e.target.value } : x))} /></div>
          <div style={{ alignSelf: 'end' }}><button className="ghost small" onClick={() => setExperiences((p) => p.filter((_, n) => n !== i))}>Remove</button></div>
        </div>
      ))}
      <div><button className="ghost small" onClick={() => setExperiences((p) => [...p, { schoolName: '' }])}>+ Add previous school</button></div>

      {secTitle('Skills')}
      <div style={grid}>
        {T('Languages', 'languages', { ph: 'Urdu, English' })}
        {T('Computer skills', 'computerSkills')}
        {T('LMS experience', 'lmsExperience', { ph: 'Google Classroom' })}
        {T('MS Office skills', 'msOfficeSkills')}
        {T('Classroom management', 'classroomManagement')}
      </div>

      {issues.length > 0 && <ul className="toast err" style={{ margin: 0, paddingLeft: 22 }}>{issues.map((i, n) => <li key={n}>{i}</li>)}</ul>}
      <div><button disabled={!ready || busy} onClick={submit}>{busy ? 'Saving…' : 'Add teacher'}</button>
        {!ready && <span className="muted" style={{ marginLeft: 10, fontSize: 12 }}>Fill the fields marked *</span>}
      </div>
    </div>
  );
}

/** Fallback detail for a teacher who has no matching onboarding profile (e.g. added via Staff). */
function TeacherFallbackDetail({ teacher, onBack }: { teacher: ManagedTeacher; onBack: () => void }) {
  return (
    <div className="stack">
      <div className="row"><h1>Teacher</h1><button className="ghost" onClick={onBack}>← Back</button></div>
      <div className="card stack">
        <h2 style={{ margin: 0 }}>{teacher.user.email} <span className={`badge ${teacher.user.status === 'ACTIVE' ? 'ok' : 'warn'}`}>{teacher.user.status}</span></h2>
        <div className="stack" style={{ gap: 4 }}>
          <div><span className="muted" style={{ minWidth: 150, display: 'inline-block', fontSize: 13 }}>Employee code</span><span>{teacher.employeeCode}</span></div>
          <div><span className="muted" style={{ minWidth: 150, display: 'inline-block', fontSize: 13 }}>Designation</span><span>{teacher.designation}</span></div>
          <div><span className="muted" style={{ minWidth: 150, display: 'inline-block', fontSize: 13 }}>Campus</span><span>{teacher.user.campus?.name ?? '—'}</span></div>
          <div><span className="muted" style={{ minWidth: 150, display: 'inline-block', fontSize: 13 }}>Joined</span><span>{teacher.joinedAt?.slice(0, 10)}</span></div>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>No detailed onboarding profile on file for this teacher.</p>
      </div>
    </div>
  );
}

function TeacherDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [app, setApp] = useState<TeacherApplicationDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api.teacherApplications.get(id).then(setApp).catch((e) => setError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', 'Failed')));
  }, [id]);

  const Row = ({ k, v }: { k: string; v?: string | number | null }) =>
    v === undefined || v === null || v === '' ? null : (
      <div style={{ display: 'flex', gap: 8 }}><span className="muted" style={{ minWidth: 170, fontSize: 13 }}>{k}</span><span>{v}</span></div>
    );

  return (
    <div className="stack">
      <div className="row"><h1>Teacher</h1><button className="ghost" onClick={onBack}>← Back</button></div>
      {error ? (
        <div className="card stack"><div className="toast err">{error.message}</div><div><button className="ghost" onClick={onBack}>Back</button></div></div>
      ) : !app ? (
        <div className="card"><p className="muted">Loading…</p></div>
      ) : (
        <>
          <div className="card stack">
            <h2 style={{ margin: 0 }}>{app.fullName} <span className="badge">{app.status}</span></h2>
            <div className="stack" style={{ gap: 4 }}>
              <Row k="Position" v={app.positionAppliedFor} />
              <Row k="Department" v={app.department} />
              <Row k="Campus" v={app.campusName} />
              <Row k="Employment type" v={empLabel(app.employmentType)} />
              <Row k="Expected salary" v={app.expectedSalary} />
              <Row k="Available joining" v={app.availableJoiningDate ? String(app.availableJoiningDate).slice(0, 10) : null} />
            </div>
          </div>
          <div className="card stack">
            <h3 style={{ margin: 0, fontSize: 15 }}>Personal & contact</h3>
            <div className="stack" style={{ gap: 4 }}>
              <Row k="Father / guardian" v={app.details.fatherName} />
              <Row k="Date of birth" v={app.details.dateOfBirth?.slice?.(0, 10)} />
              <Row k="Gender" v={app.details.gender} />
              <Row k="CNIC" v={app.details.cnic} />
              <Row k="Marital status" v={app.details.maritalStatus} />
              <Row k="Nationality" v={app.details.nationality} />
              <Row k="Email" v={app.email} /><Row k="Mobile" v={app.mobile} /><Row k="WhatsApp" v={app.details.whatsapp} />
              <Row k="City" v={app.details.city} /><Row k="Province" v={app.details.province} /><Row k="Postal code" v={app.details.postalCode} />
              <Row k="Current address" v={app.details.currentAddress} /><Row k="Permanent address" v={app.details.permanentAddress} />
              <Row k="Preferred subjects" v={app.details.preferredSubjects} /><Row k="Grade levels" v={app.details.gradeLevels} />
            </div>
          </div>
          <div className="card stack">
            <h3 style={{ margin: 0, fontSize: 15 }}>Education</h3>
            <div className="stack" style={{ gap: 4 }}>
              <Row k="Highest qualification" v={app.details.highestQualification} />
              <Row k="Degree title" v={app.details.degreeTitle} /><Row k="Major subject" v={app.details.majorSubject} />
              <Row k="University" v={app.details.university} /><Row k="Passing year" v={app.details.passingYear} /><Row k="CGPA / %" v={app.details.cgpa} />
            </div>
          </div>
          <div className="card stack">
            <h3 style={{ margin: 0, fontSize: 15 }}>Experience</h3>
            <Row k="Total experience" v={app.details.totalExperience} />
            {(app.details.experiences ?? []).length === 0 ? <p className="muted" style={{ margin: 0, fontSize: 13 }}>No prior schools listed.</p> :
              (app.details.experiences ?? []).map((ex, i) => (
                <div key={i} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10 }} className="stack">
                  <strong>{ex.schoolName}</strong>
                  <div className="stack" style={{ gap: 4 }}>
                    <Row k="Position" v={ex.position} /><Row k="Subjects" v={ex.subjectsTaught} /><Row k="Grades" v={ex.gradesTaught} />
                    <Row k="Duration" v={ex.duration} /><Row k="Reason for leaving" v={ex.reasonForLeaving} />
                  </div>
                </div>
              ))}
          </div>
          <div className="card stack">
            <h3 style={{ margin: 0, fontSize: 15 }}>Skills</h3>
            <div className="stack" style={{ gap: 4 }}>
              <Row k="Languages" v={app.details.languages} /><Row k="Computer skills" v={app.details.computerSkills} />
              <Row k="LMS experience" v={app.details.lmsExperience} /><Row k="MS Office" v={app.details.msOfficeSkills} />
              <Row k="Classroom management" v={app.details.classroomManagement} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
