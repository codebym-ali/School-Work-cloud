'use client';

import { type ChangeEvent, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, apiGet, apiPost, ApiError, type Campus, type ImportResult, type Klass, type Paged, type Section, type Student, type StudentDetail, type StudentDocumentRow, type StudentStatus } from '@sw/api-client';
import { useCampusLens } from '@sw/session';
import { classLabeller } from '@school/lib/labels';
import { hasModule, useMe } from '@sw/session';
import { STATUS_TRANSITIONS, STUDENT_STATUS, statusStyle } from '@sw/ui';
import { MoveStudentDialog } from '@school/components/move-student-dialog';
import { DirectAdmission } from '../admissions/direct-admission';
import { StudentFeesCard } from './student-fees-card';
import { hasAnyRole } from '@sw/roles';
import { GuardiansCard } from './guardians-card';
import { WithdrawalCard } from './withdrawal';
import { OwnerStudentsHub } from './owner-hub';

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
  const campusId = lens.campusId ?? ''; // campus from the shell lens, not the URL
  const classId = params.get('classId') ?? '';
  const sectionId = params.get('sectionId') ?? '';

  const [students, setStudents] = useState<Student[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [classes, setClasses] = useState<Klass[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  // `?student=<id>` opens a profile directly — so other screens (defaulters, activity) can link to one.
  const [detailId, setDetailId] = useState<string | null>(params.get('student'));
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
    // The owner's hub loads its own list; the office list below is not rendered for them.
    if (me && !isOwner) load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lens.campusId, classId, sectionId, statusFilter, missingGuardian, me, isOwner]);

  // Push a new filter into the URL so the view is shareable and the effect reloads.
  // Campus is the shell lens now; only the class/section drill lives in the URL.
  function setFilter(next: { classId?: string; sectionId?: string }) {
    const merged = { classId, sectionId, ...next };
    const qs = new URLSearchParams();
    if (merged.classId) qs.set('classId', merged.classId);
    if (merged.sectionId) qs.set('sectionId', merged.sectionId);
    const q = qs.toString();
    router.replace(q ? `/students?${q}` : '/students');
  }

  // A class/section chosen inside one branch does not apply after the director switches branch.
  // Reset the drill whenever the lens moves, so the cascade never carries a stale campus's class.
  const lastLens = useRef(lens.campusId);
  useEffect(() => {
    if (lastLens.current !== lens.campusId) {
      lastLens.current = lens.campusId;
      if (classId || sectionId) router.replace('/students');
    }
  }, [lens.campusId, classId, sectionId, router]);

  // Classes are scoped to the campus lens; the class/section drill operates within it. The API
  // force-scopes a campus-bound user regardless, so the lens is convenience, never the boundary.
  const classesForCampus = campusId ? classes.filter((c) => c.campusId === campusId) : classes;
  const classLabel = classLabeller(classesForCampus, campuses);
  const sectionsForClass = classId ? sections.filter((s) => s.classId === classId) : [];
  const activeClass = classes.find((c) => c.id === classId);
  const activeSection = sections.find((s) => s.id === sectionId);
  const hasFilter = Boolean(campusId || classId || sectionId);

  // Until we know who is looking, render neither view — the owner must never flash the office list.
  if (!me) return <p className="muted">Loading…</p>;

  // The owner gets the oversight hub (Owner UX 1b); the office roles keep this working list.
  // ⚠️ The hub stays MOUNTED (hidden) under an open profile, so "← Back" returns to the list exactly as
  // it was left — tile, search, sort and page — instead of a fresh first page.
  if (isOwner) {
    return (
      <div className="stack">
        {detailId && <StudentProfile id={detailId} classes={classes} sections={sections} onBack={() => setDetailId(null)} />}
        {/* Inline display, not `hidden`: `.stack { display: flex }` would override the attribute. */}
        <div className="stack" style={detailId ? { display: 'none' } : undefined}>
          {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}
          {deleteFor && (
            <DeleteStudentDialog student={deleteFor} onClose={() => setDeleteFor(null)}
              onDone={(text) => { setDeleteFor(null); setMsg({ ok: true, text }); setHubReload((k) => k + 1); }}
              onError={(text) => setMsg({ ok: false, text })} />
          )}
          <OwnerStudentsHub onOpenProfile={setDetailId} onDelete={(s) => { setMsg(null); setDeleteFor(s); }} reloadKey={hubReload} />
        </div>
      </div>
    );
  }

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
            Leaving the school is not a status: use <strong>Withdraw student</strong> on the profile, which issues the leaving certificate and stops billing.
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
/**
 * The admission record - what is outstanding, and the form that closes it.
 *
 * WARNING: **This is the other half of the admission form's deliberate emptiness.** A walk-in is
 * seated in under a minute with almost nothing on file (Admission Form Field Gaps), which is only
 * defensible if the gaps are visible afterwards and fillable without re-admitting the child. Until
 * now `PATCH /students/:id` had **no caller at all**, so the profile could show an incomplete
 * student and offer no way to correct it.
 *
 * Collapsed by default: most visits to a profile are to look something up, not to edit.
 */
