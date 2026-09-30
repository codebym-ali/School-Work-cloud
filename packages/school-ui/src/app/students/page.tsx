'use client';

import { type ChangeEvent, Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, apiGet, apiPost, ApiError, type Campus, type ImportResult, type Klass, type Paged, type Section, type Student, type StudentStatus } from '@sw/api-client';
import { useCampusLens } from '@sw/session';
import { classLabeller } from '@school/lib/labels';
import { hasModule, useMe } from '@sw/session';
import { STATUS_TRANSITIONS, STUDENT_STATUS, statusStyle, humanizeStatus } from '@sw/ui';
import { MoveStudentDialog } from '@school/components/move-student-dialog';
import { DirectAdmission } from '../admissions/direct-admission';
import { OwnerStudentsHub } from './owner-hub';
import { StudentProfile } from './student-profile';

export default function StudentsPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <StudentsInner />
    </Suspense>
  );
}

function StudentsInner() {
  const me = useMe();
  const isOwner = (me?.roles ?? []).includes('OWNER_ADMIN');
  const isAdmissionController = (me?.roles ?? []).includes('ADMISSION_CONTROLLER');
  const canAdmit = isAdmissionController && hasModule(me, 'admissions.admit');
  const router = useRouter();
  const params = useSearchParams();
  const lens = useCampusLens();
  const campusId = lens.campusId ?? '';
  const classId = params.get('classId') ?? '';
  const sectionId = params.get('sectionId') ?? '';

  const [students, setStudents] = useState<Student[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [classes, setClasses] = useState<Klass[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [statusFor, setStatusFor] = useState<Student | null>(null);
  const [deleteFor, setDeleteFor] = useState<Student | null>(null);
  const [moveFor, setMoveFor] = useState<Student | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [missingGuardian, setMissingGuardian] = useState(false);
  const [hubReload, setHubReload] = useState(0);

  async function load() {
    const qs = new URLSearchParams();
    if (search) qs.set('search', search);
    if (statusFilter) qs.set('status', statusFilter);
    if (missingGuardian) qs.set('missingGuardian', 'true');
    if (campusId) qs.set('campusId', campusId);
    if (classId) qs.set('classId', classId);
    if (sectionId) qs.set('sectionId', sectionId);
    const q = qs.toString();
    const res = await apiGet<Paged<Student>>(`/students${q ? `?${q}` : ''}`);
    setStudents(res.data);
  }
  useEffect(() => {
    apiGet<Campus[]>('/campuses').then(setCampuses).catch(() => {});
    apiGet<Klass[]>('/classes').then(setClasses).catch(() => {});
    apiGet<Section[]>('/sections').then(setSections).catch(() => {});
    if (me && !isOwner) load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lens.campusId, classId, sectionId, statusFilter, missingGuardian, me, isOwner]);

  function setFilter(next: { classId?: string; sectionId?: string }) {
    const merged = { classId, sectionId, ...next };
    const qs = new URLSearchParams();
    if (merged.classId) qs.set('classId', merged.classId);
    if (merged.sectionId) qs.set('sectionId', merged.sectionId);
    const q = qs.toString();
    router.replace(q ? `/students?${q}` : '/students');
  }

  const lastLens = useRef(lens.campusId);
  useEffect(() => {
    if (lastLens.current !== lens.campusId) {
      lastLens.current = lens.campusId;
      if (classId || sectionId) router.replace('/students');
    }
  }, [lens.campusId, classId, sectionId, router]);

  const classesForCampus = campusId ? classes.filter((c) => c.campusId === campusId) : classes;
  const classLabel = classLabeller(classesForCampus, campuses);
  const sectionsForClass = classId ? sections.filter((s) => s.classId === classId) : [];
  const activeClass = classes.find((c) => c.id === classId);
  const activeSection = sections.find((s) => s.id === sectionId);
  const hasFilter = Boolean(campusId || classId || sectionId);

  // Backwards-compat: `?student=<id>` redirects to the dedicated profile route.
  useEffect(() => {
    const studentId = params.get('student');
    if (studentId) router.replace(`/students/${studentId}`);
  }, [params, router]);

  if (!me) return <p className="muted">Loading…</p>;

  if (isOwner) {
    return (
      <div className="stack">
        {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}
        {deleteFor && (
          <DeleteStudentDialog student={deleteFor} onClose={() => setDeleteFor(null)}
            onDone={(text) => { setDeleteFor(null); setMsg({ ok: true, text }); setHubReload((k) => k + 1); }}
            onError={(text) => setMsg({ ok: false, text })} />
        )}
        <OwnerStudentsHub onOpenProfile={(id) => router.push(`/students/${id}`)} onDelete={(s) => { setMsg(null); setDeleteFor(s); }} reloadKey={hubReload} />
      </div>
    );
  }

  if (detailId) return <StudentProfile id={detailId} classes={classes} sections={sections} onBack={() => setDetailId(null)} />;

  return (
    <div className="stack">
      <div className="row">
        <h1>Students</h1>
        <div className="row" style={{ gap: 8 }}>
          {isAdmissionController && (
            <button className="ghost" onClick={() => setImporting((v) => !v)}>{importing ? 'Close' : 'Import CSV'}</button>
          )}
          {canAdmit && <button onClick={() => setAdding((v) => !v)}>{adding ? 'Close' : '+ Add student'}</button>}
        </div>
      </div>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {importing && <ImportStudents onImported={async () => { await load(); }} />}

      {adding && (
        <DirectAdmission campuses={campuses} classes={classes} sections={sections}
          onAdmitted={async (r, name) => { setMsg({ ok: true, text: `Admitted ${name} — Reg No ${r.registrationNo ?? '—'}` }); await load(); }} />
      )}

      {activeClass && (
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className="muted">Showing</span>
          <span className="badge">{activeClass.name}{activeSection ? ` · Section ${activeSection.name}` : ''}</span>
          <button className="ghost small" onClick={() => setFilter({ classId: '', sectionId: '' })}>Clear filter</button>
        </div>
      )}

      <div className="inline-form">
        <div><label>Class</label>
          <select aria-label="Filter by class" value={classId} onChange={(e) => setFilter({ classId: e.target.value, sectionId: '' })}>
            <option value="">All classes</option>
            {classesForCampus.map((c) => <option key={c.id} value={c.id}>{classLabel(c)}</option>)}
          </select>
        </div>
        <div><label>Section</label>
          <select aria-label="Filter by section" value={sectionId} onChange={(e) => setFilter({ sectionId: e.target.value })} disabled={!classId}>
            <option value="">All sections</option>
            {sectionsForClass.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div><label>Status</label>
          <select aria-label="Filter by status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            {(Object.keys(STUDENT_STATUS) as StudentStatus[]).map((s) => (
              <option key={s} value={s}>{STUDENT_STATUS[s].label}</option>
            ))}
          </select>
        </div>
        <div style={{ minWidth: 220 }}><label>Search (name / GR / phone)</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} />
        </div>
        <button className="ghost" onClick={() => load()}>Search</button>
      </div>

      <div className="chips">
        <button
          className={`chip ${missingGuardian ? 'active' : ''}`}
          onClick={() => { setMissingGuardian((v) => !v); }}
          title="Students with nobody on record to contact — they receive no absence, fee or result SMS"
        >
          ⚠️ Missing guardian
        </button>
        {missingGuardian && <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>Showing only students with no guardian on record.</span>}
      </div>

      {statusFor && (
        <ChangeStatusDialog student={statusFor} onClose={() => setStatusFor(null)}
          onDone={async (text) => { setStatusFor(null); setMsg({ ok: true, text }); await load(); }}
          onError={(text) => setMsg({ ok: false, text })} />
      )}
      {moveFor && (
        <MoveStudentDialog student={moveFor} classes={classes} sections={sections} onClose={() => setMoveFor(null)}
          onDone={async (text) => { setMoveFor(null); setMsg({ ok: true, text }); await load(); }}
          onError={(text) => setMsg({ ok: false, text })} />
      )}
      {deleteFor && (
        <DeleteStudentDialog student={deleteFor} onClose={() => setDeleteFor(null)}
          onDone={async (text) => { setDeleteFor(null); setMsg({ ok: true, text }); await load(); }}
          onError={(text) => setMsg({ ok: false, text })} />
      )}

      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Reg No</th><th>GR</th><th>Name</th><th>Gender</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {students.map((s) => (
              <tr key={s.id}>
                <td>{s.registrationNo ?? '—'}</td>
                <td>{s.grNumber}</td>
                <td>
                  {s.fullName}
                  {!s.hasGuardian && (
                    <span className="badge warn" style={{ marginLeft: 6 }} title="No guardian on record — this student receives no absence, fee or result SMS">
                      no guardian
                    </span>
                  )}
                </td>
                <td>{humanizeStatus(s.gender)}</td>
                <td><StatusPill status={s.status} /></td>
                <td style={{ textAlign: 'right' }}>
                  <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                    <button className="ghost small" onClick={() => setDetailId(s.id)}>View</button>
                    <button className="ghost small" onClick={() => setStatusFor(s)}>Change status</button>
                    <button className="ghost small" onClick={() => setMoveFor(s)}>Move</button>
                    {isOwner && <button className="ghost small" style={{ color: '#b91c1c' }} onClick={() => setDeleteFor(s)}>Delete</button>}
                  </div>
                </td>
              </tr>
            ))}
            {students.length === 0 && (
              <tr><td colSpan={6} className="muted">
                {hasFilter ? 'No students in this class/section yet.' : 'No students. Add one, or set up a class/section first.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: StudentStatus }) {
  const { label } = STUDENT_STATUS[status];
  return <span className="badge" style={{ ...statusStyle(status), whiteSpace: 'nowrap' }}>{label}</span>;
}

function ChangeStatusDialog({ student, onClose, onDone, onError }: {
  student: Student; onClose: () => void; onDone: (text: string) => void; onError: (text: string) => void;
}) {
  const allowed = STATUS_TRANSITIONS[student.status];
  const [status, setStatus] = useState<StudentStatus | ''>('');
  const [reason, setReason] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [busy, setBusy] = useState(false);

  const needsEndDate = status === 'SUSPENDED';
  const canSubmit = status && reason.trim().length >= 3 && (!needsEndDate || endsOn) && !busy;

  async function submit() {
    if (!status) return;
    setBusy(true);
    try {
      await api.students.changeStatus(student.id, {
        status, reason: reason.trim(), ...(needsEndDate && endsOn ? { endsOn } : {}),
      });
      onDone(`${student.fullName} is now ${STUDENT_STATUS[status].label.toLowerCase()}`);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Could not change status');
    } finally { setBusy(false); }
  }

  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0, fontSize: 17 }}>Change status — {student.fullName}</h2>
        <button className="ghost small" onClick={onClose}>Close</button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        Currently <strong>{STUDENT_STATUS[student.status].label}</strong>.{' '}
        {allowed.length === 0 && 'This is a final status and cannot be changed.'}
      </p>

      {allowed.length > 0 && (
        <>
          <div className="inline-form">
            <div><label>New status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value as StudentStatus)}>
                <option value="">Select…</option>
                {allowed.map((s) => <option key={s} value={s}>{STUDENT_STATUS[s].label}</option>)}
              </select>
            </div>
            {needsEndDate && (
              <div><label>Suspended until</label><input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} /></div>
            )}
          </div>

          {status && (
            <div className="toast" style={{ ...statusStyle(status), margin: 0 }}>
              <strong>What this does:</strong> {STUDENT_STATUS[status].effect}
            </div>
          )}

          <div className="stack" style={{ gap: 4 }}>
            <label>Reason (recorded in the audit log)</label>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Repeated absence without leave" />
          </div>

          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            Leaving the school is not a status: use <strong>Withdraw student</strong> on the profile, which issues the leaving certificate and stops billing.
          </p>
          <div><button disabled={!canSubmit} onClick={submit}>{busy ? 'Saving…' : 'Save status'}</button></div>
        </>
      )}
    </div>
  );
}

function DeleteStudentDialog({ student, onClose, onDone, onError }: {
  student: Student; onClose: () => void; onDone: (text: string) => void; onError: (text: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.students.remove(student.id);
      onDone(`${student.fullName} deleted`);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Could not delete this student');
      onClose();
    } finally { setBusy(false); }
  }

  return (
    <div className="card stack" style={{ borderColor: '#fecaca' }}>
      <div className="row">
        <h2 style={{ margin: 0, fontSize: 17 }}>Delete {student.fullName}?</h2>
        <button className="ghost small" onClick={onClose}>Cancel</button>
      </div>
      <div className="toast err" style={{ margin: 0 }}>
        Only delete a record that should never have existed — a duplicate or a mis-typed admission.
        If this student actually attended, use <strong>Change status</strong> or the withdrawal process
        so their history is kept. A student with fee payments or certificates cannot be deleted.
      </div>
      <div className="stack" style={{ gap: 4 }}>
        <label>Type the student&apos;s name to confirm</label>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={student.fullName} />
      </div>
      <div>
        <button disabled={typed.trim() !== student.fullName || busy} style={{ background: '#b91c1c' }} onClick={submit}>
          {busy ? 'Deleting…' : 'Delete permanently'}
        </button>
      </div>
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
