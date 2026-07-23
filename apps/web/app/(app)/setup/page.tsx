'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet, apiPost, ApiError, type AcademicYear, type Campus, type Klass, type Section } from '@/lib/api';
import { classLabeller, sectionLabeller } from '@/lib/labels';
import { useMe } from '@/lib/me-context';

export default function SetupPage() {
  const me = useMe();
  const isOwner = (me?.roles ?? []).includes('OWNER_ADMIN');
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [classes, setClasses] = useState<Klass[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function reload() {
    const [y, c, k, s] = await Promise.all([
      apiGet<AcademicYear[]>('/academic-years'),
      apiGet<Campus[]>('/campuses'),
      apiGet<Klass[]>('/classes'),
      apiGet<Section[]>('/sections'),
    ]);
    setYears(y); setCampuses(c); setClasses(k); setSections(s);
  }
  useEffect(() => { reload().catch(() => {}); }, []);

  async function run(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); await reload(); setMsg({ ok: true, text: ok }); }
    catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed' }); }
  }

  // A campus-bound admin only works within their own campus (the API force-scopes anyway).
  const myCampuses = isOwner ? campuses : campuses.filter((c) => c.id === me?.campusId);

  return (
    <div className="stack">
      <h1>Setup</h1>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <YearCard years={years} isOwner={isOwner}
        onCreate={(b) => run(() => apiPost('/academic-years', b), 'Academic year created')}
        onSetCurrent={(id) => run(() => apiPost(`/academic-years/${id}/set-current`), 'Set as current year')} />

      <ClassCard classes={classes} campuses={myCampuses} sections={sections}
        onCreate={(b) => run(() => apiPost('/classes', { ...b, order: Number(b.order) }), 'Class created')} />

      <SectionCard sections={sections} classes={classes} campuses={myCampuses}
        onCreate={(b) => run(() => apiPost('/sections', b), 'Section created')} />
    </div>
  );
}

function YearCard({ years, isOwner, onCreate, onSetCurrent }: { years: AcademicYear[]; isOwner: boolean; onCreate: (b: object) => void; onSetCurrent: (id: string) => void }) {
  const [name, setName] = useState('2026-27');
  const [startDate, setStart] = useState('2026-04-01');
  const [endDate, setEnd] = useState('2027-03-31');
  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>Academic years</h2>
      <table>
        <thead><tr><th>Name</th><th>Current</th>{isOwner && <th></th>}</tr></thead>
        <tbody>
          {years.map((y) => (
            <tr key={y.id}>
              <td>{y.name}</td>
              <td>{y.isCurrent ? <span className="badge ok">current</span> : <span className="muted">—</span>}</td>
              {isOwner && <td>{!y.isCurrent && <button className="ghost small" onClick={() => onSetCurrent(y.id)}>Set current</button>}</td>}
            </tr>
          ))}
          {years.length === 0 && <tr><td colSpan={isOwner ? 3 : 2} className="muted">No years yet.</td></tr>}
        </tbody>
      </table>
      {isOwner ? (
        <div className="inline-form">
          <div><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div><label>Start</label><input type="date" value={startDate} onChange={(e) => setStart(e.target.value)} /></div>
          <div><label>End</label><input type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} /></div>
          <button onClick={() => onCreate({ name, startDate, endDate, isCurrent: true })}>Add year</button>
        </div>
      ) : (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>Academic years are managed by the school owner.</p>
      )}
    </div>
  );
}

