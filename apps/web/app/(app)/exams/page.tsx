'use client';

import { useEffect, useState } from 'react';
import {
  apiGet, apiPost, apiPut, ApiError,
  type AcademicYear, type Exam, type ExamResult, type GradeBand,
  type Klass, type Paged, type Section, type Student, type Subject, type Term, type ReportCard,
} from '@/lib/api';

const EXAM_TYPES = ['MONTHLY', 'MID_TERM', 'FINAL', 'SURPRISE_TEST'];

export default function ExamsPage() {
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [terms, setTerms] = useState<Term[]>([]);
  const [classes, setClasses] = useState<Klass[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [students, setStudents] = useState<Record<string, string>>({});
  const [exams, setExams] = useState<Exam[]>([]);
  const [classFilter, setClassFilter] = useState('');
  const [termFilter, setTermFilter] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function reloadBase() {
    const [y, t, k, s, sub, st] = await Promise.all([
      apiGet<AcademicYear[]>('/academic-years'),
      apiGet<Term[]>('/terms'),
      apiGet<Klass[]>('/classes'),
      apiGet<Section[]>('/sections'),
      apiGet<Subject[]>('/subjects'),
      apiGet<Paged<Student>>('/students?pageSize=100'),
    ]);
    setYears(y); setTerms(t); setClasses(k); setSections(s); setSubjects(sub);
    setStudents(Object.fromEntries(st.data.map((x) => [x.id, `${x.fullName} (${x.grNumber})`])));
  }
  async function reloadExams() {
    const q = new URLSearchParams();
    if (classFilter) q.set('classId', classFilter);
    if (termFilter) q.set('termId', termFilter);
    const qs = q.toString();
    setExams(await apiGet<Exam[]>(`/exams${qs ? `?${qs}` : ''}`));
  }
  useEffect(() => { reloadBase().catch(() => {}); }, []);
  useEffect(() => { reloadExams().catch(() => {}); }, [classFilter, termFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // `after` (e.g. reloadBase/reloadExams) is awaited before the toast is shown, so any
  // dropdown fed by that state already reflects the change once the user sees success.
  async function run(fn: () => Promise<unknown>, ok: string, after?: () => Promise<unknown>) {
    try {
      await fn();
      if (after) await after();
      setMsg({ ok: true, text: ok });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed' });
      return false;
    }
  }

  const className = (id: string) => classes.find((c) => c.id === id)?.name ?? id.slice(0, 8);
  const termName = (id: string) => terms.find((t) => t.id === id)?.name ?? id.slice(0, 8);

  return (
    <div className="stack">
      <h1>Exams</h1>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <SubjectsCard subjects={subjects} classes={classes}
        onCreate={(b) => run(() => apiPost('/subjects', b), 'Subject created', reloadBase)} />

      <GradeScaleCard years={years}
        onSaved={(ok, text) => setMsg({ ok, text })} />

      <TermsCard years={years} terms={terms}
        onCreate={(b) => run(() => apiPost('/terms', b), 'Term created', reloadBase)} />

      <div className="card stack">
        <h2 style={{ margin: 0, fontSize: 17 }}>Exams</h2>
        <div className="inline-form">
          <div><label>Class</label>
            <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)}>
              <option value="">All</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div><label>Term</label>
            <select value={termFilter} onChange={(e) => setTermFilter(e.target.value)}>
              <option value="">All</option>{terms.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        </div>

        <NewExam terms={terms} classes={classes}
          onCreate={(b) => run(() => apiPost('/exams', { ...b, weightagePercent: Number(b.weightagePercent) }), 'Exam created', reloadExams)} />

        <table>
          <thead><tr><th>Name</th><th>Class</th><th>Term</th><th>Type</th><th>Weightage</th><th>Date</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {exams.map((ex) => (
              <ExamRow key={ex.id} exam={ex} className={className(ex.classId)} termName={termName(ex.termId)}
                sections={sections} subjects={subjects} students={students}
                onAction={run} onReload={reloadExams} />
            ))}
            {exams.length === 0 && <tr><td colSpan={8} className="muted">No exams yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <ReportCardsCard terms={terms} onAction={run} />
    </div>
  );
}

function SubjectsCard({ subjects, classes, onCreate }: { subjects: Subject[]; classes: Klass[]; onCreate: (b: Record<string, string>) => void }) {
  const [form, setForm] = useState<Record<string, string>>({});
  const nameFor = (id: string) => classes.find((c) => c.id === id)?.name ?? '?';
  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>Subjects</h2>
      <div className="muted">{subjects.length ? subjects.map((s) => `${nameFor(s.classId)}: ${s.name}`).join(' · ') : 'None yet.'}</div>
      <div className="inline-form">
        <div><label>Class</label>
          <select value={form.classId ?? ''} onChange={(e) => setForm({ ...form, classId: e.target.value })}>
            <option value="">Select…</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div><label>Name</label><input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Mathematics" /></div>
        <button onClick={() => onCreate(form)} disabled={!form.classId || !form.name}>Add subject</button>
      </div>
    </div>
  );
}

function GradeScaleCard({ years, onSaved }: { years: AcademicYear[]; onSaved: (ok: boolean, text: string) => void }) {
  const [yearId, setYearId] = useState('');
  const [bands, setBands] = useState<GradeBand[]>([]);

  useEffect(() => {
    if (!yearId) { setBands([]); return; }
    apiGet<GradeBand[]>(`/grade-scales?academicYearId=${yearId}`).then(setBands).catch(() => setBands([]));
  }, [yearId]);

  function updateBand(i: number, k: keyof GradeBand, v: string) {
    setBands(bands.map((b, idx) => (idx === i ? { ...b, [k]: v } : b)));
  }
  function addBand() { setBands([...bands, { label: '', minPercent: '0', maxPercent: '100', gradePoint: '0' }]); }
  function removeBand(i: number) { setBands(bands.filter((_, idx) => idx !== i)); }

  async function save() {
    try {
      const body = {
        academicYearId: yearId,
        bands: bands.map((b) => ({
          label: b.label, minPercent: Number(b.minPercent), maxPercent: Number(b.maxPercent), gradePoint: Number(b.gradePoint),
        })),
      };
      const res = await apiPut<GradeBand[]>('/grade-scales', body);
      setBands(res);
      onSaved(true, 'Grade scale saved');
    } catch (e) {
      onSaved(false, e instanceof ApiError ? e.message : 'Failed to save grade scale');
    }
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>Grade scale</h2>
      <div className="inline-form">
        <div style={{ minWidth: 220 }}><label>Academic year</label>
          <select value={yearId} onChange={(e) => setYearId(e.target.value)}>
            <option value="">Select…</option>{years.map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}
          </select>
        </div>
      </div>
      {yearId && (
        <>
          <table>
            <thead><tr><th>Label</th><th>Min %</th><th>Max %</th><th>Grade point</th><th></th></tr></thead>
            <tbody>
              {bands.map((b, i) => (
                <tr key={i}>
                  <td><input value={b.label} onChange={(e) => updateBand(i, 'label', e.target.value)} /></td>
                  <td><input value={String(b.minPercent)} onChange={(e) => updateBand(i, 'minPercent', e.target.value)} /></td>
                  <td><input value={String(b.maxPercent)} onChange={(e) => updateBand(i, 'maxPercent', e.target.value)} /></td>
                  <td><input value={String(b.gradePoint)} onChange={(e) => updateBand(i, 'gradePoint', e.target.value)} /></td>
                  <td><button className="ghost small" onClick={() => removeBand(i)}>Remove</button></td>
                </tr>
              ))}
              {bands.length === 0 && <tr><td colSpan={5} className="muted">No bands yet.</td></tr>}
            </tbody>
          </table>
          <div className="inline-form">
            <button className="ghost" onClick={addBand}>+ Add band</button>
            <button onClick={save} disabled={bands.length === 0}>Save grade scale</button>
          </div>
        </>
      )}
    </div>
  );
}

function TermsCard({ years, terms, onCreate }: { years: AcademicYear[]; terms: Term[]; onCreate: (b: Record<string, string>) => void }) {
  const [form, setForm] = useState<Record<string, string>>({});
  const yearName = (id: string) => years.find((y) => y.id === id)?.name ?? '?';
  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>Terms</h2>
      <div className="muted">{terms.length ? terms.map((t) => `${t.name} (${yearName(t.academicYearId)})`).join(' · ') : 'None yet.'}</div>
      <div className="inline-form">
        <div><label>Academic year</label>
          <select value={form.academicYearId ?? ''} onChange={(e) => setForm({ ...form, academicYearId: e.target.value })}>
            <option value="">Select…</option>{years.map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}
          </select>
        </div>
        <div><label>Name</label><input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Term 1" /></div>
        <div><label>Start</label><input type="date" value={form.startDate ?? ''} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></div>
        <div><label>End</label><input type="date" value={form.endDate ?? ''} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></div>
        <button onClick={() => onCreate(form)} disabled={!form.academicYearId || !form.name || !form.startDate || !form.endDate}>Add term</button>
      </div>
    </div>
  );
}

function NewExam({ terms, classes, onCreate }: { terms: Term[]; classes: Klass[]; onCreate: (b: Record<string, string>) => void }) {
  const [form, setForm] = useState<Record<string, string>>({ examType: 'MONTHLY', weightagePercent: '100' });
  return (
    <div className="inline-form">
      <div><label>Term</label>
        <select value={form.termId ?? ''} onChange={(e) => setForm({ ...form, termId: e.target.value })}>
          <option value="">Select…</option>{terms.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>
      <div><label>Class</label>
        <select value={form.classId ?? ''} onChange={(e) => setForm({ ...form, classId: e.target.value })}>
          <option value="">Select…</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div><label>Name</label><input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Monthly test 1" /></div>
      <div><label>Type</label>
        <select value={form.examType} onChange={(e) => setForm({ ...form, examType: e.target.value })}>
          {EXAM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div style={{ maxWidth: 110 }}><label>Weightage %</label><input value={form.weightagePercent} onChange={(e) => setForm({ ...form, weightagePercent: e.target.value })} /></div>
      <div><label>Exam date</label><input type="date" value={form.examDate ?? ''} onChange={(e) => setForm({ ...form, examDate: e.target.value })} /></div>
      <button onClick={() => onCreate(form)} disabled={!form.termId || !form.classId || !form.name || !form.examDate}>Create exam</button>
    </div>
  );
}

type ActionFn = (fn: () => Promise<unknown>, ok: string, after?: () => Promise<unknown>) => Promise<boolean>;

function ExamRow({
  exam, className, termName, sections, subjects, students, onAction, onReload,
}: {
  exam: Exam;
  className: string;
  termName: string;
  sections: Section[];
  subjects: Subject[];
  students: Record<string, string>;
  onAction: ActionFn;
  onReload: () => Promise<void>;
}) {
  const [open, setOpen] = useState<'marks' | 'results' | null>(null);
  const badge = (s: string) => (s === 'PUBLISHED' ? 'ok' : s === 'MARKS_ENTRY' ? 'warn' : '');

  const act = (fn: () => Promise<unknown>, ok: string) => onAction(fn, ok, onReload);

  return (
    <>
      <tr>
        <td>{exam.name}</td>
        <td>{className}</td>
        <td>{termName}</td>
        <td>{exam.examType}</td>
        <td>{exam.weightagePercent}%</td>
        <td>{exam.examDate.slice(0, 10)}</td>
        <td><span className={`badge ${badge(exam.status)}`}>{exam.status}</span></td>
        <td>
          <span className="inline-form">
            {exam.status === 'DRAFT' && <button className="ghost small" onClick={() => act(() => apiPost(`/exams/${exam.id}/open-marks-entry`), 'Marks entry opened')}>Open marks entry</button>}
            {exam.status !== 'DRAFT' && <button className="ghost small" onClick={() => setOpen(open === 'marks' ? null : 'marks')}>Enter marks</button>}
            <button className="ghost small" onClick={() => setOpen(open === 'results' ? null : 'results')}>Results</button>
            {exam.status === 'MARKS_ENTRY' && <button className="small" onClick={() => act(() => apiPost(`/exams/${exam.id}/publish`), 'Exam published')}>Publish</button>}
          </span>
        </td>
      </tr>
      {open === 'marks' && (
        <tr><td colSpan={8}>
          <MarksEntryPanel exam={exam} sections={sections.filter((s) => s.classId === exam.classId)}
            subjects={subjects.filter((s) => s.classId === exam.classId)} students={students}
            onAction={onAction} onClose={() => setOpen(null)} />
        </td></tr>
      )}
      {open === 'results' && (
        <tr><td colSpan={8}>
          <ResultsPanel examId={exam.id} subjects={subjects} students={students} onClose={() => setOpen(null)} />
        </td></tr>
      )}
    </>
  );
}

function MarksEntryPanel({
  exam, sections, subjects, students, onAction, onClose,
}: {
  exam: Exam;
  sections: Section[];
  subjects: Subject[];
  students: Record<string, string>;
  onAction: ActionFn;
  onClose: () => void;
}) {
  const [sectionId, setSectionId] = useState('');
  const [enrollments, setEnrollments] = useState<Array<{ id: string; studentId: string }>>([]);
  const [defaultTotal, setDefaultTotal] = useState('100');
  const [rows, setRows] = useState<Record<string, { totalMarks: string; marksObtained: string; isAbsent: boolean }>>({});
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  async function loadRoster() {
    if (!sectionId) return;
    const enr = await apiGet<{ data: Array<{ id: string; studentId: string }> }>(`/enrollments?sectionId=${sectionId}&status=ACTIVE`);
    const existing = await apiGet<ExamResult[]>(`/exams/${exam.id}/results`);
    const next: Record<string, { totalMarks: string; marksObtained: string; isAbsent: boolean }> = {};
    for (const e of enr.data) {
      for (const s of subjects) {
        const key = `${e.id}:${s.id}`;
        const found = existing.find((r) => r.enrollmentId === e.id && r.subjectId === s.id);
        next[key] = found
          ? { totalMarks: String(found.totalMarks), marksObtained: found.marksObtained != null ? String(found.marksObtained) : '', isAbsent: found.isAbsent }
          : { totalMarks: defaultTotal, marksObtained: '', isAbsent: false };
      }
    }
    // Set rows BEFORE enrollments: the editable table renders on `enrollments.length > 0`,
    // so populating rows first ensures the inputs never render (and can't be typed into
    // then clobbered) before their backing state exists. Otherwise a mark typed during the
    // gap is overwritten by this setRows and posts as 0.
    setRows(next);
    setEnrollments(enr.data);
  }

  function updateRow(key: string, patch: Partial<{ totalMarks: string; marksObtained: string; isAbsent: boolean }>) {
    // Functional update: edits to different cells must compose off the latest state, not a
    // stale `rows` closure (React may batch several onChange commits together).
    setRows((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  async function save() {
    const records = enrollments.flatMap((e) =>
      subjects.map((s) => {
        const key = `${e.id}:${s.id}`;
        const r = rows[key];
        return {
          enrollmentId: e.id,
          subjectId: s.id,
          totalMarks: Number(r.totalMarks),
          isAbsent: r.isAbsent,
          ...(r.isAbsent ? {} : { marksObtained: Number(r.marksObtained) }),
        };
      }),
    );
    setSaveMsg(null);
    await onAction(async () => {
      const res = await apiPost<{ succeeded: number; failed: number }>(`/exams/${exam.id}/results/bulk`, { records });
      setSaveMsg(`Saved ${res.succeeded}, failed ${res.failed}`);
    }, 'Marks saved');
  }

  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0, fontSize: 17 }}>Enter marks — {exam.name}</h2>
        <button className="ghost small" onClick={onClose}>Close</button>
      </div>
      {subjects.length === 0 && <p className="muted">No subjects defined for this class yet — add one above.</p>}
      <div className="inline-form">
        <div><label>Section</label>
          <select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
            <option value="">Select…</option>{sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div style={{ maxWidth: 100 }}><label>Default total</label><input value={defaultTotal} onChange={(e) => setDefaultTotal(e.target.value)} /></div>
        <button className="ghost" onClick={loadRoster} disabled={!sectionId || subjects.length === 0}>Load roster</button>
      </div>

      {enrollments.length > 0 && subjects.length > 0 && (
        <>
          <table>
            <thead><tr><th>Student</th><th>Subject</th><th>Total marks</th><th>Marks obtained</th><th>Absent</th></tr></thead>
            <tbody>
              {enrollments.map((e) => subjects.map((s) => {
                const key = `${e.id}:${s.id}`;
                const r = rows[key] ?? { totalMarks: defaultTotal, marksObtained: '', isAbsent: false };
                return (
                  <tr key={key}>
                    <td>{students[e.studentId] ?? e.studentId.slice(0, 8)}</td>
                    <td>{s.name}</td>
                    <td style={{ maxWidth: 90 }}><input value={r.totalMarks} onChange={(ev) => updateRow(key, { totalMarks: ev.target.value })} /></td>
                    <td style={{ maxWidth: 90 }}><input value={r.marksObtained} disabled={r.isAbsent} onChange={(ev) => updateRow(key, { marksObtained: ev.target.value })} /></td>
                    <td><input type="checkbox" checked={r.isAbsent} onChange={(ev) => updateRow(key, { isAbsent: ev.target.checked })} /></td>
                  </tr>
                );
              }))}
            </tbody>
          </table>
          <div className="inline-form">
            <button onClick={save}>Save marks</button>
            {saveMsg && <span className="muted">{saveMsg}</span>}
          </div>
        </>
      )}
      {sectionId && enrollments.length === 0 && <p className="muted">No active students in this section.</p>}
    </div>
  );
}

function ResultsPanel({ examId, subjects, students, onClose }: { examId: string; subjects: Subject[]; students: Record<string, string>; onClose: () => void }) {
  const [results, setResults] = useState<ExamResult[] | null>(null);
  useEffect(() => { apiGet<ExamResult[]>(`/exams/${examId}/results`).then(setResults).catch(() => setResults([])); }, [examId]);
  const subjectName = (id: string) => subjects.find((s) => s.id === id)?.name ?? id.slice(0, 8);

  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0, fontSize: 17 }}>Results</h2>
        <button className="ghost small" onClick={onClose}>Close</button>
      </div>
      {results === null ? <p className="muted">Loading…</p> : results.length === 0 ? <p className="muted">No results entered yet.</p> : (
        <table>
          <thead><tr><th>Student</th><th>Subject</th><th>Marks</th><th>Status</th></tr></thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.id}>
                <td>{students[r.enrollment?.studentId ?? ''] ?? r.enrollment?.studentId?.slice(0, 8)}</td>
                <td>{r.subject?.name ?? subjectName(r.subjectId)}</td>
                <td>{r.isAbsent ? '—' : `${r.marksObtained} / ${r.totalMarks}`}</td>
                <td>{r.isAbsent ? <span className="badge bad">absent</span> : <span className="badge ok">recorded</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ReportCardsCard({ terms, onAction }: { terms: Term[]; onAction: ActionFn }) {
  const [termId, setTermId] = useState('');
  const [cards, setCards] = useState<ReportCard[] | null>(null);

  async function load() {
    if (!termId) { setCards(null); return; }
    setCards(await apiGet<ReportCard[]>(`/terms/${termId}/report-cards`));
  }
  useEffect(() => { load().catch(() => {}); }, [termId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>Report cards</h2>
      <div className="inline-form">
        <div style={{ minWidth: 220 }}><label>Term</label>
          <select value={termId} onChange={(e) => setTermId(e.target.value)}>
            <option value="">Select…</option>{terms.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <button onClick={() => onAction(async () => { await apiPost(`/terms/${termId}/report-cards/generate`); await load(); }, 'Report cards generated')} disabled={!termId}>Generate</button>
      </div>
      {cards && (cards.length === 0 ? <p className="muted">No report cards generated yet.</p> : (
        <table>
          <thead><tr><th>Enrollment</th><th>Overall %</th><th>Grade</th><th>Section rank</th></tr></thead>
          <tbody>
            {cards.map((c) => (
              <tr key={c.id}>
                <td>{c.enrollmentId.slice(0, 8)}</td>
                <td>{c.overallPercent}</td>
                <td>{c.gradeLabel}</td>
                <td>{c.sectionRank ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}
