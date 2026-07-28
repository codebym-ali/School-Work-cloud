'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  api, apiGet, ApiError,
  type Campus, type CreateTeacherApplicationBody, type ManagedTeacher,
  type TeacherApplicationDetail, type TeacherEducation, type TeacherExperience,
} from '@/lib/api';
import { useMe } from '@/lib/me-context';

type Msg = { ok: boolean; text: string } | null;
const EMP = [{ v: 'FULL_TIME', l: 'Full-time' }, { v: 'PART_TIME', l: 'Part-time' }, { v: 'VISITING', l: 'Visiting' }];
const empLabel = (v: string) => EMP.find((e) => e.v === v)?.l ?? v;
const opt = (v?: string) => (v && v.trim() ? v.trim() : undefined);

/** Pakistani CNIC is 13 digits shown as 12345-1234567-1. Formatting as the user types beats
 *  a placeholder they have to imitate, and keeps what's stored consistent for later matching. */
function maskCnic(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 13);
  if (d.length <= 5) return d;
  if (d.length <= 12) return `${d.slice(0, 5)}-${d.slice(5)}`;
  return `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`;
}

/**
 * Teacher onboarding & profile (HR). Reached from the Staff directory — Staff is the single
 * list of people, so this screen deliberately has no directory of its own. It captures the
 * full onboarding profile (personal/contact/education/experience/skills), creating both the
 * real staff record and the detailed profile (best-effort — a profile-save failure doesn't
 * undo the real account), and renders one teacher's profile when opened with `?id=`.
 */
export default function TeachersPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <TeacherOnboarding />
    </Suspense>
  );
}

function TeacherOnboarding() {
  const me = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const applicationId = params.get('id');
  const isOwner = (me?.roles ?? []).includes('OWNER_ADMIN');

  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [msg, setMsg] = useState<Msg>(null);

  useEffect(() => { apiGet<Campus[]>('/campuses').then(setCampuses).catch(() => {}); }, []);

  const backToStaff = () => router.push('/staff');

  if (applicationId) return <TeacherDetail id={applicationId} onBack={backToStaff} />;

  const myCampuses = isOwner ? campuses : campuses.filter((c) => c.id === me?.campusId);

  return (
    <div className="stack">
      <div className="row">
        <h1>Add a teacher</h1>
        <Link className="ghost small" href="/staff">← Back to Staff</Link>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Captures the full onboarding profile and creates the teacher&apos;s staff record. They then
        appear in the <b>Staff</b> directory, where you can assign subjects and manage access.
      </p>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <AddTeacherForm campuses={myCampuses} lockedCampus={isOwner ? null : (me?.campusId ?? null)}
        onDone={(ok, text) => { setMsg({ ok, text }); if (ok) setTimeout(backToStaff, 900); }} />
    </div>
  );
}

