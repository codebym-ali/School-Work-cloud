'use client';

import { type ChangeEvent, Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, apiGet, apiPost, ApiError, type Campus, type ImportResult, type Invoice, type Klass, type Paged, type Payment, type Section, type Student, type StudentDetail, type StudentStatus } from '@/lib/api';
import { classLabeller } from '@/lib/labels';
import { hasModule, useMe } from '@/lib/me-context';
import { STATUS_TRANSITIONS, STUDENT_STATUS, statusStyle } from '@/lib/student-status';
import { DirectAdmission } from '../admissions/direct-admission';

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
  const campusId = params.get('campusId') ?? '';
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
    load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campusId, classId, sectionId, statusFilter, missingGuardian]);

  // Push a new filter into the URL so the view is shareable and the effect reloads.
  function setFilter(next: { campusId?: string; classId?: string; sectionId?: string }) {
    const merged = { campusId, classId, sectionId, ...next };
    const qs = new URLSearchParams();
    if (merged.campusId) qs.set('campusId', merged.campusId);
    if (merged.classId) qs.set('classId', merged.classId);
    if (merged.sectionId) qs.set('sectionId', merged.sectionId);
    const q = qs.toString();
    router.replace(q ? `/students?${q}` : '/students');
  }

  // A campus-bound admin only sees their own campus in the filter (the API force-scopes
  // results regardless, so an all-campuses picker was just a confusing dead choice).
  const myCampuses = isOwner ? campuses : campuses.filter((c) => c.id === me?.campusId);
  const classesForCampus = campusId ? classes.filter((c) => c.campusId === campusId) : classes;
  const classLabel = classLabeller(classesForCampus, campuses);
  const sectionsForClass = classId ? sections.filter((s) => s.classId === classId) : [];
  const activeClass = classes.find((c) => c.id === classId);
  const activeSection = sections.find((s) => s.id === sectionId);
  const hasFilter = Boolean(campusId || classId || sectionId);

  if (detailId) return <StudentProfile id={detailId} classes={classes} sections={sections} onBack={() => setDetailId(null)} />;

  return (
    <div className="stack">
      <div className="row">
        <h1>Students</h1>
        <div className="row" style={{ gap: 8 }}>
          {/* Import is ADMISSION_CONTROLLER-only on the API (same segregation of duties as
              admitting), but this button was offered to everyone — so an owner could open the
              form, paste a file, and get a 403 with no way to tell why. An action nobody's role
              permits is worse than no button. */}
          {isAdmissionController && (
            <button className="ghost" onClick={() => setImporting((v) => !v)}>{importing ? 'Close' : 'Import CSV'}</button>
          )}
          {/* Admitting is admission-controller-only (#31); owner/campus admins read here.
              Module checked too, so the owner switching `admissions.admit` off hides it in
              both places this form is offered (here and /admissions). */}
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
          <button className="ghost small" onClick={() => setFilter({ campusId: '', classId: '', sectionId: '' })}>Clear filter</button>
        </div>
      )}

      <div className="inline-form">
        <div><label>Campus</label>
          <select value={campusId} onChange={(e) => setFilter({ campusId: e.target.value, classId: '', sectionId: '' })}>
            <option value="">All campuses</option>
            {myCampuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div><label>Class</label>
          <select value={classId} onChange={(e) => setFilter({ classId: e.target.value, sectionId: '' })}>
            <option value="">All classes</option>
            {classesForCampus.map((c) => <option key={c.id} value={c.id}>{classLabel(c)}</option>)}
          </select>
        </div>
        <div><label>Section</label>
          <select value={sectionId} onChange={(e) => setFilter({ sectionId: e.target.value })} disabled={!classId}>
            <option value="">All sections</option>
            {sectionsForClass.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div><label>Status</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
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

      {/* The chase list. Admitting without a guardian is allowed, but those students get no
          SMS at all — so finding them has to be one click, not a report nobody runs. */}
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
                <td>{s.gender}</td>
                <td><StatusPill status={s.status} /></td>
                <td style={{ textAlign: 'right' }}>
                  <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                    <button className="ghost small" onClick={() => setDetailId(s.id)}>View</button>
                    <button className="ghost small" onClick={() => setStatusFor(s)}>Change status</button>
                    {/* Beside status rather than inside it: a move is a correction, not a sanction,
                        and the status dialog is where the four destructive changes live. */}
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

/**
 * Move a student to another class or section (Student Transfer Plan, X1).
 *
 * **A transfer is an administrative act with consequences, not an edit.** The API closes the
 * current enrolment and opens a new one, so the dialog's job is to make three things legible
 * *before* the click:
 *
 * - **what is changing** — 9-A → 9-B is a different act from Grade 9 → Grade 10;
 * - **whether there is room** — seats decide whether this is even possible, and the office should
 *   see that before choosing rather than after being refused;
 * - **what does NOT move** — attendance and marks stay with the closed enrolment. A user who
 *   expects the whole year to follow the child reports that as data loss.
 *
 * The API is the authority on all of it: campus scoping on both ends, and `sectionCapacityMode`.
 * This screen shows the same facts early so the refusal is rare, never instead of the check.
 */
function MoveStudentDialog({ student, classes, sections, onClose, onDone, onError }: {
  student: Student; classes: Klass[]; sections: Section[]; onClose: () => void;
  onDone: (text: string) => void; onError: (text: string) => void;
}) {
  const [toClassId, setToClassId] = useState('');
  const [toSectionId, setToSectionId] = useState('');
  const [current, setCurrent] = useState<{ classId: string; sectionId: string } | null>(null);
  const [hardCap, setHardCap] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The cap is a school setting, and it decides whether a full section is refused or merely
    // warned about — so the dialog must not guess which.
    api.schoolSettings.get().then((x) => setHardCap(x.sectionCapacityMode === 'HARD')).catch(() => {});
    // `Student` on the row carries no placement, and the "Currently" line is the whole reason a
    // user can tell a correction from a mistake. One call, to the endpoint built for it.
    api.enrollments.list(`studentId=${student.id}&status=ACTIVE`)
      .then((p) => { const e = p.data[0]; if (e) setCurrent({ classId: e.classId, sectionId: e.sectionId }); })
      .catch(() => {});
  }, [student.id]);

  useEffect(() => { setToSectionId(''); }, [toClassId]);

  const name = (classId: string, sectionId: string) => {
    const c = classes.find((x) => x.id === classId)?.name;
    const sec = sections.find((x) => x.id === sectionId)?.name;
    return c && sec ? `${c}-${sec}` : c ?? '—';
  };
  const options = sections.filter((x) => x.classId === toClassId);
  const target = options.find((x) => x.id === toSectionId);
  const seatsTaken = target?.enrolled ?? 0;
  const full = Boolean(target && seatsTaken >= target.capacity);
  const sameSection = Boolean(current) && toSectionId === current!.sectionId;
  const canSubmit = Boolean(toSectionId) && !sameSection && !(full && hardCap) && !busy;

  async function submit() {
    setBusy(true);
    try {
      await api.enrollments.transfer(student.id, toSectionId);
      const klass = classes.find((c) => c.id === toClassId)?.name ?? '';
      onDone(`${student.fullName} moved to ${klass}-${target?.name ?? ''}`);
    } catch (e) {
      // Shown verbatim: the server says "Section is at capacity" or refuses the campus. Both are
      // things the office can act on; "Failed" is not.
      onError(e instanceof ApiError ? e.message : 'Could not move this student');
    } finally { setBusy(false); }
  }

  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0, fontSize: 17 }}>Move — {student.fullName}</h2>
        <button className="ghost small" onClick={onClose}>Close</button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        Currently <strong>{current ? name(current.classId, current.sectionId) : '…'}</strong>.
      </p>

      <div className="inline-form">
        <div style={{ minWidth: 170 }}><label>Class</label>
          <select value={toClassId} onChange={(e) => setToClassId(e.target.value)}>
            <option value="">Select…</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div style={{ minWidth: 190 }}><label>Section</label>
          <select value={toSectionId} onChange={(e) => setToSectionId(e.target.value)} disabled={!toClassId}>
            <option value="">Select…</option>
            {options.map((x) => (
              // Seats on the option itself: "38 of 40" read while choosing beats a refusal after.
              <option key={x.id} value={x.id}>
                {x.name} — {x.enrolled ?? 0} of {x.capacity} seats{(x.enrolled ?? 0) >= x.capacity ? ' · full' : ''}
              </option>
            ))}
          </select>
        </div>
        <button onClick={submit} disabled={!canSubmit} style={{ minHeight: 44 }}>
          {busy ? 'Moving…' : 'Move student'}
        </button>
      </div>

      {sameSection && (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>That is the section they are already in.</p>
      )}
      {full && (
        // ADVISORY is the school saying its class sizes are guidance, so the move is allowed and
        // warned about — exactly what admission does. HARD refuses, and says so before the click.
        <div className={`toast ${hardCap ? 'err' : 'warn'}`}>
          {hardCap
            ? `${target?.name} is full (${seatsTaken} of ${target?.capacity}). This school does not allow over-filling a section.`
            : `${target?.name} is over capacity (${seatsTaken} of ${target?.capacity}). Allowed here, but worth checking.`}
        </div>
      )}

      {/* Not a nicety: without it, a user expects the whole year to follow the child and reports
          the history staying behind as data loss. */}
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Attendance and marks already recorded stay with{' '}
        <strong>{current ? name(current.classId, current.sectionId) : 'their current class'}</strong>. Only today onwards moves.
      </p>
    </div>
  );
}

