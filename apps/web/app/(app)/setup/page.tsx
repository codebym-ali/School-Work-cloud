'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiPost, ApiError, type AcademicYear, type Campus, type Klass, type Section } from '@/lib/api';

export default function SetupPage() {
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

  return (
    <div className="stack">
      <h1>Setup</h1>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      <YearCard years={years} onCreate={(b) => run(() => apiPost('/academic-years', b), 'Academic year created')}
        onSetCurrent={(id) => run(() => apiPost(`/academic-years/${id}/set-current`), 'Set as current year')} />

      <SimpleCard title="Campuses" items={campuses.map((c) => c.name)} fields={[{ name: 'name', label: 'Campus name' }]}
        onCreate={(b) => run(() => apiPost('/campuses', b), 'Campus created')} />

      <ClassCard classes={classes} campuses={campuses}
        onCreate={(b) => run(() => apiPost('/classes', { ...b, order: Number(b.order) }), 'Class created')} />

      <SectionCard sections={sections} classes={classes}
        onCreate={(b) => run(() => apiPost('/sections', b), 'Section created')} />
    </div>
  );
}

function YearCard({ years, onCreate, onSetCurrent }: { years: AcademicYear[]; onCreate: (b: object) => void; onSetCurrent: (id: string) => void }) {
  const [name, setName] = useState('2026-27');
  const [startDate, setStart] = useState('2026-04-01');
  const [endDate, setEnd] = useState('2027-03-31');
  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>Academic years</h2>
      <table>
        <thead><tr><th>Name</th><th>Current</th><th></th></tr></thead>
        <tbody>
          {years.map((y) => (
            <tr key={y.id}>
              <td>{y.name}</td>
              <td>{y.isCurrent ? <span className="badge ok">current</span> : <span className="muted">—</span>}</td>
              <td>{!y.isCurrent && <button className="ghost small" onClick={() => onSetCurrent(y.id)}>Set current</button>}</td>
            </tr>
          ))}
          {years.length === 0 && <tr><td colSpan={3} className="muted">No years yet.</td></tr>}
        </tbody>
      </table>
      <div className="inline-form">
        <div><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><label>Start</label><input type="date" value={startDate} onChange={(e) => setStart(e.target.value)} /></div>
        <div><label>End</label><input type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} /></div>
        <button onClick={() => onCreate({ name, startDate, endDate, isCurrent: true })}>Add year</button>
      </div>
    </div>
  );
}

function SimpleCard({ title, items, fields, onCreate }: { title: string; items: string[]; fields: { name: string; label: string }[]; onCreate: (b: Record<string, string>) => void }) {
  const [form, setForm] = useState<Record<string, string>>({});
  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>
      <div className="muted">{items.length ? items.join(' · ') : 'None yet.'}</div>
      <div className="inline-form">
        {fields.map((f) => (
          <div key={f.name}><label>{f.label}</label><input value={form[f.name] ?? ''} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })} /></div>
        ))}
        <button onClick={() => onCreate(form)}>Add</button>
      </div>
    </div>
  );
}

function ClassCard({ classes, campuses, onCreate }: { classes: Klass[]; campuses: Campus[]; onCreate: (b: Record<string, string>) => void }) {
  const [form, setForm] = useState<Record<string, string>>({ order: '1' });
  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>Classes</h2>
      <div className="muted">{classes.length ? classes.map((c) => `${c.name} (#${c.order})`).join(' · ') : 'None yet.'}</div>
      <div className="inline-form">
        <div><label>Campus</label>
          <select value={form.campusId ?? ''} onChange={(e) => setForm({ ...form, campusId: e.target.value })}>
            <option value="">Select…</option>
            {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div><label>Name</label><input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Grade 1" /></div>
        <div style={{ maxWidth: 90 }}><label>Order</label><input value={form.order ?? ''} onChange={(e) => setForm({ ...form, order: e.target.value })} /></div>
        <button onClick={() => onCreate(form)}>Add class</button>
      </div>
    </div>
  );
}

function SectionCard({ sections, classes, onCreate }: { sections: Section[]; classes: Klass[]; onCreate: (b: Record<string, string>) => void }) {
  const [form, setForm] = useState<Record<string, string>>({});
  const nameFor = (id: string) => classes.find((c) => c.id === id)?.name ?? '?';
  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>Sections</h2>
      <div className="muted">{sections.length ? sections.map((s) => `${nameFor(s.classId)}-${s.name}`).join(' · ') : 'None yet.'}</div>
      <div className="inline-form">
        <div><label>Class</label>
          <select value={form.classId ?? ''} onChange={(e) => setForm({ ...form, classId: e.target.value })}>
            <option value="">Select…</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div><label>Name</label><input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="A" /></div>
        <button onClick={() => onCreate(form)}>Add section</button>
      </div>
    </div>
  );
}
