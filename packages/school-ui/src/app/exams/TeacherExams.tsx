'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  api, apiGet, apiPost, ApiError,
  type Exam, type ExamResult, type RosterRow, type TeacherClass, type Term,
} from '@sw/api-client';

/**
 * Teacher-scoped Exams screen. Unlike the admin console (subjects/terms/exam creation/
 * grade scale/report cards — all OWNER/CAMPUS_ADMIN-only), a teacher's only exam action is
 * entering marks for a (section, subject) they're assigned to. This view walks that path:
 * pick one of your subject assignments → pick an open exam for that class → mark the roster.
 * Every call here is a teacher-permitted endpoint; the API still enforces the assignment
 * (§22.8) on save, so this is UI scoping, not the security boundary.
 */
export default function TeacherExams() {
  const [assignments, setAssignments] = useState<TeacherClass[] | null>(null);
  const [terms, setTerms] = useState<Record<string, string>>({});
  const [assignmentId, setAssignmentId] = useState('');
  const [exams, setExams] = useState<Exam[] | null>(null);
  const [examId, setExamId] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api.teaching.myClasses()
      // Only subject assignments are markable — a class-teacher (subjectId null) enters no marks.
      .then((cs) => {
        const markable = cs.filter((c) => c.subjectId && c.classId);
        setAssignments(markable);
        // Deep-link from "My Classes" (/exams?assignmentId=…): preselect it if it's markable.
        const aid = new URLSearchParams(window.location.search).get('assignmentId');
        if (aid && markable.some((c) => c.assignmentId === aid)) setAssignmentId(aid);
      })
      .catch(() => setAssignments([]));
    apiGet<Term[]>('/terms').then((ts) => setTerms(Object.fromEntries(ts.map((t) => [t.id, t.name])))).catch(() => {});
  }, []);

  const assignment = useMemo(
    () => assignments?.find((a) => a.assignmentId === assignmentId) ?? null,
    [assignments, assignmentId],
  );

  // Load the class's exams whenever the chosen assignment changes.
  useEffect(() => {
    setExamId(''); setExams(null);
    if (!assignment?.classId) return;
    apiGet<Exam[]>(`/exams?classId=${assignment.classId}`).then(setExams).catch(() => setExams([]));
  }, [assignment?.classId]);

  const exam = exams?.find((e) => e.id === examId) ?? null;

  if (assignments === null) return <p className="muted">Loading…</p>;

  return (
    <div className="stack">
      <div>
        <h1 style={{ marginBottom: 4 }}>Marks entry</h1>
        <p className="muted" style={{ margin: 0 }}>Enter results for the subjects you teach. Only exams your campus admin has opened for marks entry can be edited.</p>
      </div>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {assignments.length === 0 ? (
        <div className="card"><p className="muted" style={{ margin: 0 }}>
          You aren’t assigned to teach any subject yet, so there are no marks to enter. Ask your campus admin to assign you a subject.
          {' '}Class-teacher rosters are under <strong>My Classes</strong>.
        </p></div>
      ) : (
        <div className="card stack">
          <div className="inline-form">
            <div style={{ minWidth: 260 }}><label>Class &amp; subject</label>
              <select value={assignmentId} onChange={(e) => setAssignmentId(e.target.value)}>
                <option value="">Select…</option>
                {assignments.map((a) => (
                  <option key={a.assignmentId} value={a.assignmentId}>
                    {a.className} — {a.sectionName} · {a.subjectName}
                  </option>
                ))}
              </select>
            </div>
            {assignment && (
              <div style={{ minWidth: 260 }}><label>Exam</label>
                <select value={examId} onChange={(e) => setExamId(e.target.value)}>
                  <option value="">Select…</option>
                  {(exams ?? []).map((ex) => (
                    <option key={ex.id} value={ex.id}>
                      {ex.name}{terms[ex.termId] ? ` · ${terms[ex.termId]}` : ''} — {statusLabel(ex.status)}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          {assignment && exams !== null && exams.length === 0 && (
            <p className="muted" style={{ margin: 0 }}>No exams have been created for this class yet.</p>
          )}

          {assignment && exam && (
            <MarksGrid
              exam={exam}
              sectionId={assignment.sectionId}
              subjectId={assignment.subjectId as string}
              subjectName={assignment.subjectName ?? ''}
              onMsg={setMsg}
            />
          )}
        </div>
      )}
    </div>
  );
}

function statusLabel(s: string): string {
  if (s === 'MARKS_ENTRY') return 'open for marks';
  if (s === 'PUBLISHED') return 'published';
  if (s === 'DRAFT') return 'not open yet';
  return s;
}

type Row = { totalMarks: string; marksObtained: string; isAbsent: boolean };

function MarksGrid({
  exam, sectionId, subjectId, subjectName, onMsg,
}: {
  exam: Exam;
  sectionId: string;
  subjectId: string;
  subjectName: string;
  onMsg: (m: { ok: boolean; text: string }) => void;
}) {
  const [roster, setRoster] = useState<RosterRow[] | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [defaultTotal, setDefaultTotal] = useState('100');
  const [busy, setBusy] = useState(false);

  const editable = exam.status === 'MARKS_ENTRY';
  const locked = exam.status === 'PUBLISHED';

  // Reload the roster + any already-saved marks for this (exam, section, subject).
  useEffect(() => {
    let alive = true;
    setRoster(null);
    (async () => {
      try {
        const [rs, results] = await Promise.all([
          api.teaching.roster(sectionId),
          apiGet<ExamResult[]>(`/exams/${exam.id}/results`),
        ]);
        if (!alive) return;
        const next: Record<string, Row> = {};
        for (const r of rs) {
          const found = results.find((x) => x.enrollmentId === r.enrollmentId && x.subjectId === subjectId);
          next[r.enrollmentId] = found
            ? { totalMarks: String(found.totalMarks), marksObtained: found.marksObtained != null ? String(found.marksObtained) : '', isAbsent: found.isAbsent }
            : { totalMarks: defaultTotal, marksObtained: '', isAbsent: false };
        }
        setRows(next);
        setRoster(rs);
      } catch {
        if (alive) { setRoster([]); }
      }
    })();
    return () => { alive = false; };
  }, [exam.id, sectionId, subjectId]); // eslint-disable-line react-hooks/exhaustive-deps

  function update(enrollmentId: string, patch: Partial<Row>) {
    setRows((prev) => ({ ...prev, [enrollmentId]: { ...prev[enrollmentId], ...patch } }));
  }

  async function save() {
    if (!roster) return;
    const records = roster.map((r) => {
      const row = rows[r.enrollmentId];
      return {
        enrollmentId: r.enrollmentId,
        subjectId,
        totalMarks: Number(row.totalMarks),
        isAbsent: row.isAbsent,
        ...(row.isAbsent ? {} : { marksObtained: Number(row.marksObtained) }),
      };
    });
    setBusy(true);
    try {
      const res = await apiPost<{ succeeded: number; failed: number }>(`/exams/${exam.id}/results/bulk`, { records });
      onMsg({ ok: res.failed === 0, text: `Saved ${res.succeeded}${res.failed ? `, ${res.failed} failed` : ''}` });
    } catch (e) {
      onMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to save marks' });
    } finally {
      setBusy(false);
    }
  }

  if (exam.status === 'DRAFT') {
    return <p className="muted">This exam isn’t open for marks entry yet. Your campus admin needs to open it first.</p>;
  }
  if (roster === null) return <p className="muted">Loading roster…</p>;
  if (roster.length === 0) return <p className="muted">No active students in this section.</p>;

  return (
    <div className="stack">
      <div className="row">
        <h2 style={{ margin: 0, fontSize: 16 }}>{subjectName} — {exam.name}{locked && <span className="badge ok" style={{ marginLeft: 8 }}>published</span>}</h2>
        {editable && (
          <div className="inline-form" style={{ margin: 0 }}>
            <div style={{ maxWidth: 110 }}><label>Default total</label>
              <input value={defaultTotal} onChange={(e) => setDefaultTotal(e.target.value)} /></div>
          </div>
        )}
      </div>
      <table>
        <thead><tr><th>Roll</th><th>Student</th><th>Total</th><th>Obtained</th><th>Absent</th></tr></thead>
        <tbody>
          {roster.map((r) => {
            const row = rows[r.enrollmentId] ?? { totalMarks: defaultTotal, marksObtained: '', isAbsent: false };
            return (
              <tr key={r.enrollmentId}>
                <td>{r.rollNumber ?? '—'}</td>
                <td>{r.fullName} <span className="muted" style={{ fontSize: 12 }}>({r.grNumber})</span></td>
                <td style={{ maxWidth: 90 }}><input value={row.totalMarks} disabled={!editable} onChange={(e) => update(r.enrollmentId, { totalMarks: e.target.value })} /></td>
                <td style={{ maxWidth: 90 }}><input value={row.isAbsent ? '' : row.marksObtained} disabled={!editable || row.isAbsent} onChange={(e) => update(r.enrollmentId, { marksObtained: e.target.value })} /></td>
                <td><input type="checkbox" checked={row.isAbsent} disabled={!editable} onChange={(e) => update(r.enrollmentId, { isAbsent: e.target.checked })} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {editable ? (
        <div><button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save marks'}</button></div>
      ) : locked ? (
        <p className="muted" style={{ margin: 0 }}>This exam is published — marks are read-only.</p>
      ) : null}
    </div>
  );
}
