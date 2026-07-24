'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiPost, ApiError, type Campus, type Enrollment, type Klass, type Section } from '@/lib/api';
import { sectionLabeller } from '@/lib/labels';

const STATUSES = ['PRESENT', 'ABSENT', 'LATE', 'HALF_DAY'];
const today = () => new Date().toISOString().slice(0, 10);

export default function AttendancePage() {
  const [classes, setClasses] = useState<Klass[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [sectionId, setSectionId] = useState('');
  const [date, setDate] = useState(today());
  const [session] = useState('MORNING');
  const [rows, setRows] = useState<Enrollment[]>([]);
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [autoLoaded, setAutoLoaded] = useState(false);

  useEffect(() => {
    apiGet<Klass[]>('/classes').then(setClasses).catch(() => {});
    apiGet<Section[]>('/sections').then(setSections).catch(() => {});
    apiGet<Campus[]>('/campuses').then(setCampuses).catch(() => {});
    // Deep-link from "My Classes" (e.g. /attendance?sectionId=…): preselect that section.
    const sid = new URLSearchParams(window.location.search).get('sectionId');
    if (sid) setSectionId(sid);
  }, []);

  // Once the deep-linked section is set, load its roster automatically (one time).
  useEffect(() => {
    const sid = new URLSearchParams(window.location.search).get('sectionId');
    if (sid && sectionId === sid && !autoLoaded) {
      setAutoLoaded(true);
      loadRoster().catch(() => {});
    }
  }); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadRoster() {
    if (!sectionId) return;
    const enr = await apiGet<{ data: Enrollment[] }>(`/enrollments?sectionId=${sectionId}&status=ACTIVE`);
    const existing = await apiGet<Array<{ enrollmentId: string; status: string }>>(`/attendance?sectionId=${sectionId}&date=${date}`);
    const m: Record<string, string> = {};
    for (const e of enr.data) m[e.id] = 'PRESENT';
    for (const a of existing) m[a.enrollmentId] = a.status;
    // Set marks BEFORE rows: the editable table renders on `rows.length > 0`, so seeding
    // marks first ensures the <select>s never render (and can't be changed then clobbered)
    // before their backing state exists — otherwise a status picked during the gap between
    // these two setState calls is overwritten by this setMarks. (Same race we fixed in exams.)
    setMarks(m);
    setRows(enr.data);
    setMsg(null);
  }

  async function save() {
    try {
      const records = rows.map((r) => ({ enrollmentId: r.id, status: marks[r.id] ?? 'PRESENT' }));
      const res = await apiPost<{ succeeded: number; failed: number; absenceQueued: number }>('/attendance/bulk', { sectionId, date, session, records });
      setMsg({ ok: res.failed === 0, text: `Saved ${res.succeeded}, failed ${res.failed}, absence SMS queued ${res.absenceQueued}` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed to save' });
    }
  }

  const sectionLabel = sectionLabeller(classes, campuses);

  return (
    <div className="stack">
      <h1>Attendance</h1>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <div className="inline-form">
        <div><label>Section</label>
          <select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
            <option value="">Select…</option>
            {sections.map((s) => <option key={s.id} value={s.id}>{sectionLabel(s)}</option>)}
          </select>
        </div>
        <div><label>Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <button className="ghost" onClick={loadRoster} disabled={!sectionId}>Load roster</button>
      </div>

      {rows.length > 0 && (
        <>
          <table>
            <thead><tr><th>GR</th><th>Student</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.student?.grNumber}</td>
                  <td>{r.student?.fullName}</td>
                  <td>
                    <select value={marks[r.id] ?? 'PRESENT'} onChange={(e) => setMarks((prev) => ({ ...prev, [r.id]: e.target.value }))}>
                      {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div><button onClick={save}>Save attendance</button></div>
        </>
      )}
      {sectionId && rows.length === 0 && <p className="muted">No active students in this section — add students first.</p>}
    </div>
  );
}
