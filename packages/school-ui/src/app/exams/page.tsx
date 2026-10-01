'use client';

import { humanizeStatus } from '@sw/ui';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  api, apiGet, apiPost, apiPut, ApiError,
  type AcademicYear, type Campus, type Exam, type ExamResult, type GradeBand,
  type Klass, type Paged, type Section, type Student, type Subject, type Term, type ReportCard,
} from '@sw/api-client';
import { classLabeller } from '@school/lib/labels';
import { useCampusLens, useMe } from '@sw/session';
import { hasAnyRole } from '@sw/roles';
import { EmptyState } from '@school/components/oversight';
import TeacherExams from './TeacherExams';

const EXAM_TYPES = ['MONTHLY', 'MID_TERM', 'FINAL', 'SURPRISE_TEST'];
const EXAM_TYPE_LABEL: Record<string, string> = {
  MONTHLY: 'Monthly', MID_TERM: 'Mid-term', FINAL: 'Final', SURPRISE_TEST: 'Surprise test',
};

// ── Pivot table types & helpers ──────────────────────────────────────────────

interface PivotRow {
  enrollmentId: string;
  student: string;
  grNumber: string;
  subjects: Record<string, { obtained: number | null; total: number; isAbsent: boolean }>;
  totalObtained: number;
  totalMax: number;
  percent: number;
  grade: string;
  rank: number;
}

function pivotResults(results: ExamResult[], gradeBands: GradeBand[]): { subjects: string[]; rows: PivotRow[] } {
  const subjectNames = [...new Set(results.map((r) => r.subject?.name ?? r.subjectId))].sort();
  const byStudent = new Map<string, { student: string; grNumber: string; marks: Map<string, { obtained: number | null; total: number; isAbsent: boolean }> }>();

  for (const r of results) {
    const eid = r.enrollmentId;
    const name = r.enrollment?.student?.fullName ?? eid.slice(0, 8);
    const gr = r.enrollment?.student?.grNumber ?? '';
    const subj = r.subject?.name ?? r.subjectId;
    if (!byStudent.has(eid)) byStudent.set(eid, { student: name, grNumber: gr, marks: new Map() });
    const entry = byStudent.get(eid)!;
    entry.marks.set(subj, {
      obtained: r.isAbsent || r.marksObtained == null ? null : Number(r.marksObtained),
      total: Number(r.totalMarks),
      isAbsent: r.isAbsent,
    });
  }

  const rows: PivotRow[] = [];
  for (const [eid, data] of byStudent) {
    const subjects: PivotRow['subjects'] = {};
    let totalObtained = 0;
    let totalMax = 0;
    for (const subj of subjectNames) {
      const m = data.marks.get(subj);
      subjects[subj] = m ?? { obtained: null, total: 0, isAbsent: true };
      if (m && m.obtained !== null) { totalObtained += m.obtained; totalMax += m.total; }
      else if (m) totalMax += m.total;
    }
    const percent = totalMax > 0 ? Math.round((totalObtained / totalMax) * 1000) / 10 : 0;
    const grade = gradeFor(gradeBands, percent);
    rows.push({ enrollmentId: eid, student: data.student, grNumber: data.grNumber, subjects, totalObtained, totalMax, percent, grade, rank: 0 });
  }

  rows.sort((a, b) => b.percent - a.percent || a.student.localeCompare(b.student));
  let rank = 0;
  let lastPct = -1;
  for (const row of rows) {
    if (row.percent !== lastPct) { rank++; lastPct = row.percent; }
    row.rank = rank;
  }

  return { subjects: subjectNames, rows };
}

function gradeFor(bands: GradeBand[], pct: number): string {
  for (const b of bands) {
    if (pct >= Number(b.minPercent) && pct <= Number(b.maxPercent)) return b.label;
  }
  return '-';
}

function pctColor(pct: number): string {
  if (pct >= 80) return 'var(--c-green, #16a34a)';
  if (pct >= 50) return 'var(--c-amber, #d97706)';
  return 'var(--c-red, #dc2626)';
}

