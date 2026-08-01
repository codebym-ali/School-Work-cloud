'use client';

import { useMemo, useState } from 'react';
import { api, ApiError, type AdmissionResult, type Campus, type Klass, type ParentMatch, type Section } from '@/lib/api';
import { classLabeller } from '@/lib/labels';

/**
 * One-form direct admission (§8, #35) — the ADMISSION_CONTROLLER's sole path to enrol a
 * student. No inquiry, no entry test: pick Campus → Class → Section, enter the student's
 * details (+ optional CNIC to provision the portal login), resolve the guardian by an
 * EXPLICIT match→link or create, and admit. An age-range miss returns a soft-warn 422 that
 * the controller can override in place.
 */
export function DirectAdmission({
  campuses, classes, sections, onAdmitted,
}: {
  campuses: Campus[];
  classes: Klass[];
  sections: Section[];
  onAdmitted: (r: AdmissionResult, name: string) => void;
}) {
  const classLabel = classLabeller(classes, campuses);
  const [f, setF] = useState<Record<string, string>>({ gender: 'MALE' });
  const set = (k: string, v: string) => setF((prev) => ({ ...prev, [k]: v }));

  // Guardian resolution: null until the controller has picked link-or-create.
  const [guardian, setGuardian] = useState<GuardianChoice>({ mode: 'CREATE', relation: 'FATHER' });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An out-of-range age comes back as a 422 the controller can override without re-typing.
  const [ageWarning, setAgeWarning] = useState<string | null>(null);
  const [done, setDone] = useState<{ result: AdmissionResult; name: string } | null>(null);

  const classesForCampus = useMemo(
    () => (f.campusId ? classes.filter((c) => c.campusId === f.campusId) : []),
    [classes, f.campusId],
  );
  const sectionsForClass = useMemo(
    () => (f.classId ? sections.filter((s) => s.classId === f.classId) : []),
    [sections, f.classId],
  );

  // The guardian is OPTIONAL, but half a guardian is not: once anything has been typed the
  // details must be complete, so a partly-filled section can't be silently dropped on submit.
  const guardianTouched =
    guardian.mode === 'LINK' ? Boolean(guardian.parentId) : Boolean(guardian.fullName || guardian.phone || guardian.cnic || guardian.email);
  const guardianComplete =
    guardian.mode === 'LINK' ? Boolean(guardian.parentId) : Boolean(guardian.fullName && guardian.phone);
  const guardianReady = !guardianTouched || guardianComplete;
  const ready = Boolean(f.campusId && f.classId && f.sectionId && f.fullName && f.dateOfBirth && guardianReady);

  async function submit(ageOverride: boolean) {
    setBusy(true);
    setError(null);
    setAgeWarning(null);
    try {
      const body = {
        fullName: f.fullName, gender: f.gender, dateOfBirth: f.dateOfBirth,
        campusId: f.campusId, classId: f.classId, sectionId: f.sectionId,
        cnic: f.cnic || undefined,
        rollNumber: f.rollNumber ? Number(f.rollNumber) : undefined,
        ageOverride: ageOverride || undefined,
        // Omitted entirely when nothing was entered — the student is admitted with no
        // guardian and shows a "no guardian" flag in the directory until one is added.
        guardian: !guardianTouched
          ? undefined
          : guardian.mode === 'LINK'
            ? { mode: 'LINK' as const, parentId: guardian.parentId, relation: guardian.relation }
            : {
                mode: 'CREATE' as const,
                fullName: guardian.fullName, phone: guardian.phone, relation: guardian.relation,
                cnic: guardian.cnic || undefined, email: guardian.email || undefined,
              },
      };
      const result = await api.students.admit(body);
      setDone({ result, name: f.fullName });
      onAdmitted(result, f.fullName);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'AGE_OUT_OF_RANGE') {
        setAgeWarning(e.message);
      } else if (e instanceof ApiError && e.code === 'CONFLICT' && guardian.mode === 'CREATE') {
        setError('A parent with this phone already exists — use "Find" to link them instead of creating a duplicate.');
      } else {
        setError(e instanceof ApiError ? e.message : 'Admission failed');
      }
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card stack">
        <h2 style={{ margin: 0, fontSize: 17 }}>✅ Admitted {done.name}</h2>
        <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
          <span className="badge ok" style={{ fontSize: 13 }}>Registration No: {done.result.registrationNo ?? '—'}</span>
          <span className="badge" style={{ fontSize: 13 }}>GR: {done.result.grNumber}</span>
        </div>
        {/* This is the moment the officer hands details to the family, so it must carry WHERE to
            sign in — naming the credentials without the address was the whole reason nobody
            could find the student portal. */}
        {done.result.loginProvisioned ? (
          <div className="stack" style={{ gap: 4 }}>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              Student portal login is ready. Give the family these details:
            </p>
            <div style={{ fontSize: 13, lineHeight: 1.7 }}>
              <div>Website: <b>{typeof window === 'undefined' ? '' : window.location.host}/student-login</b></div>
              <div>Registration number: <b>{done.result.registrationNo ?? '—'}</b></div>
              <div>Password: <b>the student&apos;s CNIC / B-Form</b> (the one entered above)</div>
            </div>
          </div>
        ) : (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            No CNIC entered, so no portal login was created yet. Add one any time from the
            student&apos;s profile in <b>Students</b> — that creates the login too.
          </p>
        )}
        <div><button onClick={() => { setDone(null); setF({ gender: 'MALE' }); setGuardian({ mode: 'CREATE', relation: 'FATHER' }); }}>Admit another</button></div>
      </div>
    );
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>Admit a student</h2>

      {/* Placement — Campus → Class → Section cascade */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))' }}>
        <div><label>Campus</label>
          <select value={f.campusId ?? ''} onChange={(e) => setF((p) => ({ ...p, campusId: e.target.value, classId: '', sectionId: '' }))}>
            <option value="">Select…</option>{campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div><label>Class</label>
          <select value={f.classId ?? ''} onChange={(e) => setF((p) => ({ ...p, classId: e.target.value, sectionId: '' }))} disabled={!f.campusId}>
            <option value="">Select…</option>{classesForCampus.map((c) => <option key={c.id} value={c.id}>{classLabel(c)}</option>)}
          </select>
        </div>
        <div><label>Section</label>
          <select value={f.sectionId ?? ''} onChange={(e) => set('sectionId', e.target.value)} disabled={!f.classId}>
            <option value="">Select…</option>{sectionsForClass.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      {/* Student */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))' }}>
        <div><label>Full name</label><input value={f.fullName ?? ''} onChange={(e) => set('fullName', e.target.value)} /></div>
        <div><label>Gender</label><select value={f.gender} onChange={(e) => set('gender', e.target.value)}><option>MALE</option><option>FEMALE</option><option>OTHER</option></select></div>
        <div><label>Date of birth</label><input type="date" value={f.dateOfBirth ?? ''} onChange={(e) => set('dateOfBirth', e.target.value)} /></div>
        <div><label>CNIC / B-Form (optional)</label><input value={f.cnic ?? ''} onChange={(e) => set('cnic', e.target.value)} placeholder="12345-1234567-1" /></div>
        <div><label>Roll number (optional)</label><input type="number" min={1} value={f.rollNumber ?? ''} onChange={(e) => set('rollNumber', e.target.value)} placeholder="auto" /></div>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        A CNIC provisions the read-only portal login (registration-no + CNIC). GR &amp; registration numbers are assigned on save.
      </p>

      {/* Guardian match → link / create */}
      <GuardianSection value={guardian} onChange={setGuardian} />

      {ageWarning && (
        <div className="toast warn stack" style={{ gap: 8 }}>
          <span>⚠️ {ageWarning}</span>
          <div className="inline-form">
            <button className="small" disabled={busy} onClick={() => submit(true)}>Admit anyway (override age)</button>
            <span className="muted" style={{ fontSize: 12 }}>The override is recorded in the audit log.</span>
          </div>
        </div>
      )}
      {error && <div className="toast err">{error}</div>}

      <div className="inline-form">
        <button disabled={!ready || busy} onClick={() => submit(false)}>{busy ? 'Admitting…' : 'Admit student'}</button>
      </div>
    </div>
  );
}

