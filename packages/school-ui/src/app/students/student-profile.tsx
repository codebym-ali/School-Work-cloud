'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, apiGet, ApiError, type Klass, type Section, type StudentDetail, type StudentDocumentRow } from '@sw/api-client';
import { useMe } from '@sw/session';
import { hasAnyRole } from '@sw/roles';
import { humanizeStatus } from '@sw/ui';
import { MoveStudentDialog } from '@school/components/move-student-dialog';
import { StudentFeesCard } from './student-fees-card';
import { GuardiansCard } from './guardians-card';
import { WithdrawalCard } from './withdrawal';

function StudentPhoto({ studentId, photoKey, name }: { studentId: string; photoKey: string | null; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!photoKey) { setUrl(null); return; }
    let live = true;
    api.students
      .photoUrl(studentId)
      .then((r) => { if (live) setUrl(r.url); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [studentId, photoKey]);

  if (!photoKey) return null;

  const frame: React.CSSProperties = {
    width: 108, height: 132, borderRadius: 8, border: '1px solid var(--border)',
    objectFit: 'cover', background: 'var(--bg-muted, #f1f5f9)', flexShrink: 0,
  };

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
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  type Fields = {
    religion: string | null; addressLine: string | null; city: string | null;
    permanentAddress: string | null; nationality: string | null; bloodGroup: string | null;
    medicalNotes: string | null; previousSchool: string | null; lastClassPassed: string | null;
    lastResult: string | null; reasonForLeaving: string | null; slcReceived: string;
    declarationVersion: string | null; declarationAcceptedBy: string | null;
    emergencyName: string | null; emergencyPhone: string | null; emergencyRelation: string | null;
    photoKey: string | null;
  };

  const [f, setF] = useState<Fields>({
    religion: null, addressLine: null, city: null, permanentAddress: null, nationality: null,
    bloodGroup: null, medicalNotes: null, previousSchool: null, lastClassPassed: null,
    lastResult: null, reasonForLeaving: null, slcReceived: '',
    declarationVersion: null, declarationAcceptedBy: null,
    emergencyName: null, emergencyPhone: null, emergencyRelation: null, photoKey: null,
  });

  function openEditor() {
    setF({
      religion: student.religion, addressLine: student.addressLine, city: student.city,
      permanentAddress: student.permanentAddress, nationality: student.nationality,
      bloodGroup: student.bloodGroup, medicalNotes: student.medicalNotes,
      previousSchool: student.previousSchool, lastClassPassed: student.lastClassPassed,
      lastResult: student.lastResult, reasonForLeaving: student.reasonForLeaving,
      slcReceived: student.slcReceived === null || student.slcReceived === undefined ? '' : String(student.slcReceived),
      declarationVersion: student.declarationVersion, declarationAcceptedBy: student.declarationAcceptedBy,
      emergencyName: student.emergencyName, emergencyPhone: student.emergencyPhone,
      emergencyRelation: student.emergencyRelation, photoKey: student.photoKey,
    });
    setOpen(true); setErr(null); setMsg(null);
  }
  const set = <K extends keyof Fields>(k: K, v: Fields[K]) => setF((p) => ({ ...p, [k]: v }));

  async function attachPhoto(file: File) {
    setPhotoBusy(true);
    try {
      const { fileKey } = await api.uploads.upload(file);
      set('photoKey', fileKey);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not upload the photo');
    } finally { setPhotoBusy(false); }
  }

  const emergency = [f.emergencyName ?? student.emergencyName, f.emergencyPhone ?? student.emergencyPhone, f.emergencyRelation ?? student.emergencyRelation].filter(Boolean).join(' · ') || null;

  async function save() {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const { slcReceived, declarationVersion, declarationAcceptedBy, ...text } = f;
      await api.students.update(student.id, {
        ...text,
        ...(declarationVersion ? { declarationVersion, declarationAcceptedBy: declarationAcceptedBy || undefined } : {}),
        slcReceived: slcReceived === '' ? null : slcReceived === 'true',
      });
      setMsg('Record updated.');
      setTimeout(() => setMsg(null), 3000);
      setOpen(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save');
    } finally { setBusy(false); }
  }

  const Row = ({ k, v }: { k: string; v?: string | number | null }) =>
    v === undefined || v === null || v === '' ? null : (
      <div style={{ display: 'flex', gap: 8 }}><span className="muted" style={{ minWidth: 150, fontSize: 13 }}>{k}</span><span>{v}</span></div>
    );

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
          {student.slcReceived !== null && student.slcReceived !== undefined && (
            <Row k="Leaving certificate" v={student.slcReceived ? 'Received' : 'NOT received - chase the previous school'} />
          )}
          <Row k="Photograph" v={student.photoKey ? 'On file' : null} />
          <Row
            k="Parent declaration"
            v={student.declarationAcceptedAt
              ? `${student.declarationVersion ?? 'accepted'} - ${student.declarationAcceptedBy ?? 'unnamed'} on ${new Date(student.declarationAcceptedAt).toLocaleDateString('en-GB')}`
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
            {f.photoKey ? <span className="badge ok">photo attached</span> : <span className="muted" style={{ fontSize: 13 }}>No photograph on file</span>}
            <label className="ghost small" style={{ cursor: photoBusy ? 'progress' : 'pointer' }}>
              {photoBusy ? 'Uploading…' : f.photoKey ? 'Replace photo' : '📎 Attach photo'}
              <input type="file" hidden accept="image/*" aria-label="Student photograph"
                onChange={(e) => { const file = e.target.files?.[0]; if (file) void attachPhoto(file); }} />
            </label>
          </div>

          <div className="section-title">Parent declaration</div>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))' }}>
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
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save that');
    } finally { setBusy(null); }
  }

  async function attach(row: StudentDocumentRow, file: File) {
    setBusy(row.type); setErr(null);
    try {
      const { fileKey } = await api.uploads.upload(file);
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
        <div className="stack" style={{ gap: 0 }}>
          {rows.map((r) => (
            <div key={r.type} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid #edf0f5' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flex: '1 1 0', minWidth: 0 }}>
                <input
                  type="checkbox"
                  checked={r.received}
                  disabled={busy === r.type}
                  onChange={(e) => void write(r.type, { received: e.target.checked, fileKey: r.fileKey ?? undefined, note: r.note ?? undefined })}
                  aria-label={r.label}
                  style={{ width: 16, height: 16, flexShrink: 0 }}
                />
                <span style={{ fontSize: 14 }}>
                  {r.label}
                  {r.mandatory && <span className="muted" style={{ fontSize: 12 }}> · required</span>}
                </span>
              </label>

              {r.received && r.receivedAt && (
                <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                  {new Date(r.receivedAt).toLocaleDateString('en-GB')}
                </span>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                {r.fileKey ? (
                  <span className="badge ok" style={{ fontSize: 12 }}>scan attached</span>
                ) : (
                  <label className="ghost small" style={{ cursor: busy === r.type ? 'progress' : 'pointer', whiteSpace: 'nowrap' }}>
                    {busy === r.type ? 'Working…' : '📎 Attach scan'}
                    <input type="file" hidden accept="image/*,application/pdf" aria-label={`Attach ${r.label}`}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) void attach(r, f); }} />
                  </label>
                )}

                {noteFor === r.type ? (
                  <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Note"
                      aria-label={`Note for ${r.label}`} style={{ width: 160 }} />
                    <button className="ghost small" disabled={busy === r.type}
                      onClick={() => { void write(r.type, { received: r.received, fileKey: r.fileKey ?? undefined, note: noteText }); setNoteFor(null); }}>
                      Save
                    </button>
                  </span>
                ) : (
                  <button className="ghost small" style={{ whiteSpace: 'nowrap' }} onClick={() => { setNoteFor(r.type); setNoteText(r.note ?? ''); }}>
                    {r.note ? `Note: ${r.note}` : 'Add note'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function StudentProfile({ id, classes, sections, onBack }: { id: string; classes: Klass[]; sections: Section[]; onBack: () => void }) {
  const profileMe = useMe();
  const [s, setS] = useState<StudentDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [moving, setMoving] = useState(false);
  const [moved, setMoved] = useState<string | null>(null);
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
            <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
              <div className="stack" style={{ gap: 10, minWidth: 0, flex: 1 }}>
                <h2 style={{ margin: 0 }}>{s.fullName} {s.isActive ? <span className="badge ok">active</span> : <span className="badge bad">inactive</span>}</h2>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <span className="badge" style={{ fontSize: 13 }}><span className="muted" style={{ fontSize: 11 }}>REG</span> {s.registrationNo ?? '—'}</span>
                  <span className="badge" style={{ fontSize: 13 }}><span className="muted" style={{ fontSize: 11 }}>GR</span> {s.grNumber}</span>
                </div>
                <div className="stack" style={{ gap: 4 }}>
                  <Row k="Gender" v={humanizeStatus(s.gender)} />
                  <Row k="Date of birth" v={s.dateOfBirth ? new Date(s.dateOfBirth).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : undefined} />
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

          <RecordCard student={s} onSaved={load} />
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
              {active && <button className="ghost small" onClick={() => setMoving(true)}>Move</button>}
            </div>
            {active ? (
              <div className="stack" style={{ gap: 4 }}>
                <Row k="Class" v={className(active.classId)} />
                <Row k="Section" v={sectionName(active.sectionId)} />
                <Row k="Roll number" v={active.rollNumber ?? '—'} />
                <Row k="Status" v={humanizeStatus(active.status)} />
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
