'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type RosterRow, type TeacherClass } from '@/lib/api';

export default function MyClasses() {
  const [classes, setClasses] = useState<TeacherClass[] | null>(null);
  const [err, setErr] = useState(false);
  const [openSection, setOpenSection] = useState<string | null>(null);
  const [roster, setRoster] = useState<Record<string, RosterRow[]>>({});

  useEffect(() => { api.teaching.myClasses().then(setClasses).catch(() => setErr(true)); }, []);

  async function toggleRoster(sectionId: string) {
    if (openSection === sectionId) { setOpenSection(null); return; }
    setOpenSection(sectionId);
    if (!roster[sectionId]) {
      try {
        const rows = await api.teaching.roster(sectionId);
        setRoster((p) => ({ ...p, [sectionId]: rows }));
      } catch {
        setRoster((p) => ({ ...p, [sectionId]: [] }));
      }
    }
  }

  if (err) return <p className="error">Couldn&apos;t load your classes.</p>;
  if (!classes) return <p className="muted">Loading…</p>;

  return (
    <div className="stack">
      <h1>My Classes</h1>
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
                  <Link className="chip" href="/attendance">Attendance</Link>
                  <Link className="chip" href="/exams">Marks</Link>
                  <button className="ghost small" onClick={() => toggleRoster(c.sectionId)}>
                    {openSection === c.sectionId ? 'Hide roster' : 'View roster'}
                  </button>
                </div>
              </div>
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