function AddTeacherForm({ campuses, lockedCampus, onDone }: {
  campuses: Campus[]; lockedCampus: string | null; onDone: (ok: boolean, text: string) => void;
}) {
  const [f, setF] = useState<Record<string, string>>({ employmentType: 'FULL_TIME', gender: 'MALE', campusId: lockedCampus ?? '' });
  const [experiences, setExperiences] = useState<TeacherExperience[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [educations, setEducations] = useState<TeacherEducation[]>([]);
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const [step, setStep] = useState(1);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [showAllErrors, setShowAllErrors] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const campusId = lockedCampus ?? f.campusId;

  // Only what's genuinely needed to create the teacher. Everything else is "fill later" —
  // blocking the record on a CNIC nobody has to hand just means the teacher never gets added.
  const REQUIRED: Array<{ key: string; label: string }> = [
    { key: 'campusId', label: 'Campus' },
    { key: 'positionAppliedFor', label: 'Position applied for' },
    { key: 'department', label: 'Department' },
    { key: 'fullName', label: 'Full name' },
    { key: 'email', label: 'Email' },
    { key: 'mobile', label: 'Mobile number' },
  ];

  const valueOf = (k: string) => (k === 'campusId' ? campusId : f[k]) ?? '';
  const emailBad = Boolean(f.email?.trim()) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim());
  const missing = REQUIRED.filter((r) => !valueOf(r.key).trim());
  const ready = missing.length === 0 && !emailBad;

  // Long form, easy to lose — keep a local draft so a stray click doesn't cost 20 fields.
  const DRAFT_KEY = 'teacher-draft';
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) as { f?: Record<string, string>; educations?: TeacherEducation[]; experiences?: TeacherExperience[]; skills?: string[] };
      if (d.f && Object.keys(d.f).length) {
        setF((p) => ({ ...p, ...d.f }));
        setEducations(d.educations ?? []); setExperiences(d.experiences ?? []); setSkills(d.skills ?? []);
        setDraftRestored(true);
      }
    } catch { /* a corrupt draft must never break the form */ }
  }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ f, educations, experiences, skills })); } catch { /* quota — ignore */ }
    }, 400);
    return () => clearTimeout(t);
  }, [f, educations, experiences, skills]);
  const clearDraft = () => { try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } };

  const errorFor = (key: string): string | null => {
    const req = REQUIRED.find((r) => r.key === key);
    if (req && !valueOf(key).trim()) return `${req.label} is required`;
    if (key === 'email' && emailBad) return 'That doesn’t look like an email address';
    return null;
  };
  const showError = (key: string) => (touched[key] || showAllErrors) && errorFor(key);

  /** One field. `w` picks the grid span so a postal code isn't as wide as an address. */
  const T = (label: string, key: string, opts: { type?: string; ph?: string; req?: boolean; w?: string; hint?: string; inputMode?: 'numeric' | 'tel' } = {}) => {
    const err = showError(key);
    return (
      <div className={opts.w ?? 'f-third'}>
        <label htmlFor={key}>{label}{opts.req ? ' *' : ''}</label>
        <input
          id={key}
          type={opts.type ?? 'text'}
          inputMode={opts.inputMode}
          className={err ? 'invalid' : undefined}
          value={f[key] ?? ''}
          onChange={(e) => set(key, key === 'cnic' ? maskCnic(e.target.value) : e.target.value)}
          onBlur={() => setTouched((p) => ({ ...p, [key]: true }))}
          placeholder={opts.ph}
        />
        {err ? <div className="field-error">{err}</div> : opts.hint ? <div className="field-hint">{opts.hint}</div> : null}
      </div>
    );
  };
  const secTitle = (t: string) => <div className="section-title" style={{ marginTop: 10 }}>{t}</div>;

  /** Jump to the first missing field — a disabled button that won't say why is the most
   *  frustrating thing on a form this long. */
  const goToFirstMissing = () => {
    setShowAllErrors(true);
    const first = missing[0] ?? (emailBad ? { key: 'email' } : null);
    if (!first) return;
    setStep(1); // every required field lives in step 1
    setTimeout(() => {
      const el = document.getElementById(first.key);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.focus({ preventScroll: true });
    }, 60);
  };

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
          educations,
          // Mirror the first entry into the legacy field so anything still reading
          // `highestQualification` (older detail views, exports) keeps working.
          highestQualification: educations[0]?.qualification,
          totalExperience: opt(f.totalExperience), experiences: experiences.filter((e) => e.schoolName?.trim()),
          skills,
        },
      };
      try {
        await api.teacherApplications.create(body);
        clearDraft();
        onDone(true, `Added ${f.fullName} — they'll appear in the directory and can be invited to sign in.`);
      } catch {
        clearDraft();
        onDone(true, `Added ${f.fullName} as a teacher, but the detailed profile couldn't be saved (you can still see them in the directory).`);
      }
    } catch (e) {
      if (e instanceof ApiError && e.fieldIssues.length) setIssues(e.fieldIssues);
      onDone(false, e instanceof ApiError ? e.message : 'Failed to add teacher');
    } finally { setBusy(false); }
  }

  const STEPS = [
    { n: 1, label: 'Job & person', done: ready },
    { n: 2, label: 'Personal & contact', done: Boolean(f.cnic || f.currentAddress || f.city) },
    { n: 3, label: 'Background', done: educations.length > 0 || experiences.length > 0 || skills.length > 0 },
  ];

  return (
    <div className="card stack">
      {draftRestored && (
        <div className="toast" style={{ background: '#eef2ff', color: '#3730a3', margin: 0 }}>
          Restored your unsaved draft.{' '}
          <button className="ghost small" style={{ marginLeft: 8 }}
            onClick={() => { clearDraft(); setF({ employmentType: 'FULL_TIME', gender: 'MALE', campusId: lockedCampus ?? '' }); setEducations([]); setExperiences([]); setSkills([]); setDraftRestored(false); }}>
            Start fresh
          </button>
        </div>
      )}

      <div className="steps">
        {STEPS.map((s) => (
          <button key={s.n} type="button" className={`step-pill${step === s.n ? ' active' : ''}${s.done ? ' done' : ''}`} onClick={() => setStep(s.n)}>
            <span className="n">{s.done ? '✓' : s.n}</span>{s.label}
          </button>
        ))}
      </div>

      {step === 1 && (
        <>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Just enough to create the teacher. The rest can be filled in now or any time later.
          </p>
          {secTitle('Position')}
          <div className="form-grid">
            {!lockedCampus && (
              <div className="f-third">
                <label htmlFor="campusId">Campus *</label>
                <select id="campusId" className={showError('campusId') ? 'invalid' : undefined} value={f.campusId ?? ''}
                  onChange={(e) => set('campusId', e.target.value)} onBlur={() => setTouched((p) => ({ ...p, campusId: true }))}>
                  <option value="">Select…</option>{campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                {showError('campusId') && <div className="field-error">Campus is required</div>}
              </div>
            )}
            {T('Position applied for', 'positionAppliedFor', { req: true, ph: 'Physics Teacher' })}
            {T('Department', 'department', { req: true, ph: 'Science' })}
            <div className="f-third"><label htmlFor="employmentType">Employment type</label>
              <select id="employmentType" value={f.employmentType} onChange={(e) => set('employmentType', e.target.value)}>
                {EMP.map((x) => <option key={x.v} value={x.v}>{x.l}</option>)}
              </select>
            </div>
            {T('Available joining date', 'availableJoiningDate', { type: 'date', w: 'f-third', hint: 'DD/MM/YYYY' })}
            {T('Expected salary', 'expectedSalary', { type: 'number', w: 'f-third', inputMode: 'numeric' })}
          </div>

          {secTitle('Person')}
          <div className="form-grid">
            {T('Full name', 'fullName', { req: true, w: 'f-half', ph: 'Ayesha Khan' })}
            {T('Email', 'email', { type: 'email', req: true, w: 'f-half', hint: 'Becomes their login — they’ll be invited by email' })}
            {T('Mobile number', 'mobile', { req: true, w: 'f-third', ph: '03001234567', inputMode: 'tel' })}
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>All optional — add what you have.</p>
          {secTitle('Personal')}
          <div className="form-grid">
            {T('Father / guardian name', 'fatherName', { w: 'f-third' })}
            {T('Date of birth', 'dateOfBirth', { type: 'date', w: 'f-third', hint: 'DD/MM/YYYY' })}
            <div className="f-quarter"><label htmlFor="gender">Gender</label>
              <select id="gender" value={f.gender} onChange={(e) => set('gender', e.target.value)}>
                <option>MALE</option><option>FEMALE</option><option>OTHER</option>
              </select>
            </div>
            {T('CNIC / National ID', 'cnic', { w: 'f-third', ph: '35202-1234567-8', inputMode: 'numeric', hint: 'Formats as you type' })}
            {T('Marital status', 'maritalStatus', { w: 'f-quarter' })}
            {T('Nationality', 'nationality', { w: 'f-quarter', ph: 'Pakistani' })}
            {T('Photo URL', 'photoUrl', { w: 'f-half', ph: 'https://…' })}
          </div>

          {secTitle('Contact')}
          <div className="form-grid">
            {T('WhatsApp number', 'whatsapp', { w: 'f-third', inputMode: 'tel' })}
            {T('City', 'city', { w: 'f-third' })}
            {T('Province', 'province', { w: 'f-third' })}
            {T('Postal code', 'postalCode', { w: 'f-quarter', inputMode: 'numeric' })}
            {T('Current address', 'currentAddress', { w: 'f-full' })}
            {T('Permanent address', 'permanentAddress', { w: 'f-full' })}
          </div>

          {secTitle('Teaching preferences')}
          <div className="form-grid">
            {T('Preferred subjects', 'preferredSubjects', { w: 'f-half', ph: 'Physics, Maths' })}
            {T('Grade levels', 'gradeLevels', { w: 'f-third', ph: '9–12' })}
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>All optional — qualifications, previous schools and skills.</p>
          {secTitle('Education')}
          <EducationList educations={educations} onChange={setEducations} />

          {secTitle('Experience')}
          <div className="form-grid">{T('Total teaching experience', 'totalExperience', { w: 'f-third', ph: '6 years' })}</div>
          {experiences.map((ex, i) => (
            <div key={i} className="form-grid" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
              <div className="f-half"><label>School name</label><input value={ex.schoolName} onChange={(e) => setExperiences((p) => p.map((x, n) => n === i ? { ...x, schoolName: e.target.value } : x))} /></div>
              <div className="f-third"><label>Position</label><input value={ex.position ?? ''} onChange={(e) => setExperiences((p) => p.map((x, n) => n === i ? { ...x, position: e.target.value } : x))} /></div>
              <div className="f-third"><label>Subjects taught</label><input value={ex.subjectsTaught ?? ''} onChange={(e) => setExperiences((p) => p.map((x, n) => n === i ? { ...x, subjectsTaught: e.target.value } : x))} /></div>
              <div className="f-quarter"><label>Grades taught</label><input value={ex.gradesTaught ?? ''} onChange={(e) => setExperiences((p) => p.map((x, n) => n === i ? { ...x, gradesTaught: e.target.value } : x))} /></div>
              <div className="f-quarter"><label>Duration</label><input value={ex.duration ?? ''} onChange={(e) => setExperiences((p) => p.map((x, n) => n === i ? { ...x, duration: e.target.value } : x))} placeholder="2018–2024" /></div>
              <div className="f-half"><label>Reason for leaving</label><input value={ex.reasonForLeaving ?? ''} onChange={(e) => setExperiences((p) => p.map((x, n) => n === i ? { ...x, reasonForLeaving: e.target.value } : x))} /></div>
              <div className="f-quarter" style={{ alignSelf: 'end' }}><button className="ghost small" type="button" onClick={() => setExperiences((p) => p.filter((_, n) => n !== i))}>Remove</button></div>
            </div>
          ))}
          <div><button className="ghost small" type="button" onClick={() => setExperiences((p) => [...p, { schoolName: '' }])}>+ Add previous school</button></div>

          {secTitle('Skills')}
          <SkillTags skills={skills} onChange={setSkills} />
        </>
      )}

      {issues.length > 0 && <ul className="toast err" style={{ margin: 0, paddingLeft: 22 }}>{issues.map((i, n) => <li key={n}>{i}</li>)}</ul>}

      <div className="form-actions">
        {step > 1 && <button className="ghost" type="button" onClick={() => setStep(step - 1)}>← Back</button>}
        {step < 3 && <button className="ghost" type="button" onClick={() => setStep(step + 1)}>Next →</button>}
        {/* Deliberately NOT disabled: clicking tells you exactly what's missing and takes you there. */}
        <button type="button" disabled={busy} onClick={() => (ready ? submit() : goToFirstMissing())}>
          {busy ? 'Saving…' : 'Add teacher'}
        </button>
        {!ready && (
          <button className="ghost small" type="button" onClick={goToFirstMissing}>
            {missing.length || 1} required field{(missing.length || 1) === 1 ? '' : 's'} left
          </button>
        )}
      </div>
    </div>
  );
}

