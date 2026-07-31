'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ClassTestsPanel } from './class-tests-panel';
import { api, type RosterRow, type TeacherClass } from '@/lib/api';

export default function MyClasses() {
  const [classes, setClasses] = useState<TeacherClass[] | null>(null);
  const [err, setErr] = useState(false);
  const [openSection, setOpenSection] = useState<string | null>(null);
  const [openTests, setOpenTests] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [roster, setRoster] = useState<Record<string, RosterRow[]>>({});

  useEffect(() => { api.teaching.myClasses().then(setClasses).catch(() => setErr(true)); }, []);

  /** Fetch once and cache — both the roster view and the tests panel need the same names. */
  async function loadRoster(sectionId: string) {
    if (roster[sectionId]) return;
    try {
      const rows = await api.teaching.roster(sectionId);
      setRoster((p) => ({ ...p, [sectionId]: rows }));
    } catch {
      setRoster((p) => ({ ...p, [sectionId]: [] }));
    }
  }

  async function toggleRoster(sectionId: string) {
    if (openSection === sectionId) { setOpenSection(null); return; }
    setOpenSection(sectionId);
    await loadRoster(sectionId);
  }

  if (err) return <p className="error">Couldn&apos;t load your classes.</p>;
  if (!classes) return <p className="muted">Loading…</p>;

  return (
    <div className="stack">
      <h1>My Classes</h1>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}
      {classes.length === 0 ? (
        <div className="card"><p className="muted" style={{ margin: 0 }}>You have no class assignments yet. Ask your campus admin to assign you.</p></div>
      ) : (
        <div className="stack">
          {classes.map((c) => (
            <div key={c.assignmentId} className="card stack">
              <div className="row">
                <div>
                  <div style={{ fontWeight: 600, fontSize: 16 }}>
                    {c.className} — {c.sectionName}
                    {c.subjectName && <span className="badge" style={{ marginLeft: 8 }}>{c.subjectName}</span>}
                    {c.isClassTeacher && <span className="badge ok" style={{ marginLeft: 6 }}>class teacher</span>}
                  </div>
                  <div className="muted" style={{ fontSize: 13 }}>{c.yearName} · {c.studentCount} students</div>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <Link className="chip" href={`/attendance?sectionId=${c.sectionId}`}>Attendance</Link>
                  <Link className="chip" href={`/exams?assignmentId=${c.assignmentId}`}>Marks</Link>
                  {c.subjectId && (
                    <button className="small" onClick={async () => {
                      const key = c.assignmentId;
                      if (openTests === key) return setOpenTests(null);
                      await loadRoster(c.sectionId);
                      setOpenTests(key);
                    }}>
                      {openTests === c.assignmentId ? 'Close tests' : '📝 Tests'}
                    </button>
                  )}
                  <button className="ghost small" onClick={() => toggleRoster(c.sectionId)}>
                    {openSection === c.sectionId ? 'Hide roster' : 'View roster'}
                  </button>
                </div>
              </div>
              {openTests === c.assignmentId && c.subjectId && (
                <ClassTestsPanel
                  sectionId={c.sectionId}
                  subjectId={c.subjectId}
                  subjectName={c.subjectName ?? 'This subject'}
                  roster={roster[c.sectionId] ?? []}
                  onMsg={(ok, text) => setMsg({ ok, text })}
                />
              )}
              {openSection === c.sectionId && (
                <table>
                  <thead><tr><th>Roll</th><th>Name</th><th>Reg no</th><th>GR</th></tr></thead>
                  <tbody>
                    {(roster[c.sectionId] ?? []).map((r) => (
                      <tr key={r.studentId}>
                        <td>{r.rollNumber ?? '—'}</td>
                        <td>{r.fullName}</td>
                        <td>{r.registrationNo ?? '—'}</td>
                        <td>{r.grNumber}</td>
                      </tr>
                    ))}
                    {(roster[c.sectionId]?.length ?? 0) === 0 && <tr><td colSpan={4} className="muted">No students enrolled.</td></tr>}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
