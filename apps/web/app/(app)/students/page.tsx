'use client';

import { type ChangeEvent, useEffect, useState } from 'react';
import { apiGet, apiPost, ApiError, type ImportResult, type Klass, type Paged, type Section, type Student } from '@/lib/api';

export default function StudentsPage() {
  const [students, setStudents] = useState<Student[]>([]);
  const [classes, setClasses] = useState<Klass[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    const q = search ? `?search=${encodeURIComponent(search)}` : '';
    const res = await apiGet<Paged<Student>>(`/students${q}`);
    setStudents(res.data);
  }
  useEffect(() => {
    apiGet<Klass[]>('/classes').then(setClasses).catch(() => {});
    apiGet<Section[]>('/sections').then(setSections).catch(() => {});
    load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="stack">
      <div className="row">
        <h1>Students</h1>
        <div className="row" style={{ gap: 8 }}>
          <button className="ghost" onClick={() => setImporting((v) => !v)}>{importing ? 'Close' : 'Import CSV'}</button>
          <button onClick={() => setAdding((v) => !v)}>{adding ? 'Close' : '+ Add student'}</button>
        </div>
      </div>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {importing && <ImportStudents onImported={async () => { await load(); }} />}

      {adding && (
        <AddStudent classes={classes} sections={sections}
          onDone={async (ok, text) => { setMsg({ ok, text }); if (ok) { setAdding(false); await load(); } }} />
      )}

      <div className="inline-form">
        <div style={{ minWidth: 260 }}><label>Search (name / GR / phone)</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} />
        </div>
        <button className="ghost" onClick={() => load()}>Search</button>
      </div>

      <table>
        <thead><tr><th>GR</th><th>Name</th><th>Gender</th><th>Status</th></tr></thead>
        <tbody>
          {students.map((s) => (
            <tr key={s.id}>
              <td>{s.grNumber}</td>
              <td>{s.fullName}</td>
              <td>{s.gender}</td>
              <td>{s.isActive ? <span className="badge ok">active</span> : <span className="badge bad">inactive</span>}</td>
            </tr>
          ))}
          {students.length === 0 && <tr><td colSpan={4} className="muted">No students. Add one, or set up a class/section first.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function AddStudent({ classes, sections, onDone }: { classes: Klass[]; sections: Section[]; onDone: (ok: boolean, text: string) => void }) {
  const [f, setF] = useState<Record<string, string>>({ gender: 'MALE', relation: 'FATHER' });
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  const classSections = sections.filter((s) => s.classId === f.classId);

  async function submit() {
    try {
      await apiPost('/students', {
        fullName: f.fullName, gender: f.gender, dateOfBirth: f.dateOfBirth, classId: f.classId, sectionId: f.sectionId,
        guardian: { mode: 'CREATE', fullName: f.guardianName, phone: f.phone, relation: f.relation },
      });
      onDone(true, `Admitted ${f.fullName}`);
    } catch (e) {
      onDone(false, e instanceof ApiError ? e.message : 'Failed to add student');
    }
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>New student</h2>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))' }}>
        <div><label>Full name</label><input value={f.fullName ?? ''} onChange={(e) => set('fullName', e.target.value)} /></div>
        <div><label>Gender</label><select value={f.gender} onChange={(e) => set('gender', e.target.value)}><option>MALE</option><option>FEMALE</option><option>OTHER</option></select></div>
        <div><label>Date of birth</label><input type="date" value={f.dateOfBirth ?? ''} onChange={(e) => set('dateOfBirth', e.target.value)} /></div>
        <div><label>Class</label><select value={f.classId ?? ''} onChange={(e) => setF({ ...f, classId: e.target.value, sectionId: '' })}><option value="">Select…</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div><label>Section</label><select value={f.sectionId ?? ''} onChange={(e) => set('sectionId', e.target.value)}><option value="">Select…</option>{classSections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <div><label>Guardian name</label><input value={f.guardianName ?? ''} onChange={(e) => set('guardianName', e.target.value)} /></div>
        <div><label>Guardian phone</label><input value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value)} placeholder="03001234567" /></div>
        <div><label>Relation</label><select value={f.relation} onChange={(e) => set('relation', e.target.value)}><option>FATHER</option><option>MOTHER</option><option>GUARDIAN</option></select></div>
      </div>
      <div><button onClick={submit}>Admit student</button></div>
    </div>
  );
}

const CSV_TEMPLATE =
  'fullName,gender,dateOfBirth,className,sectionName,guardianName,guardianPhone,relation\n' +
  'Ahmed Khan,MALE,2015-06-10,Grade 1,A,Kamran Khan,03009998877,FATHER\n' +
  'Ayesha Khan,FEMALE,2017-06-10,Grade 1,A,Kamran Khan,03009998877,FATHER';

function ImportStudents({ onImported }: { onImported: () => void | Promise<void> }) {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(dryRun: boolean) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiPost<ImportResult>('/students/import', { csv, dryRun });
      setResult(res);
      if (!dryRun && res.imported > 0) await onImported();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setCsv(String(reader.result ?? '')); setResult(null); setError(null); };
    reader.readAsText(file);
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([CSV_TEMPLATE], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'students-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>Import students (CSV)</h2>
      <p className="muted" style={{ margin: 0 }}>
        Columns: <code>fullName, gender, dateOfBirth (YYYY-MM-DD), className, sectionName, guardianName, guardianPhone, relation</code>.
        Optional: <code>campusName, guardianCnic, guardianEmail, grNumber</code>. Siblings sharing a phone are linked to one guardian.
      </p>
      <div className="row" style={{ gap: 8 }}>
        <input type="file" accept=".csv,text/csv" onChange={onFile} aria-label="CSV file" />
        <button className="ghost" onClick={downloadTemplate}>Download template</button>
      </div>
      <textarea
        value={csv}
        onChange={(e) => { setCsv(e.target.value); setResult(null); setError(null); }}
        rows={6}
        placeholder="…or paste CSV rows here"
        style={{ fontFamily: 'monospace', width: '100%' }}
      />
      <div className="row" style={{ gap: 8 }}>
        <button className="ghost" disabled={busy || !csv.trim()} onClick={() => run(true)}>Validate</button>
        <button disabled={busy || !csv.trim()} onClick={() => run(false)}>Import</button>
      </div>
      {error && <div className="toast err">{error}</div>}
      {result && <ImportReport result={result} />}
    </div>
  );
}

function ImportReport({ result }: { result: ImportResult }) {
  if (result.errors.length > 0) {
    return (
      <div className="stack">
        <div className="toast err">{result.failed} row(s) have errors — nothing was imported. Fix and re-upload.</div>
        <table>
          <thead><tr><th>Row</th><th>Field</th><th>Problem</th></tr></thead>
          <tbody>
            {result.errors.map((e, i) => (
              <tr key={i}><td>{e.row}</td><td>{e.field ?? ''}</td><td>{e.message}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (result.dryRun) return <div className="toast ok">Looks good — {result.rows} row(s) ready to import.</div>;
  return <div className="toast ok">Imported {result.imported} student(s).</div>;
}