/**
 * The student's photograph, top-right of the profile.
 *
 * ⚠️ **The key is not a URL and cannot be used as one.** The bucket is private, so the component
 * exchanges `photoKey` for a ten-minute presigned link at render time. That is also why the link is
 * fetched here rather than carried on the profile payload: a URL minted with every profile read
 * would expire in the background of a page left open, and the image would quietly vanish.
 *
 * ⚠️ **Renders nothing at all when there is no photo** — no grey silhouette placeholder. Most
 * records on a real intake have no photograph for weeks, and a permanent empty frame on every one
 * of them is noise that teaches people to stop looking at that corner. The "Photograph" row in the
 * record card below is where its absence is already reported, next to everything else outstanding.
 */
function StudentPhoto({ studentId, photoKey, name }: { studentId: string; photoKey: string | null; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!photoKey) { setUrl(null); return; }
    let live = true;
    api.students
      .photoUrl(studentId)
      // `live` guards against a response arriving after the office clicked through to another
      // student — otherwise one child's face lands on another child's profile.
      .then((r) => { if (live) setUrl(r.url); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [studentId, photoKey]);

  if (!photoKey) return null;

  const frame: React.CSSProperties = {
    width: 108, height: 132, borderRadius: 8, border: '1px solid var(--border)',
    objectFit: 'cover', background: 'var(--bg-muted, #f1f5f9)', flexShrink: 0,
  };

  // A broken image is reported rather than left as a torn-icon box: the usual cause is an expired
  // or refused link, which is a fixable condition and not the same as "no photo was ever taken".
  if (failed) {
    return (
      <div style={{ ...frame, display: 'grid', placeItems: 'center', padding: 8, textAlign: 'center' }}>
        <span className="muted" style={{ fontSize: 12 }}>Photo could not be loaded</span>
      </div>
    );
  }
  if (!url) return <div style={frame} aria-hidden />;
  return <img src={url} alt={`Photograph of ${name}`} style={frame} />;
}

function RecordCard({ student, onSaved }: { student: StudentDetail; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [photoBusy, setPhotoBusy] = useState(false);

  // Its own Row: the one in StudentProfile is a closure over that component's scope.
  const Row = ({ k, v }: { k: string; v?: string | null }) =>
    v === undefined || v === null || v === '' ? null : (
      <div style={{ display: 'flex', gap: 8 }}>
        <span className="muted" style={{ minWidth: 150, fontSize: 13 }}>{k}</span><span>{v}</span>
      </div>
    );

  // Seeded from the student each time the editor opens, so it never shows a stale draft after a save.
  function openEditor() {
    setF({
      religion: student.religion ?? '', addressLine: student.addressLine ?? '', city: student.city ?? '',
      permanentAddress: student.permanentAddress ?? '', nationality: student.nationality ?? '',
      emergencyName: student.emergencyName ?? '', emergencyPhone: student.emergencyPhone ?? '',
      emergencyRelation: student.emergencyRelation ?? '',
      previousSchool: student.previousSchool ?? '', lastClassPassed: student.lastClassPassed ?? '',
      lastResult: student.lastResult ?? '', reasonForLeaving: student.reasonForLeaving ?? '',
      slcReceived: student.slcReceived === null || student.slcReceived === undefined ? '' : String(student.slcReceived),
      bloodGroup: student.bloodGroup ?? '', medicalNotes: student.medicalNotes ?? '',
      photoKey: student.photoKey ?? '',
      declarationVersion: student.declarationVersion ?? '', declarationAcceptedBy: student.declarationAcceptedBy ?? '',
    });
    setMsg(null); setErr(null); setOpen(true);
  }
  const set = (k: string, v: string) => setF((prev) => ({ ...prev, [k]: v }));

  async function attachPhoto(file: File) {
    setPhotoBusy(true); setErr(null);
    try {
      const { fileKey } = await api.uploads.upload(file);
      // Held in the draft, saved with the rest of the form: attaching a photo and then abandoning
      // the editor should not silently change the record.
      set('photoKey', fileKey);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not upload that photo');
    } finally { setPhotoBusy(false); }
  }

  const emergency = student.emergencyName
    ? [student.emergencyName, student.emergencyPhone, student.emergencyRelation].filter(Boolean).join(' - ')
    : null;

  async function save() {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const { slcReceived, declarationVersion, declarationAcceptedBy, ...text } = f;
      await api.students.update(student.id, {
        ...text,
        // Sent only when there is something to record. An empty version would otherwise stamp an
        // acceptance date for a declaration nobody agreed to.
        ...(declarationVersion ? { declarationVersion, declarationAcceptedBy: declarationAcceptedBy || undefined } : {}),
        // WARNING: tri-state, not a checkbox. "" means nobody has asked yet, which is a different
        // fact from "asked, and the old school has not handed it over".
        slcReceived: slcReceived === '' ? null : slcReceived === 'true',
      });
      setMsg('Record updated.');
      setOpen(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save');
    } finally { setBusy(false); }
  }

  return (
    <div className="card stack">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 17 }}>Admission record</h2>
          {student.missingFields.length === 0 ? (
            <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>Nothing outstanding.</p>
          ) : (
            <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>
              Still needed: <b>{student.missingFields.join(' - ')}</b>
            </p>
          )}
        </div>
        {!open && <button className="ghost small" onClick={openEditor}>Complete the record</button>}
      </div>

      {msg && <div className="toast ok">{msg}</div>}
      {err && <div className="toast err">{err}</div>}

      {/* Read-only summary shows only what IS known - an empty row for every unfilled field would
          bury the handful that are actually there. */}
      {!open && (
        <div className="stack" style={{ gap: 4 }}>
          <Row k="Religion" v={student.religion} />
          <Row k="Address" v={[student.addressLine, student.city].filter(Boolean).join(', ') || null} />
          <Row k="Permanent address" v={student.permanentAddress} />
          <Row k="Nationality" v={student.nationality} />
          <Row k="Emergency contact" v={emergency} />
          <Row k="Blood group" v={student.bloodGroup} />
          <Row k="Medical notes" v={student.medicalNotes} />
          <Row k="Previous school" v={student.previousSchool} />
          <Row k="Last class passed" v={student.lastClassPassed} />
          <Row k="Last result" v={student.lastResult} />
          <Row k="Reason for leaving" v={student.reasonForLeaving} />
          {/* Shown only once someone has actually asked - see the tri-state note. */}
          {student.slcReceived !== null && student.slcReceived !== undefined && (
            <Row k="Leaving certificate" v={student.slcReceived ? 'Received' : 'NOT received - chase the previous school'} />
          )}
          <Row k="Photograph" v={student.photoKey ? 'On file' : null} />
          {/* The VERSION is shown, not just "accepted": which wording a parent agreed to is the
              question actually asked when a declaration is disputed. */}
          <Row
            k="Parent declaration"
            v={student.declarationAcceptedAt
              ? `${student.declarationVersion ?? 'accepted'} - ${student.declarationAcceptedBy ?? 'unnamed'} on ${new Date(student.declarationAcceptedAt).toLocaleDateString()}`
              : null}
          />
        </div>
      )}

      {open && (
        <div className="stack">
          <div className="section-title">Student</div>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))' }}>
            <div><label>Religion</label><input value={f.religion ?? ''} onChange={(e) => set('religion', e.target.value)} placeholder="e.g. Islam" /></div>
            <div><label>Address</label><input value={f.addressLine ?? ''} onChange={(e) => set('addressLine', e.target.value)} placeholder="House / street / area" /></div>
            <div><label>City</label><input value={f.city ?? ''} onChange={(e) => set('city', e.target.value)} /></div>
            <div><label>Permanent address</label><input value={f.permanentAddress ?? ''} onChange={(e) => set('permanentAddress', e.target.value)} placeholder="Hometown / village, if different" /></div>
            <div><label>Nationality</label><input value={f.nationality ?? ''} onChange={(e) => set('nationality', e.target.value)} placeholder="Pakistani" /></div>
            <div><label>Blood group</label><input value={f.bloodGroup ?? ''} onChange={(e) => set('bloodGroup', e.target.value)} placeholder="e.g. O+" /></div>
          </div>

          <div className="section-title">Emergency contact</div>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))' }}>
            <div><label>Name</label><input value={f.emergencyName ?? ''} onChange={(e) => set('emergencyName', e.target.value)} /></div>
            <div><label>Phone</label><input value={f.emergencyPhone ?? ''} onChange={(e) => set('emergencyPhone', e.target.value)} placeholder="03001234567" /></div>
            <div><label>Relation</label><input value={f.emergencyRelation ?? ''} onChange={(e) => set('emergencyRelation', e.target.value)} placeholder="e.g. Uncle" /></div>
          </div>

          <div className="section-title">Photograph</div>
          <div className="row" style={{ alignItems: 'center', gap: 10 }}>
            {/* The bytes go browser → storage directly via a presigned PUT; the form only ever
                carries the KEY. `photo_key` existed on the student from the start with nothing
                writing to it — this is its first caller. */}
            {f.photoKey ? <span className="badge ok">photo attached</span> : <span className="muted" style={{ fontSize: 13 }}>No photograph on file</span>}
            <label className="ghost small" style={{ cursor: photoBusy ? 'progress' : 'pointer' }}>
              {photoBusy ? 'Uploading…' : f.photoKey ? 'Replace photo' : '📎 Attach photo'}
              <input type="file" hidden accept="image/*" aria-label="Student photograph"
                onChange={(e) => { const file = e.target.files?.[0]; if (file) void attachPhoto(file); }} />
            </label>
          </div>

          <div className="section-title">Parent declaration</div>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))' }}>
            {/* ⚠️ Version, not a tick. "The parent agreed" is close to worthless without "agreed to
                WHAT" — the wording changes as fee policy and rules change, and the version is the
                only thing that can answer that later. The DATE is stamped by the server. */}
            <div><label>Declaration version</label><input value={f.declarationVersion ?? ''}
              onChange={(e) => set('declarationVersion', e.target.value)} placeholder="e.g. admission-terms-2026" /></div>
            <div><label>Accepted by</label><input value={f.declarationAcceptedBy ?? ''}
              onChange={(e) => set('declarationAcceptedBy', e.target.value)} placeholder="Parent / guardian name" /></div>
          </div>

          <div className="section-title">Medical</div>
          <div>
            <label>Conditions, allergies, special needs</label>
            <textarea rows={2} style={{ width: '100%' }} value={f.medicalNotes ?? ''}
              onChange={(e) => set('medicalNotes', e.target.value)}
              placeholder="Anything a teacher must know on a trip or in an emergency" />
          </div>

          <div className="section-title">Previous school</div>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            For a transfer admission. Leave blank for a child starting their first school.
          </p>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))' }}>
            <div><label>School name</label><input value={f.previousSchool ?? ''} onChange={(e) => set('previousSchool', e.target.value)} /></div>
            <div><label>Last class passed</label><input value={f.lastClassPassed ?? ''} onChange={(e) => set('lastClassPassed', e.target.value)} /></div>
            <div><label>Last result</label><input value={f.lastResult ?? ''} onChange={(e) => set('lastResult', e.target.value)} placeholder="e.g. 78% / A" /></div>
            <div><label>Reason for leaving</label><input value={f.reasonForLeaving ?? ''} onChange={(e) => set('reasonForLeaving', e.target.value)} /></div>
            <div><label>Leaving certificate</label>
              <select value={f.slcReceived ?? ''} onChange={(e) => set('slcReceived', e.target.value)}>
                <option value="">Not asked yet</option>
                <option value="true">Received</option>
                <option value="false">Not received</option>
              </select>
            </div>
          </div>

          <div className="inline-form">
            <button disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save record'}</button>
            <button className="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

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
  const profileMe = useMe();
  const [s, setS] = useState<StudentDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [moving, setMoving] = useState(false);
  const [moved, setMoved] = useState<string | null>(null);
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
      <div className="row">
        <h1>Student</h1>
        <span className="row" style={{ gap: 8 }}>
          {/* This student's own history in the activity log — "who changed this record, and why", answered in place. */}
          {hasAnyRole(profileMe?.roles, ['OWNER_ADMIN', 'CAMPUS_ADMIN']) && (
            <a className="ghost small" href={`/activity?entityId=${id}`} style={{ textDecoration: 'none' }}>Activity</a>
          )}
          <button className="ghost" onClick={onBack}>← Back</button>
        </span>
      </div>
      {error ? (
        <div className="card stack"><div className="toast err">{error.message}</div><div><button className="ghost" onClick={onBack}>Back</button></div></div>
      ) : !s ? (
        <div className="card"><p className="muted">Loading…</p></div>
      ) : (
        <>
          <div className="card">
            {/* The photograph sits top-right of the identity card, where a school record has always
                put it. `flex-start` so the portrait does not stretch to the card's height, and the
                text column takes the remaining width via min-width:0 — without that, a long name
                pushes the photo off the card instead of wrapping. */}
            <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
              <div className="stack" style={{ gap: 10, minWidth: 0, flex: 1 }}>
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
              <StudentPhoto studentId={s.id} photoKey={s.photoKey} name={s.fullName} />
            </div>
          </div>

          {/* The chase list, directly under the identity card - the whole point of "admit fast,
              then complete the record" is that the outstanding items sit on the screen the office
              already opens, not on a report nobody runs. */}
          <RecordCard student={s} onSaved={load} />

          {/* Directly under the record card: the paperwork IS most of what an admission consists
              of, and it belongs on the screen the office already has open. */}
          <DocumentsCard studentId={s.id} onSaved={load} />

          <WithdrawalCard student={s} onChanged={load} />

          {moving && (
            <MoveStudentDialog student={s} classes={classes} sections={sections}
              onClose={() => setMoving(false)}
              onDone={(text) => { setMoving(false); setMoved(text); load(); }}
              onError={(text) => { setMoving(false); setMoved(text); }} />
          )}
          {moved && <div className="toast ok">{moved}</div>}

          <div className="card stack">
            <div className="row">
              <h3 style={{ margin: 0, fontSize: 15 }}>Current enrollment</h3>
              {/* X2: the second entry point. Someone reading one child's record is exactly who
                  notices they are in the wrong room, and sending them back to the list to act on
                  what is already on screen is how a capability goes unused. */}
              {active && <button className="ghost small" onClick={() => setMoving(true)}>Move</button>}
            </div>
            {active ? (
              <div className="stack" style={{ gap: 4 }}>
                <Row k="Class" v={className(active.classId)} />
                <Row k="Section" v={sectionName(active.sectionId)} />
                <Row k="Roll number" v={active.rollNumber ?? '—'} />
                <Row k="Status" v={active.status} />
              </div>
            ) : <p className="muted" style={{ margin: 0, fontSize: 13 }}>No enrollment.</p>}
          </div>

          <StudentFeesCard student={s} />

          <GuardiansCard student={s} onChanged={load} />
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
/**
 * The admission checklist — what the family actually handed in.
 *
 * ⚠️ Attaching a file is OPTIONAL and the tick is the primary action. These documents arrive as
 * photocopies across a counter far more often than as scans, and a checklist that demanded an upload
 * would be worked around: the office would tick things it had not scanned, or not tick things it had
 * received. A register that lies is worse than no register.
 */
function DocumentsCard({ studentId, onSaved }: { studentId: string; onSaved: () => void }) {
  const [rows, setRows] = useState<StudentDocumentRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');

  const load = useCallback(async () => {
    try {
      setRows(await api.students.documents(studentId));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not load the checklist');
    }
  }, [studentId]);

  useEffect(() => { void load(); }, [load]);

  async function write(type: string, body: { received: boolean; fileKey?: string; note?: string }) {
    setBusy(type); setErr(null);
    try {
      const updated = await api.students.setDocument(studentId, type, body);
      setRows((prev) => (prev ?? []).map((r) => (r.type === type ? updated : r)));
      // The chase list on the card above is derived from these, so it has to be refetched too.
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save that');
    } finally { setBusy(null); }
  }

  async function attach(row: StudentDocumentRow, file: File) {
    setBusy(row.type); setErr(null);
    try {
      const { fileKey } = await api.uploads.upload(file);
      // Attaching a scan IS receipt — making the office tick a second box for the same fact is how
      // a checklist drifts out of agreement with reality.
      await write(row.type, { received: true, fileKey, note: row.note ?? undefined });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not attach that file');
      setBusy(null);
    }
  }

  const outstanding = (rows ?? []).filter((r) => r.mandatory && !r.received);

  return (
    <div className="card stack">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 17 }}>Documents received</h2>
          <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>
            {rows === null
              ? 'Loading…'
              : outstanding.length === 0
                ? 'All required documents are in hand.'
                : <>Still required: <b>{outstanding.map((r) => r.label).join(' · ')}</b></>}
          </p>
        </div>
      </div>

      {err && <div className="toast err">{err}</div>}

      {rows !== null && (
        <div className="stack" style={{ gap: 6 }}>
          {rows.map((r) => (
            <div key={r.type} className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 260, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={r.received}
                  disabled={busy === r.type}
                  onChange={(e) => void write(r.type, { received: e.target.checked, fileKey: r.fileKey ?? undefined, note: r.note ?? undefined })}
                  aria-label={r.label}
                />
                <span>
                  {r.label}
                  {r.mandatory && <span className="muted" style={{ fontSize: 12 }}> · required</span>}
                </span>
              </label>

              {r.received && r.receivedAt && (
                <span className="muted" style={{ fontSize: 12 }}>
                  received {new Date(r.receivedAt).toLocaleDateString()}
                </span>
              )}

              {r.fileKey ? (
                <span className="badge ok">scan attached</span>
              ) : (
                <label className="ghost small" style={{ cursor: busy === r.type ? 'progress' : 'pointer' }}>
                  {busy === r.type ? 'Working…' : '📎 Attach scan'}
                  <input type="file" hidden accept="image/*,application/pdf" aria-label={`Attach ${r.label}`}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void attach(r, f); }} />
                </label>
              )}

              {noteFor === r.type ? (
                <span className="row" style={{ gap: 6 }}>
                  <input value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Note"
                    aria-label={`Note for ${r.label}`} style={{ width: 200 }} />
                  <button className="ghost small" disabled={busy === r.type}
                    onClick={() => { void write(r.type, { received: r.received, fileKey: r.fileKey ?? undefined, note: noteText }); setNoteFor(null); }}>
                    Save
                  </button>
                </span>
              ) : (
                <button className="ghost small" onClick={() => { setNoteFor(r.type); setNoteText(r.note ?? ''); }}>
                  {r.note ? `Note: ${r.note}` : 'Add note'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

