'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  api, apiGet, ApiError,
  PERFORMANCE_RANGES, RANGE_LABEL,
  type Campus, type ClassPerformance, type ClassStudents, type PerformanceRange, type StudentPerformance,
} from '@sw/api-client';
import {} from '@sw/session';
import { useCampusLens } from '@sw/session';
import { Metric } from '@sw/ui';

/**
 * Class-test performance: campus → class → student.
 *
 * Built around one fact: a 6,000-student school will never browse a roll. Each level shows tens
 * of rows, sorted worst-first, and hands off to the next — the job of a report at this size is to
 * answer "who needs me?", not to enumerate everyone. The time filter is set once and carried
 * through the whole drill-down, so changing it deep in a student's record and stepping back up
 * keeps the same window.
 */

/** A percentage with its trend. Absolute alone is a fact; with a trend it is a decision. */
function Score({ percent, trend }: { percent: number | null; trend?: number | null }) {
  if (percent == null) return <span className="muted">no tests</span>;
  const low = percent < 40;
  return (
    <span className="row" style={{ gap: 6, justifyContent: 'flex-start' }}>
      <b style={low ? { color: '#b91c1c' } : undefined}>{percent}%</b>
      {trend != null && trend !== 0 && (
        <span className="muted" style={{ fontSize: 12, color: trend > 0 ? '#15803d' : '#b91c1c' }}>
          {trend > 0 ? '▲' : '▼'} {Math.abs(trend)}
        </span>
      )}
    </span>
  );
}