function ClassCard({ classes, campuses, sections, onCreate }: { classes: Klass[]; campuses: Campus[]; sections: Section[]; onCreate: (b: Record<string, string>) => void }) {
  const router = useRouter();
  const [form, setForm] = useState<Record<string, string>>({ order: '1' });
  const [filterCampus, setFilterCampus] = useState('');
  const [grade, setGrade] = useState(''); // e.g. "9th" — matches on class name

  // Open the roster for a class (optionally a specific section) in the Students directory.
  const openRoster = (k: Klass, sectionId?: string) => {
    const qs = new URLSearchParams({ campusId: k.campusId, classId: k.id });
    if (sectionId) qs.set('sectionId', sectionId);
    router.push(`/students?${qs.toString()}`);
  };

  // Apply the campus + grade filters, then group what's left under each campus.
  const gradeQ = grade.trim().toLowerCase();
  const visible = classes
    .filter((k) => !filterCampus || k.campusId === filterCampus)
    .filter((k) => !gradeQ || k.name.toLowerCase().includes(gradeQ));
  const groups = campuses
    .map((c) => ({ id: c.id, campus: c.name, items: visible.filter((k) => k.campusId === c.id).sort((a, b) => a.order - b.order) }))
    .filter((g) => g.items.length > 0);
  const orphaned = visible.filter((k) => !campuses.some((c) => c.id === k.campusId)).sort((a, b) => a.order - b.order);
  if (orphaned.length) groups.push({ id: 'unassigned', campus: 'Unassigned', items: orphaned });

  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>Classes</h2>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        Filter by campus and grade, then double-click a class (or click a section) to open its student list.
      </p>

      {/* Browser filters */}
      <div className="inline-form">
        <div><label>Campus</label>
          <select value={filterCampus} onChange={(e) => setFilterCampus(e.target.value)}>
            <option value="">All campuses</option>
            {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div><label>Grade</label>
          <input value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="e.g. 9th" />
        </div>
        {(filterCampus || grade) && <button className="ghost" onClick={() => { setFilterCampus(''); setGrade(''); }}>Clear</button>}
      </div>

      {/* Results */}
      {classes.length === 0 ? (
        <div className="muted">No classes yet. Add one below.</div>
      ) : groups.length === 0 ? (
        <div className="muted">No classes match this filter.</div>
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          {groups.map((g) => (
            <div key={g.id} className="stack" style={{ gap: 8 }}>
              <div className="muted" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                {g.campus} <span style={{ fontWeight: 400 }}>({g.items.length})</span>
              </div>
              <div className="stack" style={{ gap: 8 }}>
                {g.items.map((k) => {
                  const secs = sections.filter((s) => s.classId === k.id).sort((a, b) => a.name.localeCompare(b.name));
                  return (
                    <div
                      key={k.id}
                      onDoubleClick={() => openRoster(k)}
                      title="Double-click to open this class's students"
                      style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer' }}
                    >
                      <strong style={{ minWidth: 80 }}>{k.name}</strong>
                      {secs.length ? (
                        secs.map((s) => (
                          <button
                            key={s.id}
                            className="badge"
                            onClick={(e) => { e.stopPropagation(); openRoster(k, s.id); }}
                            title={`Open ${k.name} · Section ${s.name}`}
                            style={{ border: 'none', cursor: 'pointer' }}
                          >
                            Section {s.name}
                          </button>
                        ))
                      ) : (
                        <span className="muted" style={{ fontSize: 12 }}>no sections yet</span>
                      )}
                      <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>open students →</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create a class */}
      <div className="inline-form">
        <div><label>Campus</label>
          <select value={form.campusId ?? ''} onChange={(e) => setForm({ ...form, campusId: e.target.value })}>
            <option value="">Select…</option>
            {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div><label>Name</label><input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="9th" /></div>
        <div style={{ maxWidth: 90 }}><label>Order</label><input value={form.order ?? ''} onChange={(e) => setForm({ ...form, order: e.target.value })} /></div>
        <button onClick={() => onCreate(form)}>Add class</button>
      </div>
    </div>
  );
}

function SectionCard({ sections, classes, campuses, onCreate }: { sections: Section[]; classes: Klass[]; campuses: Campus[]; onCreate: (b: Record<string, string>) => void }) {
  const [form, setForm] = useState<Record<string, string>>({});
  const classLabel = classLabeller(classes, campuses);
  const sectionLabel = sectionLabeller(classes, campuses);
  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>Sections</h2>
      <div className="muted">{sections.length ? sections.map(sectionLabel).join(', ') : 'None yet.'}</div>
      <div className="inline-form">
        <div><label>Class</label>
          <select value={form.classId ?? ''} onChange={(e) => setForm({ ...form, classId: e.target.value })}>
            <option value="">Select…</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{classLabel(c)}</option>)}
          </select>
        </div>
        <div><label>Name</label><input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="A" /></div>
        <button onClick={() => onCreate(form)}>Add section</button>
      </div>
    </div>
  );
}
