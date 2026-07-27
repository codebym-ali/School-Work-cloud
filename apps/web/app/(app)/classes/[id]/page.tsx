'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  api, apiGet, ApiError,
  type AcademicYear, type Campus, type Klass, type ManagedTeacher,
  type Section, type Subject, type TeacherAssignment,
} from '@/lib/api';

/**
 * One class, end to end: its sections, the subjects each section studies, and who teaches
 * each one — with assignment inline. Previously this was spread across Setup (structure)
 * and Staff (assignment, organised per PERSON), so "who teaches 9-A Maths?" could only be
 * answered by opening every teacher in the directory. This is the class-centric view.
 */
export default function ClassDetailPage() {
  const params = useParams();
  const router = useRouter();
  const classId = String(params?.id ?? '');

  const [klass, setKlass] = useState<Klass | null>(null);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [staff, setStaff] = useState<ManagedTeacher[]>([]);
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [k, c, sec, sub, st, y, a] = await Promise.all([
      apiGet<Klass[]>('/classes'),
      apiGet<Campus[]>('/campuses'),
      apiGet<Section[]>(`/sections?classId=${classId}`),
      api.subjects.list(classId),
      api.staff.list(),
      apiGet<AcademicYear[]>('/academic-years'),
      api.teacherAssignments.list(),
    ]);
    setKlass(k.find((x) => x.id === classId) ?? null);
    setCampuses(c); setSections(sec); setSubjects(sub); setStaff(st); setYears(y); setAssignments(a);
  }, [classId]);

  useEffect(() => { load().catch(() => {}).finally(() => setLoaded(true)); }, [load]);

  const currentYear = years.find((y) => y.isCurrent) ?? null;
  const teachers = useMemo(() => staff.filter((s) => s.staffType === 'TEACHER'), [staff]);
  const teacherName = (staffId: string) => {
    const t = staff.find((x) => x.id === staffId);
    return t?.fullName ?? t?.user.email ?? 'Unknown';
  };

  /** The assignment for one (section, subject) pair — subjectId null means class teacher. */
  const assignmentFor = (sectionId: string, subjectId: string | null) =>
    assignments.find((a) => a.sectionId === sectionId && (a.subjectId ?? null) === subjectId) ?? null;

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try { await fn(); await load(); setMsg({ ok: true, text: ok }); }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'That did not work' }); }
    finally { setBusy(''); }
  }

  const assign = (sectionId: string, subjectId: string | null, staffId: string) => {
    const existing = assignmentFor(sectionId, subjectId);
    const key = `${sectionId}:${subjectId ?? 'homeroom'}`;
    return run(key, async () => {
      // One teacher per (section, subject): replace rather than stack duplicates.
      if (existing) await api.teacherAssignments.remove(existing.id);
      if (staffId) {
        await api.teacherAssignments.create({
          staffId, academicYearId: currentYear!.id, sectionId,
          ...(subjectId ? { subjectId } : {}),
        });
      }
    }, staffId ? 'Teacher assigned' : 'Teacher removed');
  };

  if (!loaded) return <p className="muted">Loading…</p>;
  if (!klass) {
    return (
      <div className="stack">
        <h1>Class not found</h1>
        <Link className="ghost small" href="/setup">← Back to Setup</Link>
      </div>
    );
  }

  const campusName = campuses.find((c) => c.id === klass.campusId)?.name ?? '';
  // A section with no explicit subject list studies everything the class offers.
  const subjectsOf = (s: Section) =>
    s.subjectIds?.length ? subjects.filter((x) => s.subjectIds!.includes(x.id)) : subjects;

  return (
    <div className="stack">
      <div className="row">
        <div className="stack" style={{ gap: 2 }}>
          <h1 style={{ marginBottom: 0 }}>{klass.name}</h1>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {campusName}{currentYear ? ` · ${currentYear.name}` : ''} · {sections.length} section{sections.length === 1 ? '' : 's'} · {subjects.length} subject{subjects.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Link className="ghost small" href="/setup">← Setup</Link>
          <button className="ghost small" onClick={() => router.push(`/students?campusId=${klass.campusId}&classId=${klass.id}`)}>
            View students
          </button>
        </div>
      </div>

      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}
      {!currentYear && <div className="toast err">No current school year — set one in Setup before assigning teachers.</div>}
      {teachers.length === 0 && (
        <div className="toast err">
          No teachers yet. Add them under <Link href="/staff" style={{ fontWeight: 600 }}>Staff</Link> first.
        </div>
      )}

      {sections.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            This class has no sections yet. Add one in <Link href="/setup">Setup</Link>.
          </p>
        </div>
      ) : (
        sections.map((sec) => {
          const secSubjects = subjectsOf(sec);
          const homeroom = assignmentFor(sec.id, null);
          return (
            <div className="card stack" key={sec.id}>
              <div className="row">
                <h2 style={{ margin: 0, fontSize: 17 }}>Section {sec.name}</h2>
                <span className="muted" style={{ fontSize: 12 }}>
                  {secSubjects.length} subject{secSubjects.length === 1 ? '' : 's'}
                  {sec.subjectIds?.length ? ' · custom list' : ' · all class subjects'}
                </span>
              </div>

              {/* Class teacher = the homeroom assignment (subjectId null), not a subject. */}
              <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                <span className="muted" style={{ fontSize: 13, minWidth: 90 }}>Class teacher</span>
                <select
                  style={{ maxWidth: 280 }}
                  disabled={!currentYear || busy === `${sec.id}:homeroom`}
                  value={homeroom?.staffId ?? ''}
                  onChange={(e) => assign(sec.id, null, e.target.value)}
                >
                  <option value="">— none —</option>
                  {teachers.map((t) => <option key={t.id} value={t.id}>{t.fullName ?? t.user.email}</option>)}
                </select>
              </div>

              {secSubjects.length === 0 ? (
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  No subjects for this section yet — add them in <Link href="/setup">Setup</Link>.
                </p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table>
                    <thead><tr><th>Subject</th><th>Teacher</th><th></th></tr></thead>
                    <tbody>
                      {secSubjects.map((sub) => {
                        const a = assignmentFor(sec.id, sub.id);
                        const key = `${sec.id}:${sub.id}`;
                        return (
                          <tr key={sub.id}>
                            <td>{sub.name}</td>
                            <td>
                              <select
                                style={{ maxWidth: 280 }}
                                disabled={!currentYear || busy === key}
                                value={a?.staffId ?? ''}
                                onChange={(e) => assign(sec.id, sub.id, e.target.value)}
                              >
                                <option value="">— unassigned —</option>
                                {teachers.map((t) => <option key={t.id} value={t.id}>{t.fullName ?? t.user.email}</option>)}
                              </select>
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              {a
                                ? <span className="badge ok">{teacherName(a.staffId)}</span>
                                : <span className="badge warn">Unassigned</span>}
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
        })
      )}
    </div>
  );
}