function downloadCsv(filename: string, headers: string[], csvRows: string[][]) {
  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [headers.map(escape).join(','), ...csvRows.map((r) => r.map(escape).join(','))];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function ExamsPage() {
  const me = useMe();
  const isAdmin = hasAnyRole(me?.roles, ['OWNER_ADMIN', 'CAMPUS_ADMIN']);
  if (!isAdmin && me?.roles.includes('TEACHER')) return <TeacherExams />;
  return <ExamsAdminConsole />;
}

function ExamsAdminConsole() {
  const me = useMe();
  const lens = useCampusLens();
  const isOwner = hasAnyRole(me?.roles, ['OWNER_ADMIN']);
  const [tab, setTab] = useState<'exams' | 'setup'>('exams');
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [terms, setTerms] = useState<Term[]>([]);
  const [classes, setClasses] = useState<Klass[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [exams, setExams] = useState<Exam[]>([]);
  const [classFilter, setClassFilter] = useState('');
  const [termFilter, setTermFilter] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [gradeBands, setGradeBands] = useState<GradeBand[]>([]);

  async function reloadBase() {
    const [y, t, k, s, sub, cam] = await Promise.all([
      apiGet<AcademicYear[]>('/academic-years'),
      apiGet<Term[]>('/terms'),
      apiGet<Klass[]>('/classes'),
      apiGet<Section[]>('/sections'),
      apiGet<Subject[]>('/subjects'),
      apiGet<Campus[]>('/campuses').catch(() => [] as Campus[]),
    ]);
    setYears(y); setTerms(t); setClasses(k); setSections(s); setSubjects(sub); setCampuses(cam);
    const current = y.find((yr) => yr.isCurrent);
    if (current) apiGet<GradeBand[]>(`/grade-scales?academicYearId=${current.id}`).then(setGradeBands).catch(() => {});
  }
  async function reloadExams() {
    const q = new URLSearchParams();
    if (classFilter) q.set('classId', classFilter);
    if (termFilter) q.set('termId', termFilter);
    if (lens.campusId) q.set('campusId', lens.campusId);
    const qs = q.toString();
    setExams(await apiGet<Exam[]>(`/exams${qs ? `?${qs}` : ''}`));
  }
  const classLabel = classLabeller(classes, campuses);

  useEffect(() => { reloadBase().catch(() => {}); }, []);
  useEffect(() => { reloadExams().catch(() => {}); }, [classFilter, termFilter, lens.campusId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Group exams: campus → class
  const examsByCampus = useMemo(() => {
    const byClass = new Map<string, Exam[]>();
    for (const ex of exams) {
      const list = byClass.get(ex.classId) ?? [];
      list.push(ex);
      byClass.set(ex.classId, list);
    }
    const byCampus = new Map<string, { campusName: string; classes: { classId: string; className: string; items: Exam[] }[] }>();
    for (const [classId, items] of byClass) {
      const klass = classes.find((c) => c.id === classId);
      const campusId = klass?.campusId ?? '';
      const campus = campuses.find((c) => c.id === campusId);
      const campusName = campus?.name ?? 'Other';
      if (!byCampus.has(campusId)) byCampus.set(campusId, { campusName, classes: [] });
      byCampus.get(campusId)!.classes.push({
        classId,
        className: klass?.name ?? classId.slice(0, 8),
        items: items.sort((a, b) => new Date(b.examDate).getTime() - new Date(a.examDate).getTime()),
      });
    }
    return [...byCampus.values()]
      .map((g) => ({ ...g, classes: g.classes.sort((a, b) => a.className.localeCompare(b.className)) }))
      .sort((a, b) => a.campusName.localeCompare(b.campusName));
  }, [exams, classes, campuses]); // eslint-disable-line react-hooks/exhaustive-deps
  const showCampusHeaders = examsByCampus.length > 1;

  return (
    <div className="stack">
      <div className="ov-head">
        <div>
          <h1 style={{ margin: 0 }}>Exams & Results</h1>
          <p className="ov-lede">Create exams, enter marks, view results and generate report cards.</p>
        </div>
        <div className="ov-tab-bar" style={{ display: 'flex', gap: 4, background: 'var(--bg-raised, #edf0f5)', padding: 4, borderRadius: 10 }}>
          <button type="button" className={`ov-tab${tab === 'exams' ? ' is-active' : ''}`} onClick={() => setTab('exams')}>Exams</button>
          <button type="button" className={`ov-tab${tab === 'setup' ? ' is-active' : ''}`} onClick={() => setTab('setup')}>Setup</button>
        </div>
      </div>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`} role="alert">{msg.text}</div>}

      {tab === 'setup' && (
        <>
          <SubjectsCard subjects={subjects} classes={classes} />
          <GradeScaleCard years={years} onSaved={(ok, text) => setMsg({ ok, text })} />
          <TermsCard years={years} terms={terms}
            onCreate={(b) => run(() => apiPost('/terms', b), 'Term created', reloadBase)}
            onDelete={async (t) => { await run(() => api.terms.remove(t.id), `Deleted "${t.name}"`, reloadBase); }} />
        </>
      )}

      {tab === 'exams' && (
        <>
          {/* Filters + create */}
          <div className="card stack">
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <div className="inline-form" style={{ flex: 1 }}>
                <div><label>Class</label>
                  <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)}>
                    <option value="">All</option>{classes.map((c) => <option key={c.id} value={c.id}>{classLabel(c)}</option>)}
                  </select>
                </div>
                <div><label>Term</label>
                  <select value={termFilter} onChange={(e) => setTermFilter(e.target.value)}>
                    <option value="">All</option>{terms.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
              </div>
              {!isOwner && (
                <button className="ghost" onClick={() => setShowCreate((v) => !v)}>
                  {showCreate ? 'Cancel' : '+ Create exam'}
                </button>
              )}
            </div>

            {showCreate && (
              <NewExam terms={terms} classes={classes} classLabel={classLabel}
                onCreate={async (b) => {
                  const ok = await run(() => apiPost('/exams', { ...b, weightagePercent: Number(b.weightagePercent) }), 'Exam created', reloadExams);
                  if (ok) setShowCreate(false);
                }} />
            )}
          </div>

          {/* Exam cards grouped by campus → class */}
          {examsByCampus.length === 0 ? (
            <div className="card">
              <EmptyState title="No exams yet">
                {isOwner ? 'Your campus admin creates exams from this screen.' : 'Click "+ Create exam" to add one.'}
              </EmptyState>
            </div>
          ) : (
            examsByCampus.map((campus) => (
              <div key={campus.campusName} className="stack" style={{ gap: 12 }}>
                {showCampusHeaders && (
                  <h2 style={{ margin: '8px 0 0', fontSize: 15, fontWeight: 700, color: 'var(--text-muted, #6b7280)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    {campus.campusName}
                  </h2>
                )}
                {campus.classes.map((group) => (
                  <ExamClassGroup key={group.classId} className={group.className} exams={group.items}
                    termName={termName} sections={sections} subjects={subjects} gradeBands={gradeBands}
                    isOwner={isOwner} onAction={run} onReload={reloadExams} />
                ))}
              </div>
            ))
          )}

          <ReportCardsCard terms={terms} onAction={run} />
        </>
      )}
    </div>
  );
}

// ── Exam cards grouped by class ──────────────────────────────────────────────

function ExamClassGroup({ className, exams, termName, sections, subjects, gradeBands, isOwner, onAction, onReload }: {
  className: string;
  exams: Exam[];
  termName: (id: string) => string;
  sections: Section[];
  subjects: Subject[];
  gradeBands: GradeBand[];
  isOwner: boolean;
  onAction: ActionFn;
  onReload: () => Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const published = exams.filter((e) => e.status === 'PUBLISHED').length;
  const total = exams.length;

  return (
    <div className="card stack" style={{ gap: 0 }}>
      <div className="row" onClick={() => setCollapsed(!collapsed)}
        style={{ cursor: 'pointer', padding: '12px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0)', transition: 'transform 0.15s' }}>▼</span>
          <h2 style={{ margin: 0, fontSize: 16, color: 'var(--text, #1a1a1a)' }}>{className}</h2>
          <span className="badge" style={{ fontSize: 12 }}>{total} exam{total !== 1 ? 's' : ''}</span>
          {published > 0 && <span className="badge ok" style={{ fontSize: 12 }}>{published} published</span>}
        </div>
      </div>
      {!collapsed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {exams.map((ex) => (
            <ExamCard key={ex.id} exam={ex} termName={termName(ex.termId)}
              sections={sections.filter((s) => s.classId === ex.classId)}
              subjects={subjects.filter((s) => s.classId === ex.classId)}
              gradeBands={gradeBands} isOwner={isOwner} onAction={onAction} onReload={onReload} />
          ))}
        </div>
      )}
    </div>
  );
}

function ExamCard({ exam, termName, sections, subjects, gradeBands, isOwner, onAction, onReload }: {
  exam: Exam;
  termName: string;
  sections: Section[];
  subjects: Subject[];
  gradeBands: GradeBand[];
  isOwner: boolean;
  onAction: ActionFn;
  onReload: () => Promise<void>;
}) {
  const [open, setOpen] = useState<'marks' | 'results' | null>(null);
  const badge = (s: string) => (s === 'PUBLISHED' ? 'ok' : s === 'MARKS_ENTRY' ? 'warn' : '');
  const act = (fn: () => Promise<unknown>, ok: string) => onAction(fn, ok, onReload);

  return (
    <div style={{ borderTop: '1px solid var(--border, #e5e7eb)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{exam.name}</span>
            <span className={`badge ${badge(exam.status)}`} style={{ fontSize: 11 }}>{humanizeStatus(exam.status)}</span>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            {termName} · {EXAM_TYPE_LABEL[exam.examType] ?? exam.examType} · {exam.weightagePercent}% · {new Date(exam.examDate).toLocaleDateString('en-GB')}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {exam.status === 'PUBLISHED' && (
            <button className={open === 'results' ? 'small' : 'ghost small'} onClick={() => setOpen(open === 'results' ? null : 'results')}>
              {open === 'results' ? 'Hide results' : 'View results'}
            </button>
          )}
          {exam.status !== 'PUBLISHED' && exam.status !== 'DRAFT' && (
            <button className="ghost small" onClick={() => setOpen(open === 'results' ? null : 'results')}>Results</button>
          )}
          {exam.status === 'DRAFT' && (
            <button className="ghost small" onClick={() => act(() => apiPost(`/exams/${exam.id}/open-marks-entry`), 'Marks entry opened')}>Open marks entry</button>
          )}
          {exam.status !== 'DRAFT' && !isOwner && (
            <button className="ghost small" onClick={() => setOpen(open === 'marks' ? null : 'marks')}>
              {open === 'marks' ? 'Hide marks' : 'Enter marks'}
            </button>
          )}
          {exam.status === 'MARKS_ENTRY' && !isOwner && (
            <button className="small" onClick={() => act(() => apiPost(`/exams/${exam.id}/publish`), 'Exam published')}>Publish</button>
          )}
        </div>
      </div>

      {open === 'results' && (
        <ResultsPivotPanel examId={exam.id} gradeBands={gradeBands} examName={exam.name} onClose={() => setOpen(null)} />
      )}
      {open === 'marks' && (
        <MarksEntryPanel exam={exam} sections={sections} subjects={subjects}
          onAction={onAction} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

// ── Results pivot table ──────────────────────────────────────────────────────

function ResultsPivotPanel({ examId, gradeBands, examName, onClose }: {
  examId: string; gradeBands: GradeBand[]; examName: string; onClose: () => void;
}) {
  const [results, setResults] = useState<ExamResult[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    apiGet<ExamResult[]>(`/exams/${examId}/results`).then(setResults).catch(() => setResults([]));
  }, [examId]);

  const pivot = useMemo(() => (results ? pivotResults(results, gradeBands) : null), [results, gradeBands]);

  const filtered = useMemo(() => {
    if (!pivot) return null;
    if (!search.trim()) return pivot.rows;
    const q = search.toLowerCase();
    return pivot.rows.filter((r) => r.student.toLowerCase().includes(q) || r.grNumber.toLowerCase().includes(q));
  }, [pivot, search]);

  if (results === null) return <div style={{ padding: '16px 0' }}><p className="muted">Loading results…</p></div>;
  if (!pivot || pivot.rows.length === 0) return (
    <div style={{ padding: '16px 0' }}>
      <EmptyState title="No results entered yet">Marks need to be entered before results appear here.</EmptyState>
      <div style={{ textAlign: 'right', paddingTop: 8 }}><button className="ghost small" onClick={onClose}>Close</button></div>
    </div>
  );

  const avgBySubject = pivot.subjects.map((subj) => {
    let sum = 0; let count = 0;
    for (const row of pivot.rows) {
      const m = row.subjects[subj];
      if (m && m.obtained !== null && m.total > 0) { sum += (m.obtained / m.total) * 100; count++; }
    }
    return count > 0 ? Math.round(sum / count) : null;
  });
  const overallAvg = pivot.rows.length > 0 ? Math.round(pivot.rows.reduce((s, r) => s + r.percent, 0) / pivot.rows.length * 10) / 10 : 0;
  const passed = pivot.rows.filter((r) => r.percent >= 40).length;

  function exportCsv() {
    if (!pivot) return;
    const headers = ['Rank', 'Student', 'GR No.', ...pivot.subjects, 'Total', 'Percentage', 'Grade'];
    const csvRows = pivot.rows.map((r) => [
      String(r.rank), r.student, r.grNumber,
      ...pivot.subjects.map((s) => { const m = r.subjects[s]; return m?.isAbsent ? 'ABS' : m?.obtained !== null ? `${m.obtained}/${m.total}` : '-'; }),
      `${r.totalObtained}/${r.totalMax}`, `${r.percent}%`, r.grade,
    ]);
    downloadCsv(`${examName.replace(/[^a-z0-9]+/gi, '-')}-results.csv`, headers, csvRows);
  }

  return (
    <div style={{ padding: '12px 0' }} className="stack">
      {/* Summary bar */}
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center', padding: '8px 12px', background: 'var(--bg-raised, #f8f9fb)', borderRadius: 8 }}>
        <div>
          <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Students</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{pivot.rows.length}</div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Passed</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--c-green, #16a34a)' }}>{passed}</div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Class average</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: pctColor(overallAvg) }}>{overallAvg}%</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="search" placeholder="Search student…" value={search} onChange={(e) => setSearch(e.target.value)}
            style={{ width: 180, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border, #d1d5db)', fontSize: 13 }} />
          <button className="ghost small" onClick={exportCsv}>Export CSV</button>
          <button className="ghost small" onClick={onClose}>Close</button>
        </div>
      </div>

      {/* Pivot table */}
      <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid var(--border, #e5e7eb)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--bg-raised, #f8f9fb)', position: 'sticky', top: 0, zIndex: 1 }}>
              <th style={{ ...thStyle, position: 'sticky', left: 0, background: 'var(--bg-raised, #f8f9fb)', zIndex: 2, minWidth: 40, textAlign: 'center' }}>#</th>
              <th style={{ ...thStyle, position: 'sticky', left: 40, background: 'var(--bg-raised, #f8f9fb)', zIndex: 2, minWidth: 180 }}>Student</th>
              {pivot.subjects.map((s) => <th key={s} style={{ ...thStyle, textAlign: 'center', minWidth: 70 }}>{s}</th>)}
              <th style={{ ...thStyle, textAlign: 'center', minWidth: 80 }}>Total</th>
              <th style={{ ...thStyle, textAlign: 'center', minWidth: 60 }}>%</th>
              <th style={{ ...thStyle, textAlign: 'center', minWidth: 60 }}>Grade</th>
            </tr>
          </thead>
          <tbody>
            {(filtered ?? []).map((row, i) => (
              <PivotStudentRow key={row.enrollmentId} row={row} subjects={pivot.subjects} index={i}
                isExpanded={expanded === row.enrollmentId} onToggle={() => setExpanded(expanded === row.enrollmentId ? null : row.enrollmentId)}
                gradeBands={gradeBands} />
            ))}
          </tbody>
          <tfoot>
            <tr style={{ background: 'var(--bg-raised, #f8f9fb)', fontWeight: 600, fontSize: 12 }}>
              <td style={tdStyle}></td>
              <td style={{ ...tdStyle, position: 'sticky', left: 40, background: 'var(--bg-raised, #f8f9fb)' }}>Class average</td>
              {avgBySubject.map((avg, i) => (
                <td key={i} style={{ ...tdStyle, textAlign: 'center', color: avg !== null ? pctColor(avg) : undefined }}>{avg !== null ? `${avg}%` : '-'}</td>
              ))}
              <td style={tdStyle}></td>
              <td style={{ ...tdStyle, textAlign: 'center', color: pctColor(overallAvg) }}>{overallAvg}%</td>
              <td style={tdStyle}></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = { padding: '8px 10px', borderBottom: '2px solid var(--border, #e5e7eb)', textAlign: 'left', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' };
const tdStyle: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid var(--border-light, #f0f0f0)' };

function PivotStudentRow({ row, subjects, index, isExpanded, onToggle, gradeBands }: {
  row: PivotRow; subjects: string[]; index: number; isExpanded: boolean; onToggle: () => void; gradeBands: GradeBand[];
}) {
  const bg = index % 2 === 0 ? 'transparent' : 'var(--row-alt, #fafbfc)';
  return (
    <>
      <tr style={{ background: bg, cursor: 'pointer' }} onClick={onToggle} title="Click for details">
        <td style={{ ...tdStyle, position: 'sticky', left: 0, background: bg, textAlign: 'center', fontWeight: 600, color: 'var(--text-muted)' }}>{row.rank}</td>
        <td style={{ ...tdStyle, position: 'sticky', left: 40, background: bg, fontWeight: 500 }}>
          <span>{row.student}</span>
          <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{row.grNumber}</span>
        </td>
        {subjects.map((subj) => {
          const m = row.subjects[subj];
          const isAbsent = m?.isAbsent;
          const pct = m && m.obtained !== null && m.total > 0 ? (m.obtained / m.total) * 100 : null;
          return (
            <td key={subj} style={{ ...tdStyle, textAlign: 'center' }}>
              {isAbsent ? <span className="badge bad" style={{ fontSize: 10 }}>ABS</span>
                : m?.obtained !== null ? (
                  <span style={{ color: pct !== null && pct < 40 ? 'var(--c-red, #dc2626)' : undefined, fontWeight: pct !== null && pct >= 90 ? 700 : 400 }}>
                    {m.obtained}<span className="muted" style={{ fontSize: 11 }}>/{m.total}</span>
                  </span>
                ) : <span className="muted">-</span>}
            </td>
          );
        })}
        <td style={{ ...tdStyle, textAlign: 'center', fontWeight: 600 }}>
          {row.totalObtained}<span className="muted" style={{ fontSize: 11 }}>/{row.totalMax}</span>
        </td>
        <td style={{ ...tdStyle, textAlign: 'center', fontWeight: 700, color: pctColor(row.percent) }}>{row.percent}%</td>
        <td style={{ ...tdStyle, textAlign: 'center' }}><span className="badge" style={{ fontSize: 11 }}>{row.grade}</span></td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={subjects.length + 4} style={{ padding: 0, background: 'var(--bg-raised, #f7f8fa)' }}>
            <StudentDetailCard row={row} subjects={subjects} gradeBands={gradeBands} />
          </td>
        </tr>
      )}
    </>
  );
}

function StudentDetailCard({ row, subjects, gradeBands }: { row: PivotRow; subjects: string[]; gradeBands: GradeBand[] }) {
  return (
    <div style={{ padding: '14px 20px 14px 52px', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 2 }}>{row.student}</div>
        <div className="muted" style={{ fontSize: 12 }}>GR: {row.grNumber}</div>
        <div style={{ marginTop: 8, display: 'flex', gap: 16 }}>
          <div>
            <div className="muted" style={{ fontSize: 11 }}>Overall</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: pctColor(row.percent) }}>{row.percent}%</div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 11 }}>Grade</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{row.grade}</div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 11 }}>Rank</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>#{row.rank}</div>
          </div>
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 240 }}>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, fontSize: 11 }}>Subject</th>
              <th style={{ ...thStyle, fontSize: 11, textAlign: 'center' }}>Marks</th>
              <th style={{ ...thStyle, fontSize: 11, textAlign: 'center' }}>%</th>
              <th style={{ ...thStyle, fontSize: 11, textAlign: 'center' }}>Grade</th>
            </tr>
          </thead>
          <tbody>
            {subjects.map((subj) => {
              const m = row.subjects[subj];
              const pct = m && m.obtained !== null && m.total > 0 ? Math.round((m.obtained / m.total) * 100) : null;
              return (
                <tr key={subj}>
                  <td style={tdStyle}>{subj}</td>
                  <td style={{ ...tdStyle, textAlign: 'center' }}>
                    {m?.isAbsent ? <span className="badge bad" style={{ fontSize: 10 }}>ABS</span>
                      : m?.obtained !== null ? `${m.obtained} / ${m.total}` : '-'}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'center', color: pct !== null ? pctColor(pct) : undefined, fontWeight: 600 }}>
                    {pct !== null ? `${pct}%` : '-'}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'center' }}>
                    {pct !== null ? <span className="badge" style={{ fontSize: 10 }}>{gradeFor(gradeBands, pct)}</span> : '-'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Marks entry (pivot grid) ─────────────────────────────────────────────────

function MarksEntryPanel({ exam, sections, subjects, onAction, onClose }: {
  exam: Exam;
  sections: Section[];
  subjects: Subject[];
  onAction: ActionFn;
  onClose: () => void;
}) {
  const [sectionId, setSectionId] = useState('');
  const [enrollments, setEnrollments] = useState<Array<{ id: string; studentId: string; student?: { fullName: string; grNumber: string } }>>([]);
  const [defaultTotal, setDefaultTotal] = useState('100');
  const [rows, setRows] = useState<Record<string, { totalMarks: string; marksObtained: string; isAbsent: boolean }>>({});
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [dirty, setDirty] = useState(new Set<string>());

  async function loadRoster() {
    if (!sectionId) return;
    const enr = await apiGet<{ data: Array<{ id: string; studentId: string; student?: { fullName: string; grNumber: string } }> }>(`/enrollments?sectionId=${sectionId}&status=ACTIVE`);
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
    setRows(next);
    setEnrollments(enr.data);
    setDirty(new Set());
  }

  function updateRow(key: string, patch: Partial<{ totalMarks: string; marksObtained: string; isAbsent: boolean }>) {
    setRows((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
    setDirty((prev) => new Set(prev).add(key.split(':')[0]));
  }

  function toggleAbsent(enrollmentId: string, isAbsent: boolean) {
    setRows((prev) => {
      const next = { ...prev };
      for (const s of subjects) {
        const key = `${enrollmentId}:${s.id}`;
        if (next[key]) next[key] = { ...next[key], isAbsent };
      }
      return next;
    });
    setDirty((prev) => new Set(prev).add(enrollmentId));
  }

  async function save() {
    const records = enrollments.flatMap((e) =>
      subjects.map((s) => {
        const key = `${e.id}:${s.id}`;
        const r = rows[key];
        return {
          enrollmentId: e.id, subjectId: s.id, totalMarks: Number(r.totalMarks),
          isAbsent: r.isAbsent, ...(r.isAbsent ? {} : { marksObtained: Number(r.marksObtained) }),
        };
      }),
    );
    setSaveMsg(null);
    await onAction(async () => {
      const res = await apiPost<{ succeeded: number; failed: number }>(`/exams/${exam.id}/results/bulk`, { records });
      setSaveMsg(`Saved ${res.succeeded}${res.failed ? `, ${res.failed} failed` : ''}`);
      setDirty(new Set());
    }, 'Marks saved');
  }

  return (
    <div className="stack" style={{ padding: '12px 0', borderTop: '1px solid var(--border, #e5e7eb)' }}>
      <div className="row">
        <h3 style={{ margin: 0, fontSize: 15 }}>Enter marks — {exam.name}</h3>
        <button className="ghost small" onClick={onClose}>Close</button>
      </div>
      {subjects.length === 0 && <p className="muted">No subjects defined for this class yet.</p>}
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
          <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid var(--border, #e5e7eb)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--bg-raised, #f8f9fb)', position: 'sticky', top: 0 }}>
                  <th style={{ ...thStyle, position: 'sticky', left: 0, background: 'var(--bg-raised, #f8f9fb)', zIndex: 2, minWidth: 180 }}>Student</th>
                  {subjects.map((s) => (
                    <th key={s.id} style={{ ...thStyle, textAlign: 'center', minWidth: 80 }}>{s.name}<br /><span className="muted" style={{ fontWeight: 400, fontSize: 10 }}>/ {defaultTotal}</span></th>
                  ))}
                  <th style={{ ...thStyle, textAlign: 'center', minWidth: 60 }}>Absent</th>
                </tr>
              </thead>
              <tbody>
                {enrollments.map((e, i) => {
                  const isDirty = dirty.has(e.id);
                  const bg = isDirty ? 'var(--bg-dirty, #fffbeb)' : i % 2 === 0 ? 'transparent' : 'var(--row-alt, #fafbfc)';
                  const firstKey = `${e.id}:${subjects[0]?.id}`;
                  const isAbsent = rows[firstKey]?.isAbsent ?? false;
                  return (
                    <tr key={e.id} style={{ background: bg }}>
                      <td style={{ ...tdStyle, position: 'sticky', left: 0, background: bg, fontWeight: 500 }}>
                        {e.student ? `${e.student.fullName}` : e.studentId.slice(0, 8)}
                        {e.student?.grNumber && <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>({e.student.grNumber})</span>}
                      </td>
                      {subjects.map((s) => {
                        const key = `${e.id}:${s.id}`;
                        const r = rows[key] ?? { totalMarks: defaultTotal, marksObtained: '', isAbsent: false };
                        return (
                          <td key={key} style={{ ...tdStyle, textAlign: 'center', padding: '4px 6px' }}>
                            <input value={r.isAbsent ? '' : r.marksObtained} disabled={r.isAbsent}
                              onChange={(ev) => updateRow(key, { marksObtained: ev.target.value })}
                              style={{ width: 50, textAlign: 'center', padding: '3px', borderRadius: 4, border: '1px solid var(--border, #d1d5db)', fontSize: 13, background: r.isAbsent ? 'var(--bg-raised, #f0f0f0)' : 'white' }}
                              tabIndex={0} />
                          </td>
                        );
                      })}
                      <td style={{ ...tdStyle, textAlign: 'center' }}>
                        <input type="checkbox" checked={isAbsent} onChange={(ev) => toggleAbsent(e.id, ev.target.checked)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ position: 'sticky', bottom: 0, background: 'white', padding: '8px 0', borderTop: '1px solid var(--border, #e5e7eb)' }}>
            <button onClick={save} disabled={dirty.size === 0 && !saveMsg}>Save marks</button>
            {saveMsg && <span className="muted" style={{ fontSize: 13 }}>{saveMsg}</span>}
            {dirty.size > 0 && <span className="muted" style={{ fontSize: 12 }}>{dirty.size} student{dirty.size > 1 ? 's' : ''} changed</span>}
          </div>
        </>
      )}
      {sectionId && enrollments.length === 0 && <p className="muted">No active students in this section.</p>}
    </div>
  );
}

// ── Report cards ─────────────────────────────────────────────────────────────

interface ReportCardWithStudent extends ReportCard {
  enrollment?: {
    student?: { fullName: string; grNumber: string };
    class?: { name: string };
    section?: { name: string };
  };
}

function ReportCardsCard({ terms, onAction }: { terms: Term[]; onAction: ActionFn }) {
  const [termId, setTermId] = useState('');
  const [cards, setCards] = useState<ReportCardWithStudent[] | null>(null);

  async function load() {
    if (!termId) { setCards(null); return; }
    setCards(await apiGet<ReportCardWithStudent[]>(`/terms/${termId}/report-cards`));
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
        <button className="ghost" onClick={() => onAction(async () => { await apiPost(`/terms/${termId}/report-cards/generate`); await load(); }, 'Report cards generated')} disabled={!termId}>Generate</button>
      </div>
      {cards && (cards.length === 0 ? (
        <EmptyState title="No report cards generated yet">Select a term and click Generate after all exams are published.</EmptyState>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--bg-raised, #f8f9fb)' }}>
                <th style={thStyle}>Student</th>
                <th style={thStyle}>GR No.</th>
                <th style={thStyle}>Class</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>Overall %</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>Grade</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>Rank</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((c, i) => {
                const pct = Number(c.overallPercent);
                return (
                  <tr key={c.id} style={{ background: i % 2 === 0 ? 'transparent' : 'var(--row-alt, #fafbfc)' }}>
                    <td style={{ ...tdStyle, fontWeight: 500 }}>
                      {c.enrollment?.student?.fullName ?? c.enrollmentId.slice(0, 8)}
                    </td>
                    <td style={tdStyle}>{c.enrollment?.student?.grNumber ?? '-'}</td>
                    <td style={tdStyle} className="muted">
                      {c.enrollment?.class && c.enrollment?.section ? `${c.enrollment.class.name} ${c.enrollment.section.name}` : '-'}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'center', fontWeight: 700, color: pctColor(pct) }}>{pct}%</td>
                    <td style={{ ...tdStyle, textAlign: 'center' }}><span className="badge" style={{ fontSize: 11 }}>{c.gradeLabel}</span></td>
                    <td style={{ ...tdStyle, textAlign: 'center', fontWeight: 600 }}>{c.sectionRank ?? '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

// ── Setup tab (unchanged) ────────────────────────────────────────────────────

function SubjectsCard({ subjects, classes }: { subjects: Subject[]; classes: Klass[] }) {
  const nameFor = (id: string) => classes.find((c) => c.id === id)?.name ?? '?';
  const byClass = classes
    .map((c) => ({ c, items: subjects.filter((s) => s.classId === c.id) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0, fontSize: 17 }}>Subjects</h2>
        <Link className="ghost small" href="/classes" style={{ textDecoration: 'none' }}>Manage in Classes →</Link>
      </div>
      {byClass.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          No subjects yet — add them to a class on the <Link href="/classes">Classes</Link> screen.
        </p>
      ) : (
        byClass.map(({ c, items }) => (
          <div className="chips" key={c.id}>
            <span className="muted" style={{ fontSize: 12, minWidth: 62 }}>{nameFor(c.id)}</span>
            {items.map((s) => <span key={s.id} className="badge">{s.name}</span>)}
          </div>
        ))
      )}
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

function TermsCard({ years, terms, onCreate, onDelete }: {
  years: AcademicYear[]; terms: Term[];
  onCreate: (b: Record<string, string>) => void;
  onDelete: (t: Term) => Promise<void>;
}) {
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const yearName = (id: string) => years.find((y) => y.id === id)?.name ?? '?';

  async function remove(t: Term) {
    if (!window.confirm(`Delete the term "${t.name}"? This is blocked if it already has exams or report cards.`)) return;
    setBusy(t.id);
    try { await onDelete(t); } finally { setBusy(''); }
  }
  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0, fontSize: 17 }}>Terms</h2>
        {terms.length > 0 && <span className="badge">{terms.length}</span>}
      </div>
      {terms.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>None yet — add the first term below.</p>
      ) : (
        <div style={{ maxHeight: 260, overflowY: 'auto' }}>
          <table>
            <thead><tr><th>Term</th><th>Academic year</th><th>Dates</th><th></th></tr></thead>
            <tbody>
              {terms.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td className="muted">{yearName(t.academicYearId)}</td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {new Date(t.startDate).toLocaleDateString('en-GB')} – {new Date(t.endDate).toLocaleDateString('en-GB')}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="ghost small" disabled={busy === t.id}
                      onClick={() => remove(t)}>{busy === t.id ? '…' : 'Delete'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="inline-form">
        <div><label>Academic year</label>
          <select value={form.academicYearId ?? ''} onChange={(e) => setForm({ ...form, academicYearId: e.target.value })}>
            <option value="">Select…</option>{years.map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}
          </select>
        </div>
        <div><label>Name</label><input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Term 1" /></div>
        <div><label>Start</label><input type="date" value={form.startDate ?? ''} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></div>
        <div><label>End</label><input type="date" value={form.endDate ?? ''} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></div>
        <button className="ghost" onClick={() => onCreate(form)} disabled={!form.academicYearId || !form.name || !form.startDate || !form.endDate}>Add term</button>
      </div>
    </div>
  );
}

function NewExam({ terms, classes, classLabel, onCreate }: { terms: Term[]; classes: Klass[]; classLabel: (c: Klass) => string; onCreate: (b: Record<string, string>) => void }) {
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
          <option value="">Select…</option>{classes.map((c) => <option key={c.id} value={c.id}>{classLabel(c)}</option>)}
        </select>
      </div>
      <div><label>Name</label><input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Monthly test 1" /></div>
      <div><label>Type</label>
        <select value={form.examType} onChange={(e) => setForm({ ...form, examType: e.target.value })}>
          {EXAM_TYPES.map((t) => <option key={t} value={t}>{EXAM_TYPE_LABEL[t] ?? t}</option>)}
        </select>
      </div>
      <div style={{ maxWidth: 110 }}><label>Weightage %</label><input value={form.weightagePercent} onChange={(e) => setForm({ ...form, weightagePercent: e.target.value })} /></div>
      <div><label>Exam date</label><input type="date" value={form.examDate ?? ''} onChange={(e) => setForm({ ...form, examDate: e.target.value })} /></div>
      <button onClick={() => onCreate(form)} disabled={!form.termId || !form.classId || !form.name || !form.examDate}>Create exam</button>
    </div>
  );
}

type ActionFn = (fn: () => Promise<unknown>, ok: string, after?: () => Promise<unknown>) => Promise<boolean>;