export default function PerformancePage() {

  const [range, setRange] = useState<PerformanceRange>('1m');
  const lens = useCampusLens();
  const campusId = lens.campusId ?? '';
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [classes, setClasses] = useState<ClassPerformance[] | null>(null);
  const [classView, setClassView] = useState<ClassStudents | null>(null);
  const [student, setStudent] = useState<StudentPerformance | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiGet<Campus[]>('/campuses').then(setCampuses).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      // Whichever level is open reloads for the new range, so the filter feels global.
      if (student) setStudent(await api.performance.forStudent(student.studentId, range));
      else if (classView) setClassView(await api.performance.byStudent(classView.classId, range));
      else setClasses(await api.performance.byClass(range, campusId || undefined));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not load performance');
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, campusId, student?.studentId, classView?.classId]);

  useEffect(() => { load().catch(() => {}); }, [load]);

  const openClass = async (classId: string) => {
    setBusy(true);
    try { setClassView(await api.performance.byStudent(classId, range)); setStudent(null); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); }
    finally { setBusy(false); }
  };
  const openStudent = async (studentId: string) => {
    setBusy(true);
    try { setStudent(await api.performance.forStudent(studentId, range)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); }
    finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <div className="row">
        <h1>Performance</h1>
        {busy && <span className="muted" style={{ fontSize: 13 }}>Loading…</span>}
      </div>
      <p className="muted" style={{ margin: 0 }}>
        How classes and students are doing in class tests. Every figure is total marks obtained ÷
        total marks possible; a student absent for a test is left out of their average rather than
        scored zero.
      </p>

      {/* Breadcrumb doubles as the way back up — at this depth a browser back button is a guess. */}
      <div className="row" style={{ justifyContent: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
        <button className="ghost small" onClick={() => { setStudent(null); setClassView(null); }}>
          {campuses.find((c) => c.id === campusId)?.name ?? 'All campuses'}
        </button>
        {classView && (
          <>
            <span className="muted">▸</span>
            <button className="ghost small" onClick={() => setStudent(null)}>{classView.className}</button>
          </>
        )}
        {student && (<><span className="muted">▸</span><span><b>{student.fullName}</b></span></>)}
      </div>

      <div className="inline-form" style={{ alignItems: 'flex-end' }}>
        <div className="chips">
          {PERFORMANCE_RANGES.map((r) => (
            <button key={r} className={`chip ${range === r ? 'active' : ''}`} onClick={() => setRange(r)}>
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      </div>

      {err && <p className="error">{err}</p>}

      {student ? <StudentReport data={student} />
        : classView ? <ClassReport data={classView} onOpen={openStudent} />
        : <CampusReport rows={classes} onOpen={openClass} />}
    </div>
  );
}

/** Level 1 — every class, weakest first. */
function CampusReport({ rows, onOpen }: { rows: ClassPerformance[] | null; onOpen: (id: string) => void }) {
  if (!rows) return <p className="muted">Loading…</p>;
  if (!rows.length) return <p className="muted">No classes yet.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table>
        <thead><tr><th>Class</th><th>Students</th><th>Tests</th><th>Average</th><th>Missed</th><th></th></tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.classId}>
              <td><b>{c.className}</b></td>
              <td>{c.students}</td>
              <td>{c.testsTaken}</td>
              <td><Score percent={c.percent} trend={c.trend} /></td>
              <td>{c.testsMissed || '—'}</td>
              <td style={{ textAlign: 'right' }}>
                <button className="ghost small" onClick={() => onOpen(c.classId)}>View students →</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Level 2 — students in one class. */
function ClassReport({ data, onOpen }: { data: ClassStudents; onOpen: (id: string) => void }) {
  if (!data.students.length) return <p className="muted">No students enrolled in {data.className}.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table>
        <thead><tr><th>Student</th><th>GR</th><th>Tests</th><th>Missed</th><th>Average</th><th>Weakest</th><th></th></tr></thead>
        <tbody>
          {data.students.map((s) => (
            <tr key={s.studentId}>
              <td>{s.fullName}</td>
              <td>{s.grNumber}</td>
              <td>{s.testsTaken}</td>
              <td>{s.testsMissed || '—'}</td>
              <td><Score percent={s.percent} trend={s.trend} /></td>
              <td className="muted" style={{ fontSize: 13 }}>
                {s.weakestSubject ? `${s.weakestSubject.name} ${s.weakestSubject.percent}%` : '—'}
              </td>
              <td style={{ textAlign: 'right' }}>
                <button className="ghost small" onClick={() => onOpen(s.studentId)}>Report →</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Level 3 — one student, by subject and month. */
function StudentReport({ data }: { data: StudentPerformance }) {
  const monthLabel = (m: string) =>
    new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

  return (
    <div className="stack">
      <div className="grid">
        {/* Context, all four: this screen lists SUBJECTS, so there is no list of "12 tests" to
            open. Routed through <Metric> anyway, so the absence of a link is a stated decision
            rather than something nobody got round to. */}
        <Metric label="Average" value={data.overall.percent == null ? '—' : `${data.overall.percent}%`} />
        <Metric label="Tests taken" value={data.overall.testsTaken} />
        <Metric label="Tests missed" value={data.overall.testsMissed} alert={data.overall.testsMissed > 0} />
        <Metric label="Marks" value={`${data.overall.marksObtained}/${data.overall.marksTotal}`} />
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        {data.className ? `${data.className} ${data.sectionName ?? ''} · ` : ''}GR {data.grNumber}
      </p>

      {data.monthly.length > 0 && (
        <div className="card stack" style={{ gap: 8 }}>
          <strong style={{ fontSize: 14 }}>Month by month</strong>
          <div className="stack" style={{ gap: 4 }}>
            {data.monthly.map((m) => (
              <div key={m.month} className="row" style={{ gap: 10 }}>
                <span className="muted" style={{ minWidth: 90, fontSize: 13 }}>{monthLabel(m.month)}</span>
                {/* A bar rather than a number alone: a trend is read faster than it is computed. */}
                <span style={{ flex: 1, background: '#eef2ff', borderRadius: 4, height: 14, overflow: 'hidden' }}>
                  <span style={{
                    display: 'block', height: '100%', width: `${m.percent ?? 0}%`,
                    background: (m.percent ?? 0) < 40 ? '#dc2626' : '#4f46e5',
                  }} />
                </span>
                <span style={{ minWidth: 100, textAlign: 'right', fontSize: 13 }}>
                  {m.percent}% · {m.testsTaken} test{m.testsTaken === 1 ? '' : 's'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.subjects.length === 0 ? (
        <p className="muted">No class tests in this period.</p>
      ) : data.subjects.map((s) => (
        <div key={s.subjectId} className="card stack" style={{ gap: 8 }}>
          <div className="row">
            <strong style={{ fontSize: 14 }}>{s.subjectName}</strong>
            <span><Score percent={s.percent} /> <span className="muted" style={{ fontSize: 12 }}>
              · {s.testsTaken} taken{s.testsMissed ? `, ${s.testsMissed} missed` : ''}
            </span></span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>Test</th><th>Date</th><th>Marks</th><th>%</th></tr></thead>
              <tbody>
                {s.tests.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>{t.testDate.slice(0, 10)}</td>
                    <td>{t.isAbsent ? <span className="badge warn">absent</span> : `${t.marksObtained} / ${t.totalMarks}`}</td>
                    <td>{t.isAbsent ? '—' : `${Math.round(((t.marksObtained ?? 0) / t.totalMarks) * 100)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