type GuardianChoice =
  | { mode: 'CREATE'; relation: string; fullName?: string; phone?: string; cnic?: string; email?: string }
  | { mode: 'LINK'; relation: string; parentId?: string; phone?: string };

function GuardianSection({ value, onChange }: { value: GuardianChoice; onChange: (g: GuardianChoice) => void }) {
  const [phone, setPhone] = useState('');
  const [matches, setMatches] = useState<ParentMatch[] | null>(null);
  const [searching, setSearching] = useState(false);

  async function find() {
    setSearching(true);
    try {
      const found = await api.students.findParents(phone);
      setMatches(found);
      // A match defaults to LINK (the whole point — siblings share one parent); none ⇒ CREATE.
      if (found.length > 0) {
        onChange({ mode: 'LINK', relation: value.relation, parentId: found[0].id, phone });
      } else {
        onChange({ mode: 'CREATE', relation: value.relation, phone });
      }
    } catch {
      setMatches([]);
      onChange({ mode: 'CREATE', relation: value.relation, phone });
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 15 }}>
          Guardian <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>— optional</span>
        </h3>
        {/* Stated up front, not after the fact: leaving this blank has a real, permanent
            consequence until someone comes back and fills it in. */}
        <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
          Leave blank to admit now and add the guardian later. Until one is added the school
          <b> cannot send any SMS</b> about this student — no absence alerts, fee receipts or
          results — and they&apos;ll be flagged <b>no guardian</b> in Students.
        </p>
      </div>
      <div className="inline-form">
        <div style={{ minWidth: 200 }}><label>Phone</label>
          <input value={phone} onChange={(e) => { setPhone(e.target.value); setMatches(null); }} placeholder="03001234567"
            onKeyDown={(e) => e.key === 'Enter' && phone && find()} />
        </div>
        <button className="ghost small" disabled={!phone || searching} onClick={find}>{searching ? 'Finding…' : 'Find'}</button>
      </div>

      {matches && matches.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <span className="muted" style={{ fontSize: 13 }}>Existing parent(s) with this phone — link to keep siblings under one guardian:</span>
          {matches.map((m) => (
            <label key={m.id} className="row" style={{ justifyContent: 'flex-start', gap: 8, cursor: 'pointer' }}>
              <input type="radio" name="parent" checked={value.mode === 'LINK' && value.parentId === m.id}
                onChange={() => onChange({ mode: 'LINK', relation: value.relation, parentId: m.id, phone })} />
              <strong>{m.fullName}</strong><span className="muted">{m.phone}</span>
            </label>
          ))}
          <label className="row" style={{ justifyContent: 'flex-start', gap: 8, cursor: 'pointer' }}>
            <input type="radio" name="parent" checked={value.mode === 'CREATE'}
              onChange={() => onChange({ mode: 'CREATE', relation: value.relation, phone })} />
            <span>Create a new guardian instead</span>
          </label>
        </div>
      )}
      {matches && matches.length === 0 && (
        <span className="muted" style={{ fontSize: 13 }}>No existing parent with this phone — a new guardian will be created.</span>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))' }}>
        {value.mode === 'CREATE' && (
          <>
            <div><label>Guardian name</label>
              <input value={value.fullName ?? ''} onChange={(e) => onChange({ ...value, fullName: e.target.value })} /></div>
            <div><label>Guardian phone</label>
              <input value={value.phone ?? phone} onChange={(e) => onChange({ ...value, phone: e.target.value })} placeholder="03001234567" /></div>
            <div><label>CNIC (optional)</label>
              <input value={value.cnic ?? ''} onChange={(e) => onChange({ ...value, cnic: e.target.value })} /></div>
            <div><label>Email (optional)</label>
              <input value={value.email ?? ''} onChange={(e) => onChange({ ...value, email: e.target.value })} /></div>
          </>
        )}
        <div><label>Relation</label>
          <select value={value.relation} onChange={(e) => onChange({ ...value, relation: e.target.value })}>
            <option>FATHER</option><option>MOTHER</option><option>GUARDIAN</option>
          </select>
        </div>
      </div>
    </div>
  );
}