/** Education as a repeatable list. Teachers commonly hold several qualifications (Matric,
 *  B.Ed, M.Sc, a diploma), and the previous single set of fields could only capture one — so
 *  the rest were either lost or crammed into one box. The form is hidden behind a button and
 *  each saved qualification can be edited or removed. */
function EducationList({ educations, onChange }: { educations: TeacherEducation[]; onChange: (e: TeacherEducation[]) => void }) {
  const blank: TeacherEducation = { qualification: '' };
  const [draft, setDraft] = useState<TeacherEducation | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px,1fr))', gap: 10 } as const;
  const setD = (k: keyof TeacherEducation, v: string) =>
    setDraft((p) => ({ ...(p ?? blank), [k]: k === 'passingYear' ? (v ? Number(v) : undefined) : v }));

  const close = () => { setDraft(null); setEditingIndex(null); };

  const save = () => {
    if (!draft?.qualification.trim()) return;
    const entry = { ...draft, qualification: draft.qualification.trim() };
    onChange(editingIndex === null ? [...educations, entry] : educations.map((e, i) => (i === editingIndex ? entry : e)));
    close();
  };

  const summary = (e: TeacherEducation) =>
    [e.degreeTitle, e.majorSubject, e.university, e.passingYear, e.cgpa].filter(Boolean).join(' · ');

  return (
    <div className="stack" style={{ gap: 8 }}>
      {educations.map((e, i) => (
        <div key={i} className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8 }}>
          <strong>{e.qualification}</strong>
          {summary(e) && <span className="muted" style={{ fontSize: 13 }}>{summary(e)}</span>}
          <div className="row" style={{ gap: 8, marginLeft: 'auto' }}>
            <button className="ghost small" type="button" onClick={() => { setDraft(e); setEditingIndex(i); }}>Edit</button>
            <button className="ghost small" type="button" style={{ color: '#b91c1c' }}
              onClick={() => { onChange(educations.filter((_, n) => n !== i)); if (editingIndex === i) close(); }}>
              Delete
            </button>
          </div>
        </div>
      ))}

      {draft === null ? (
        <div>
          <button className="ghost small" type="button" onClick={() => { setDraft(blank); setEditingIndex(null); }}>
            + Add qualification
          </button>
          {educations.length === 0 && (
            <span className="muted" style={{ marginLeft: 10, fontSize: 12 }}>At least one qualification is required.</span>
          )}
        </div>
      ) : (
        <div className="stack" style={{ gap: 10, padding: 12, border: '1px solid #c7d2fe', borderRadius: 8 }}>
          <strong style={{ fontSize: 14 }}>{editingIndex === null ? 'New qualification' : 'Edit qualification'}</strong>
          <div style={grid}>
            <div><label>Qualification *</label>
              <input autoFocus value={draft.qualification} onChange={(e) => setD('qualification', e.target.value)} placeholder="M.Sc Physics" /></div>
            <div><label>Degree title</label>
              <input value={draft.degreeTitle ?? ''} onChange={(e) => setD('degreeTitle', e.target.value)} /></div>
            <div><label>Major subject</label>
              <input value={draft.majorSubject ?? ''} onChange={(e) => setD('majorSubject', e.target.value)} /></div>
            <div><label>University</label>
              <input value={draft.university ?? ''} onChange={(e) => setD('university', e.target.value)} /></div>
            <div><label>Passing year</label>
              <input type="number" value={draft.passingYear ?? ''} onChange={(e) => setD('passingYear', e.target.value)} placeholder="2018" /></div>
            <div><label>CGPA / percentage</label>
              <input value={draft.cgpa ?? ''} onChange={(e) => setD('cgpa', e.target.value)} /></div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" disabled={!draft.qualification.trim()} onClick={save}>
              {editingIndex === null ? 'Add qualification' : 'Save changes'}
            </button>
            <button className="ghost" type="button" onClick={close}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** One box for every skill, entered as tags. The old form had five fixed slots (languages /
 *  computer / LMS / MS Office / classroom management), so anything outside those buckets had
 *  nowhere to go and most were left blank. Type a skill, press Enter or Add; click a tag to
 *  remove it. Duplicates (case-insensitive) are ignored. */
function SkillTags({ skills, onChange }: { skills: string[]; onChange: (s: string[]) => void }) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const value = draft.trim();
    if (!value) return;
    if (!skills.some((s) => s.toLowerCase() === value.toLowerCase())) onChange([...skills, value]);
    setDraft('');
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      {skills.length > 0 && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {skills.map((s) => (
            <button
              key={s}
              type="button"
              className="badge"
              onClick={() => onChange(skills.filter((x) => x !== s))}
              title={`Remove ${s}`}
              style={{ border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              {s}<span aria-hidden style={{ opacity: 0.6 }}>✕</span>
            </button>
          ))}
        </div>
      )}
      <div className="inline-form">
        <div style={{ flex: 1, minWidth: 220 }}>
          <label>Skill</label>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            // Enter must not submit the surrounding form — it adds a tag.
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            placeholder="e.g. Urdu, Google Classroom, Lab safety"
          />
        </div>
        <button className="ghost" type="button" disabled={!draft.trim()} onClick={add}>Add</button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        {skills.length ? 'Click a skill to remove it.' : 'Add each skill one at a time — press Enter or click Add.'}
      </p>
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
              {/* Encrypted at rest and never returned (audit fix #5) — show that it is on
                  file rather than a blank, which would read as "never captured". */}
              <Row k="CNIC" v={app.hasCnic ? 'On file (encrypted)' : undefined} />
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
            <div className="stack" style={{ gap: 6 }}>
              {app.details.educations?.length ? (
                app.details.educations.map((ed, i) => (
                  <div key={i} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13 }}>{ed.qualification}</strong>
                    <span className="muted" style={{ fontSize: 13 }}>
                      {[ed.degreeTitle, ed.majorSubject, ed.university, ed.passingYear, ed.cgpa].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                ))
              ) : (
                // Records saved before education became a list.
                <>
                  <Row k="Highest qualification" v={app.details.highestQualification} />
                  <Row k="Degree title" v={app.details.degreeTitle} /><Row k="Major subject" v={app.details.majorSubject} />
                  <Row k="University" v={app.details.university} /><Row k="Passing year" v={app.details.passingYear} /><Row k="CGPA / %" v={app.details.cgpa} />
                </>
              )}
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
            <div className="stack" style={{ gap: 6 }}>
              {app.details.skills?.length
                ? <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {app.details.skills.map((s) => <span key={s} className="badge">{s}</span>)}
                  </div>
                : <span className="muted" style={{ fontSize: 13 }}>None recorded.</span>}
              {/* Applications captured before the tag list still carry the old fixed fields. */}
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
