'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, apiGet, ApiError, type AcademicYear, type AdmissionResult, type Campus, type Klass, type ParentMatch, type Section } from '@sw/api-client';
import { classLabeller } from '@school/lib/labels';

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
  /** Defaults to today: the overwhelmingly common case is admitting someone who starts now, and a
   *  blank date field invites the office to leave it blank and lose the fact entirely. */
  const today = new Date().toISOString().slice(0, 10);
  const blankForm = () => ({ gender: 'MALE', admissionDate: today });
  const [f, setF] = useState<Record<string, string>>(blankForm);
  const [photoBusy, setPhotoBusy] = useState(false);
  /** A local object URL, so the clerk sees the face they just chose without a round trip to
   *  storage — the uploaded object is private and would need a presigned GET to read back. */
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);

  /**
   * The session the student is being admitted INTO (Tier 1). Shown, not chosen: the server always
   * enrols into the current academic year (`requireCurrentYearId`), so offering a picker here would
   * be a control that silently does nothing. Mid-year admissions are normal, and "which session is
   * this?" is a question the officer should not have to leave the form to answer.
   */
  const [session, setSession] = useState<string | null>(null);
  useEffect(() => {
    apiGet<AcademicYear[]>('/academic-years')
      .then((ys) => setSession(ys.find((y) => y.isCurrent)?.name ?? null))
      // Non-fatal: the label is context, and the year is decided by the server either way.
      .catch(() => {});
  }, []);
  const set = (k: string, v: string) => setF((prev) => ({ ...prev, [k]: v }));

  /**
   * Upload now, hold the KEY, save it with the form.
   *
   * ⚠️ The bytes go browser → storage directly via a presigned PUT; the API only ever learns where
   * they landed. The key sits in the draft rather than being written to anything, so abandoning a
   * half-filled admission leaves an orphaned object in the bucket and nothing else — the opposite
   * arrangement would create a student row the clerk never confirmed.
   */
  async function attachPhoto(file: File) {
    setPhotoBusy(true);
    try {
      const { fileKey } = await api.uploads.upload(file);
      set('photoKey', fileKey);
      setPhotoPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file); });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not upload that photo');
    } finally { setPhotoBusy(false); }
  }

  /**
   * Guardians — **Father and Mother by default**, because that is the normal case in a Pakistani
   * school, not an edge case (Admission Form Field Gaps, Tier 1). Both are still OPTIONAL: leaving
   * them blank admits the child anyway, which is what lets a walk-in be seated in under a minute.
   *
   * ⚠️ **The first one filled in becomes the PRIMARY guardian** — the one every SMS and fee receipt
   * resolves — so Father leads and the order on screen is the order sent.
   */
  const blankGuardians = (): GuardianChoice[] => ([
    { mode: 'CREATE', relation: 'FATHER' },
    { mode: 'CREATE', relation: 'MOTHER' },
  ]);
  const [guardians, setGuardians] = useState<GuardianChoice[]>(blankGuardians);
  const setGuardianAt = (i: number, g: GuardianChoice) =>
    setGuardians((prev) => prev.map((x, n) => (n === i ? g : x)));

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

  // A guardian is OPTIONAL, but half a guardian is not: once anything has been typed the details
  // must be complete, so a partly-filled block can't be silently dropped on submit. Applied per
  // block, so an untouched Mother never blocks a form that only has a Father.
  const touchedOf = (g: GuardianChoice) =>
    g.mode === 'LINK' ? Boolean(g.parentId) : Boolean(g.fullName || g.phone || g.cnic || g.email || g.occupation);
  const completeOf = (g: GuardianChoice) =>
    g.mode === 'LINK' ? Boolean(g.parentId) : Boolean(g.fullName && g.phone);
  const filledGuardians = guardians.filter(touchedOf);
  const guardianReady = filledGuardians.every(completeOf);
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
        // Office-set joining date — what fee proration and seniority read, not `createdAt`.
        admissionDate: f.admissionDate || undefined,
        ageOverride: ageOverride || undefined,
        religion: f.religion || undefined,
        addressLine: f.addressLine || undefined,
        city: f.city || undefined,
        emergencyName: f.emergencyName || undefined,
        emergencyPhone: f.emergencyPhone || undefined,
        emergencyRelation: f.emergencyRelation || undefined,
        photoKey: f.photoKey || undefined,
        // Omitted entirely when nothing was entered — the student is admitted with no guardian
        // and shows a "no guardian" flag in the directory until one is added. Order is preserved
        // because the server takes the FIRST as primary.
        guardians: filledGuardians.length === 0 ? undefined : filledGuardians.map((g) =>
          g.mode === 'LINK'
            ? { mode: 'LINK' as const, parentId: g.parentId, relation: g.relation }
            : {
                mode: 'CREATE' as const,
                fullName: g.fullName, phone: g.phone, relation: g.relation,
                cnic: g.cnic || undefined, email: g.email || undefined,
                occupation: g.occupation || undefined,
              }),
      };
      const result = await api.students.admit(body);
      setDone({ result, name: f.fullName });
      onAdmitted(result, f.fullName);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'AGE_OUT_OF_RANGE') {
        setAgeWarning(e.message);
      } else if (e instanceof ApiError && e.code === 'CONFLICT' && filledGuardians.some((g) => g.mode === 'CREATE')) {
        // ⚠️ Also the shared-phone case now that there are several blocks: a household where the
        // father and mother give the SAME number resolves to ONE parent record, so the second
        // block must LINK rather than create. The message says which button does that.
        setError('A parent with this phone already exists — use "Find" on that guardian to link them instead of creating a duplicate.');
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
        <div><button onClick={() => {
          setDone(null); setF(blankForm()); setGuardians(blankGuardians());
          // ⚠️ Without this the PREVIOUS child's photograph sits on the next blank form, and the
          // clerk admits a second student carrying the first one's face.
          setPhotoPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
        }}>Admit another</button></div>
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
        {/* Placement, not biography: joining date belongs with the class the student joins, and it
            is the enrolment's `startedAt`. `max` stops a future date being picked at all — the
            server refuses one anyway, but being told before you submit is better than after. */}
        <div><label>Admission date</label>
          <input type="date" max={today} value={f.admissionDate ?? ''} onChange={(e) => set('admissionDate', e.target.value)} />
        </div>
      </div>
      {session && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Admitting into session <b>{session}</b>. Back-date the admission date if the student
          started earlier — fee proration and seniority are calculated from it.
        </p>
      )}

      {/* Student */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))' }}>
        <div><label>Full name</label><input value={f.fullName ?? ''} onChange={(e) => set('fullName', e.target.value)} /></div>
        <div><label>Gender</label><select value={f.gender} onChange={(e) => set('gender', e.target.value)}><option>MALE</option><option>FEMALE</option><option>OTHER</option></select></div>
        <div><label>Date of birth</label><input type="date" value={f.dateOfBirth ?? ''} onChange={(e) => set('dateOfBirth', e.target.value)} /></div>
        <div><label>CNIC / B-Form (optional)</label><input value={f.cnic ?? ''} onChange={(e) => set('cnic', e.target.value)} placeholder="12345-1234567-1" /></div>
        <div><label>Roll number (optional)</label><input type="number" min={1} value={f.rollNumber ?? ''} onChange={(e) => set('rollNumber', e.target.value)} placeholder="auto" /></div>
        {/* Religion is a free list, not a fixed enum: a school may need a spelling its own board
            uses. `datalist` offers the common answers without refusing anything else. */}
        <div><label>Religion</label>
          <input list="religion-options" value={f.religion ?? ''} onChange={(e) => set('religion', e.target.value)} placeholder="e.g. Islam" />
          <datalist id="religion-options">
            <option value="Islam" /><option value="Christianity" /><option value="Hinduism" />
            <option value="Sikhism" /><option value="Other" />
          </datalist>
        </div>
        <div><label>Address</label><input value={f.addressLine ?? ''} onChange={(e) => set('addressLine', e.target.value)} placeholder="House / street / area" /></div>
        <div><label>City</label><input value={f.city ?? ''} onChange={(e) => set('city', e.target.value)} /></div>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        A CNIC provisions the read-only portal login (registration-no + CNIC). GR &amp; registration numbers are assigned on save.
      </p>

      {/* Guardians — Father, Mother, and anyone else. Each optional; the first filled is primary. */}
      <div className="stack" style={{ gap: 14 }}>
        {guardians.map((g, i) => (
          <GuardianSection
            key={i}
            index={i}
            value={g}
            onChange={(next) => setGuardianAt(i, next)}
            onRemove={guardians.length > 1 ? () => setGuardians((prev) => prev.filter((_, n) => n !== i)) : undefined}
          />
        ))}
        {guardians.length < 4 && (
          <div className="inline-form">
            <button className="ghost small" type="button"
              onClick={() => setGuardians((prev) => [...prev, { mode: 'CREATE', relation: 'GUARDIAN' }])}>
              + Add another guardian
            </button>
          </div>
        )}
      </div>

      {/* ⚠️ Emergency contact — deliberately NOT a guardian. When a child is hurt you ring whoever
          answers, not whoever pays the fees, and this person is often a neighbour or an uncle with
          no custodial relationship. Keeping it out of the guardian list also keeps them out of the
          fee and SMS paths, where they have no business. */}
      <div className="stack" style={{ gap: 8 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15 }}>
            Emergency contact <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>— optional</span>
          </h3>
          <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
            Who to call if the guardian cannot be reached. Not used for fees or SMS.
          </p>
        </div>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))' }}>
          <div><label>Name</label><input value={f.emergencyName ?? ''} onChange={(e) => set('emergencyName', e.target.value)} /></div>
          <div><label>Phone</label><input value={f.emergencyPhone ?? ''} onChange={(e) => set('emergencyPhone', e.target.value)} placeholder="03001234567" /></div>
          <div><label>Relation</label><input value={f.emergencyRelation ?? ''} onChange={(e) => set('emergencyRelation', e.target.value)} placeholder="e.g. Uncle" /></div>
        </div>
      </div>

      {/* ⚠️ Optional, and last on the form on purpose. The virtue of this screen is seating a
          walk-in in under a minute — it is why even the guardian is optional — and a photograph is
          the field most likely to be missing at the counter. Putting it early, or making it
          required, would break the fast path for the one thing that can always be added later from
          the profile. */}
      <div className="card stack" style={{ gap: 10 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15 }}>
            Photograph <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>— optional</span>
          </h3>
          <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
            Shown on the student&apos;s profile. Can be added later if you don&apos;t have one now.
          </p>
        </div>
        <div className="row" style={{ alignItems: 'center', gap: 14 }}>
          {photoPreview
            ? <img src={photoPreview} alt="Selected photograph" style={{ width: 84, height: 102, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} />
            : <div style={{ width: 84, height: 102, borderRadius: 8, border: '1px dashed var(--border)', display: 'grid', placeItems: 'center' }}>
                <span className="muted" style={{ fontSize: 11 }}>No photo</span>
              </div>}
          <div className="stack" style={{ gap: 6 }}>
            <label className="ghost small" htmlFor="admit-photo" style={{ cursor: 'pointer', display: 'inline-block' }}>
              {photoBusy ? 'Uploading…' : f.photoKey ? 'Choose a different photo' : '📷 Choose a photo'}
            </label>
            <input
              id="admit-photo" type="file" accept="image/*" style={{ display: 'none' }} disabled={photoBusy}
              onChange={(e) => { const file = e.target.files?.[0]; if (file) void attachPhoto(file); }}
            />
            {f.photoKey && <span className="badge ok" style={{ alignSelf: 'flex-start' }}>photo attached</span>}
          </div>
        </div>
      </div>

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
  | { mode: 'CREATE'; relation: string; fullName?: string; phone?: string; cnic?: string; email?: string; occupation?: string }
  | { mode: 'LINK'; relation: string; parentId?: string; phone?: string; occupation?: string };

function GuardianSection({ value, onChange, index, onRemove }: {
  value: GuardianChoice;
  onChange: (g: GuardianChoice) => void;
  /** Position in the list — 0 is the primary, and it also namespaces this block's radio group. */
  index: number;
  onRemove?: () => void;
}) {
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
      <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15 }}>
            {value.relation === 'FATHER' ? 'Father' : value.relation === 'MOTHER' ? 'Mother' : 'Guardian'}
            <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}> — optional</span>
            {index === 0 && <span className="badge" style={{ marginLeft: 8, fontSize: 11 }}>primary</span>}
          </h3>
          {/* Stated up front, not after the fact: leaving these blank has a real, permanent
              consequence until someone comes back and fills them in. Said once, on the first
              block, rather than repeated under every guardian. */}
          {index === 0 && (
            <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
              Leave blank to admit now and add the guardian later. Until one is added the school
              <b> cannot send any SMS</b> about this student — no absence alerts, fee receipts or
              results — and they&apos;ll be flagged <b>no guardian</b> in Students. The <b>first</b>
              {' '}guardian filled in is the one every SMS and receipt goes to.
            </p>
          )}
        </div>
        {onRemove && (
          <button className="ghost small" type="button" onClick={onRemove} aria-label="Remove this guardian">Remove</button>
        )}
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
              <input type="radio" name={`parent-${index}`} checked={value.mode === 'LINK' && value.parentId === m.id}
                onChange={() => onChange({ mode: 'LINK', relation: value.relation, parentId: m.id, phone })} />
              <strong>{m.fullName}</strong><span className="muted">{m.phone}</span>
            </label>
          ))}
          <label className="row" style={{ justifyContent: 'flex-start', gap: 8, cursor: 'pointer' }}>
            <input type="radio" name={`parent-${index}`} checked={value.mode === 'CREATE'}
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
            {/* CREATE only: linking an existing parent must not rewrite their record from a form
                filled in about a different child. */}
            <div><label>Occupation (optional)</label>
              <input value={value.occupation ?? ''} onChange={(e) => onChange({ ...value, occupation: e.target.value })} placeholder="e.g. Shopkeeper" /></div>
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