/** Status changes carry consequences (billing, portal access, the seat), so the dialog
 *  spells out what the chosen status will do before the reason is even typed. */
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
            Leaving the school is handled by the withdrawal process instead, so the fee clearance and leaving certificate are issued.
          </p>
          <div><button disabled={!canSubmit} onClick={submit}>{busy ? 'Saving…' : 'Save status'}</button></div>
        </>
      )}
    </div>
  );
}

/** Deletion is for records that should never have existed. The typed confirmation is
 *  deliberate friction; the server additionally refuses once fees or certificates exist. */
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

/**
 * The CNIC is never in the profile payload — revealing it is a separate, audited call, and the
 * number stays hidden until someone deliberately asks for it. Three distinct states, because
 * "we never captured it" and "we captured it but can't read it back" are different facts and
 * collapsing them into one blank would mislead the office.
 */
function CnicRow({ student, onSaved }: { student: StudentDetail; onSaved: () => void }) {
  const [value, setValue] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function reveal() {
    setBusy(true); setErr(null);
    try { setValue((await api.students.revealCnic(student.id)).cnic); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not reveal the CNIC'); }
    finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setErr(null); setNote(null);
    try {
      const res = await api.students.setCnic(student.id, input.trim());
      setEditing(false); setInput(''); setValue(null);
      setNote(res.loginProvisioned
        ? `Saved — portal login created. They sign in with registration number ${res.registrationNo ?? '—'} and this CNIC.`
        : res.replacedExisting
          ? 'Saved — the previous CNIC no longer works for signing in.'
          : 'Saved.');
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save the CNIC');
    } finally { setBusy(false); }
  }

  return (
    <div className="stack" style={{ gap: 4 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="muted" style={{ minWidth: 150, fontSize: 13 }}>CNIC / B-Form</span>

        {!student.hasCnic ? <span className="muted">Not provided</span>
          : value ? (
            <>
              <span>{value}</span>
              <button className="ghost small" onClick={() => setValue(null)}>Hide</button>
            </>
          ) : (
            <>
              <span>•••••-•••••••-•</span>
              {student.cnicRevealable
                ? <button className="ghost small" disabled={busy} onClick={reveal}>{busy ? 'Revealing…' : 'Reveal'}</button>
                : <span className="muted" style={{ fontSize: 12 }}>on file — recorded before it could be shown</span>}
            </>
          )}

        {!editing && (
          <button className="ghost small" onClick={() => { setEditing(true); setNote(null); }}>
            {student.hasCnic ? 'Change' : 'Add CNIC'}
          </button>
        )}
      </div>

      {editing && (
        <div className="stack" style={{ gap: 4, paddingLeft: 158 }}>
          <div className="row" style={{ gap: 8, justifyContent: 'flex-start' }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="12345-1234567-1"
              inputMode="numeric" style={{ maxWidth: 200 }}
              onKeyDown={(e) => { if (e.key === 'Enter' && input.trim()) save(); }} />
            <button disabled={busy || !input.trim()} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
            <button className="ghost" onClick={() => { setEditing(false); setInput(''); setErr(null); }}>Cancel</button>
          </div>
          {/* Say the consequence BEFORE the click. Replacing a CNIC changes a live credential —
              the student's old number stops working the moment this is saved. */}
          <span className="muted" style={{ fontSize: 12 }}>
            {student.hasCnic
              ? 'This replaces the current CNIC. The old number will stop working for the student portal.'
              : "Recording a CNIC also creates the student's portal login."}
          </span>
        </div>
      )}

      {note && <span style={{ color: '#15803d', fontSize: 12, paddingLeft: 158 }}>{note}</span>}
      {err && <span style={{ color: '#b91c1c', fontSize: 12, paddingLeft: 158 }}>{err}</span>}
    </div>
  );
}

function StudentProfile({ id, classes, sections, onBack }: { id: string; classes: Klass[]; sections: Section[]; onBack: () => void }) {
  const [s, setS] = useState<StudentDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  /** Named so the CNIC row can refresh the profile after saving — hasCnic, cnicRevealable and
   *  portalLoginEnabled all change together, and a stale card would contradict what just happened. */
  const load = useCallback(() => {
    apiGet<StudentDetail>(`/students/${id}`).then(setS).catch((e) => setError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', 'Failed')));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const className = (cid: string) => classes.find((c) => c.id === cid)?.name ?? '?';
  const sectionName = (sid: string) => sections.find((x) => x.id === sid)?.name ?? '?';
  const active = s?.enrollments.find((e) => e.status === 'ACTIVE') ?? s?.enrollments[0];
  const Row = ({ k, v }: { k: string; v?: string | number | null }) =>
    v === undefined || v === null || v === '' ? null : (
      <div style={{ display: 'flex', gap: 8 }}><span className="muted" style={{ minWidth: 150, fontSize: 13 }}>{k}</span><span>{v}</span></div>
    );

  return (
    <div className="stack">
      <div className="row"><h1>Student</h1><button className="ghost" onClick={onBack}>← Back</button></div>
      {error ? (
        <div className="card stack"><div className="toast err">{error.message}</div><div><button className="ghost" onClick={onBack}>Back</button></div></div>
      ) : !s ? (
        <div className="card"><p className="muted">Loading…</p></div>
      ) : (
        <>
          <div className="card stack">
            <h2 style={{ margin: 0 }}>{s.fullName} {s.isActive ? <span className="badge ok">active</span> : <span className="badge bad">inactive</span>}</h2>
            {/* The two permanent IDs, shown as submitted */}
            <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
              <span className="badge" style={{ fontSize: 13 }}>Registration No: {s.registrationNo ?? '—'}</span>
              <span className="badge" style={{ fontSize: 13 }}>GR: {s.grNumber}</span>
            </div>
            <div className="stack" style={{ gap: 4 }}>
              <Row k="Gender" v={s.gender} />
              <Row k="Date of birth" v={s.dateOfBirth?.slice(0, 10)} />
              <CnicRow student={s} onSaved={load} />
              <Row
                k="Portal login"
                v={s.portalLoginEnabled
                  ? `Enabled — signs in with Reg No ${s.registrationNo ?? '—'} + CNIC`
                  : 'Not set up (no CNIC was recorded at admission)'}
              />
            </div>
          </div>

          <div className="card stack">
            <h3 style={{ margin: 0, fontSize: 15 }}>Current enrollment</h3>
            {active ? (
              <div className="stack" style={{ gap: 4 }}>
                <Row k="Class" v={className(active.classId)} />
                <Row k="Section" v={sectionName(active.sectionId)} />
                <Row k="Roll number" v={active.rollNumber ?? '—'} />
                <Row k="Status" v={active.status} />
              </div>
            ) : <p className="muted" style={{ margin: 0, fontSize: 13 }}>No enrollment.</p>}
          </div>

          <StudentFeesCard studentId={s.id} />

          <div className="card stack">
            <h3 style={{ margin: 0, fontSize: 15 }}>Guardians</h3>
            {s.guardians.length === 0 ? <p className="muted" style={{ margin: 0, fontSize: 13 }}>None.</p> :
              s.guardians.map((g) => (
                <div key={g.id} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <strong>{g.parent.fullName}</strong>
                  <span className="muted">{g.relation}</span>
                  <span className="muted">{g.parent.phone}</span>
                  {g.isPrimary && <span className="badge ok">primary</span>}
                </div>
              ))}
          </div>
        </>
      )}
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


/**
 * What this family owes, what they have paid, and the evidence for it.
 *
 * The "portfolio" view: before this, a receipt existed only as a row in the fees screen and the
 * screenshot that justified a bank transfer existed only in somebody's WhatsApp. Proof opens
 * through a short-lived signed link — the object itself stays private, and the link is minted
 * only after the server has checked you may see that payment.
 */
function StudentFeesCard({ studentId }: { studentId: string }) {
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    apiGet<Paged<Invoice>>(`/fees/invoices?studentId=${studentId}&pageSize=100`)
      .then((r) => setInvoices(r.data))
      // A role without fee access simply doesn't get this card — not an error on their screen.
      .catch(() => { setDenied(true); setInvoices([]); });
    apiGet<Paged<Payment>>('/fees/payments?pageSize=100').then((r) => setPayments(r.data)).catch(() => {});
  }, [studentId]);

  async function openProof(paymentId: string) {
    try {
      const { url } = await api.feeSetup.paymentProof(paymentId);
      window.open(url, '_blank', 'noopener');
    } catch { /* the button only shows when proof exists; a failure here is transient */ }
  }

  if (denied || invoices === null) return null;
  if (invoices.length === 0) {
    return (
      <div className="card stack">
        <h3 style={{ margin: 0, fontSize: 15 }}>Fees</h3>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>No invoices have been generated for this student yet.</p>
      </div>
    );
  }

  const outstanding = invoices.reduce((n, i) => n + Math.max(Number(i.totalAmount) - Number(i.paidAmount), 0), 0);
  const forInvoice = (id: string) => payments.filter((p) => p.invoiceId === id);

  return (
    <div className="card stack">
      <div className="row">
        <h3 style={{ margin: 0, fontSize: 15 }}>Fees</h3>
        <span className={outstanding > 0 ? 'badge warn' : 'badge ok'}>
          {outstanding > 0 ? `Rs ${outstanding.toLocaleString()} outstanding` : 'Nothing outstanding'}
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Period</th><th>Total</th><th>Paid</th><th>Status</th><th>Receipts</th></tr></thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id}>
                <td>{i.month ? `${i.month}/${i.year}` : i.year}</td>
                <td>Rs {Number(i.totalAmount).toLocaleString()}</td>
                <td>Rs {Number(i.paidAmount).toLocaleString()}</td>
                <td><span className={`badge ${i.status === 'PAID' ? 'ok' : i.status === 'OVERDUE' ? 'bad' : 'warn'}`}>{i.status}</span></td>
                <td>
                  {forInvoice(i.id).length === 0 ? <span className="muted">—</span> : (
                    <span className="chips">
                      {forInvoice(i.id).map((p) => (
                        <span key={p.id} className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          #{p.receiptNo} · Rs {Number(p.amountPaid).toLocaleString()}
                          <span className="muted" style={{ fontSize: 11 }}>{p.method.replace('_', ' ').toLowerCase()}</span>
                          {p.hasProof && (
                            <button type="button" className="ghost small" style={{ padding: '2px 6px', minHeight: 24 }}
                              onClick={() => openProof(p.id)}>View proof</button>
                          )}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
