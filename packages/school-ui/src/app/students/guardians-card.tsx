'use client';

import { useState } from 'react';
import { api, ApiError, type GuardianRelation, type StudentDetail, type StudentGuardianRow } from '@sw/api-client';
import { GUARDIAN_ADD_ROLES, GUARDIAN_EDIT_ROLES, hasAnyRole } from '@sw/roles';
import { useMe } from '@sw/session';

const RELATIONS: GuardianRelation[] = ['FATHER', 'MOTHER', 'GUARDIAN'];
const relationLabel = (r: string) => r.charAt(0) + r.slice(1).toLowerCase();

/**
 * A student's guardians, editable after admission (GAP-07).
 *
 * The multi-guardian model was built carefully — father and mother by default, first is primary — and
 * was write-once through the admission form. A father's number changes, a mother is added later, the
 * wrong parent was marked primary: none of it could be corrected from the profile the office has open.
 *
 * ⚠️ **"Primary" is not a label, it is a routing decision.** Every fee receipt and every SMS resolves the
 * primary guardian. Changing it is stated as exactly that before it happens.
 *
 * ⚠️ **SMS reaches only VERIFIED numbers**, and the card says so per guardian. An unverified primary means
 * the school believes it is notifying a family that hears nothing; that is shown, with the fix beside it.
 *
 * ⚠️ **Editing contact details edits the PARENT**, so it applies to every child they are guardian of. When
 * that is more than this one, the form says so before saving, not after.
 */
export function GuardiansCard({ student, onChanged }: { student: StudentDetail; onChanged: () => void }) {
  const me = useMe();
  const canEdit = hasAnyRole(me?.roles, GUARDIAN_EDIT_ROLES);
  const canAdd = hasAnyRole(me?.roles, GUARDIAN_ADD_ROLES);

  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [verifying, setVerifying] = useState<StudentGuardianRow | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'primary' | 'remove'; row: StudentGuardianRow } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const primary = student.guardians.find((g) => g.isPrimary) ?? null;
  const done = (text: string) => { setMsg({ ok: true, text }); onChanged(); };

  return (
    <div className="card stack">
      <div className="row" style={{ alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Guardians</h3>
        {canAdd && !adding && <button type="button" className="ghost small" onClick={() => { setAdding(true); setMsg(null); }}>+ Add guardian</button>}
      </div>

      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`} role={msg.ok ? 'status' : 'alert'} style={{ margin: 0 }}>{msg.text}</div>}

      {student.guardians.length === 0 && !adding && (
        <div className="toast warn" style={{ margin: 0 }}>
          No guardian on record. <strong>Nobody is contacted about this student</strong> — no fee receipts, no
          absence notices, no results.
        </div>
      )}

      {primary && !primary.parent.phoneVerifiedAt && (
        <div className="toast warn" style={{ margin: 0 }}>
          The primary guardian&apos;s number is not verified, so <strong>no SMS reaches this family</strong>.
          {canEdit && <> Verify it below.</>}
        </div>
      )}

      {student.guardians.map((g) => (
        <div key={g.id} className="stack" style={{ gap: 6, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          {editing === g.id ? (
            <EditGuardian studentId={student.id} row={g}
              onCancel={() => setEditing(null)}
              onSaved={(text) => { setEditing(null); done(text); }}
              onVerifyNow={() => { setEditing(null); setVerifying(g); onChanged(); }} />
          ) : (
            <>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <strong>{g.parent.fullName}</strong>
                <span className="muted">{relationLabel(g.relation)}</span>
                {g.isPrimary && <span className="badge ok" title="Receives fee receipts and every SMS">primary</span>}
                {g.parent._count.guardianLinks > 1 && (
                  <span className="badge" title="One record shared across their children">guardian of {g.parent._count.guardianLinks} children</span>
                )}
              </div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
                <span className="mono">{g.parent.phone}</span>
                {g.parent.phoneVerifiedAt
                  ? <span className="badge ok">verified</span>
                  : <span className="badge warn" title="SMS is only sent to verified numbers">not verified — no SMS</span>}
                {g.parent.email && <span className="muted">{g.parent.email}</span>}
                {g.parent.occupation && <span className="muted">· {g.parent.occupation}</span>}
              </div>
              {canEdit && (
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <button type="button" className="ghost small" onClick={() => { setEditing(g.id); setMsg(null); }}>Edit</button>
                  {!g.parent.phoneVerifiedAt && (
                    <button type="button" className="ghost small" onClick={() => { setVerifying(g); setMsg(null); }}>Verify phone</button>
                  )}
                  {!g.isPrimary && (
                    <button type="button" className="ghost small" onClick={() => setConfirm({ kind: 'primary', row: g })}>Make primary</button>
                  )}
                  {/* The API refuses removing the primary; the button is simply not offered. */}
                  {!g.isPrimary && (
                    <button type="button" className="ghost small" style={{ color: '#b91c1c' }} onClick={() => setConfirm({ kind: 'remove', row: g })}>Remove</button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      ))}

      {adding && (
        <AddGuardian student={student}
          onCancel={() => setAdding(false)}
          onAdded={(text) => { setAdding(false); done(text); }} />
      )}

      {verifying && (
        <VerifyPhone row={verifying} onClose={() => setVerifying(null)} onVerified={(text) => { setVerifying(null); done(text); }} />
      )}

      {confirm && (
        <ConfirmGuardian
          title={confirm.kind === 'primary' ? `Make ${confirm.row.parent.fullName} primary?` : `Remove ${confirm.row.parent.fullName}?`}
          body={confirm.kind === 'primary'
            ? <>Fee receipts and every SMS about {student.fullName} will go to <strong>{confirm.row.parent.fullName}</strong>
                {primary ? <> instead of {primary.parent.fullName}</> : null}.
                {!confirm.row.parent.phoneVerifiedAt && <><br /><br />⚠️ Their number is not verified, so no SMS will reach them until it is.</>}</>
            : <>{confirm.row.parent.fullName} stops being a guardian of {student.fullName}. Their record is kept
                {confirm.row.parent._count.guardianLinks > 1 ? <> — they remain guardian of their other children</> : null}.</>}
          confirmLabel={confirm.kind === 'primary' ? 'Make primary' : 'Remove guardian'}
          destructive={confirm.kind === 'remove'}
          onConfirm={async () => {
            if (confirm.kind === 'primary') {
              await api.students.setPrimaryGuardian(student.id, confirm.row.id);
              done(`${confirm.row.parent.fullName} is now the primary guardian.`);
            } else {
              await api.students.removeGuardian(student.id, confirm.row.id);
              done(`${confirm.row.parent.fullName} removed.`);
            }
          }}
          onClose={() => setConfirm(null)} />
      )}
    </div>
  );
}

/** Contact + relation. Relation is the link; everything else is the PARENT, shared across their children. */
function EditGuardian({ studentId, row, onCancel, onSaved, onVerifyNow }: {
  studentId: string; row: StudentGuardianRow;
  onCancel: () => void; onSaved: (text: string) => void; onVerifyNow: () => void;
}) {
  const [f, setF] = useState({
    fullName: row.parent.fullName, phone: row.parent.phone, email: row.parent.email ?? '',
    occupation: row.parent.occupation ?? '', relation: row.relation,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [phoneNowUnverified, setPhoneNowUnverified] = useState(false);
  const others = row.parent._count.guardianLinks - 1;

  async function save() {
    setBusy(true); setErr(null);
    try {
      const contact: Record<string, string> = {};
      if (f.fullName.trim() !== row.parent.fullName) contact.fullName = f.fullName.trim();
      if (f.phone.trim() !== row.parent.phone) contact.phone = f.phone.trim();
      if (f.email.trim() !== (row.parent.email ?? '')) contact.email = f.email.trim();
      if (f.occupation.trim() !== (row.parent.occupation ?? '')) contact.occupation = f.occupation.trim();

      let phoneChanged = false;
      if (Object.keys(contact).length) {
        const res = await api.students.updateGuardianContact(studentId, row.id, contact);
        phoneChanged = res.phoneChanged;
      }
      if (f.relation !== row.relation) await api.students.setGuardianRelation(studentId, row.id, f.relation);

      // A new number is unverified and gets no SMS. Say so here and offer the fix, rather than closing the
      // form on a quiet success and letting the next absence notice go nowhere.
      if (phoneChanged) setPhoneNowUnverified(true);
      else onSaved('Guardian updated.');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save. Nothing was changed.');
    } finally { setBusy(false); }
  }

  if (phoneNowUnverified) {
    return (
      <div className="toast warn stack" style={{ margin: 0, gap: 8 }} role="status">
        <span><strong>Number saved, and not verified yet.</strong> No SMS reaches {f.fullName} until it is — including
          fee receipts and absence notices.</span>
        <span className="row" style={{ gap: 8 }}>
          <button type="button" className="small" onClick={onVerifyNow}>Verify now</button>
          <button type="button" className="ghost small" onClick={() => onSaved('Guardian updated. Their number still needs verifying.')}>Later</button>
        </span>
      </div>
    );
  }

  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {others > 0 && (
        <div className="toast warn" style={{ margin: 0, fontSize: 13 }}>
          {row.parent.fullName} is guardian of {others} other {others === 1 ? 'child' : 'children'} here. Name, phone,
          email and occupation change for all of them. Relation changes for this student only.
        </div>
      )}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px,1fr))', gap: 8 }}>
        <div><label htmlFor={`g-name-${row.id}`}>Name</label><input id={`g-name-${row.id}`} value={f.fullName} onChange={(e) => set('fullName', e.target.value)} disabled={busy} /></div>
        <div><label htmlFor={`g-phone-${row.id}`}>Phone</label><input id={`g-phone-${row.id}`} value={f.phone} onChange={(e) => set('phone', e.target.value)} disabled={busy} inputMode="tel" /></div>
        <div><label htmlFor={`g-rel-${row.id}`}>Relation</label>
          <select id={`g-rel-${row.id}`} value={f.relation} onChange={(e) => set('relation', e.target.value)} disabled={busy}>
            {RELATIONS.map((r) => <option key={r} value={r}>{relationLabel(r)}</option>)}
          </select>
        </div>
        <div><label htmlFor={`g-email-${row.id}`}>Email</label><input id={`g-email-${row.id}`} value={f.email} onChange={(e) => set('email', e.target.value)} disabled={busy} /></div>
        <div><label htmlFor={`g-occ-${row.id}`}>Occupation</label><input id={`g-occ-${row.id}`} value={f.occupation} onChange={(e) => set('occupation', e.target.value)} disabled={busy} /></div>
      </div>
      {f.phone.trim() !== row.parent.phone && row.parent.phoneVerifiedAt && (
        <p className="field-hint" style={{ margin: 0 }}>A new number has to be verified again before SMS reaches it.</p>
      )}
      {err && <div className="toast err" style={{ margin: 0 }} role="alert">{err}</div>}
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="small" disabled={busy || f.fullName.trim() === '' || f.phone.trim() === ''} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="ghost small" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * Add a guardian. A number already on record is refused by the API (one number, one guardian); the 409
 * carries that record's id, so the form offers to LINK the existing guardian instead of a dead end.
 */
function AddGuardian({ student, onCancel, onAdded }: {
  student: StudentDetail; onCancel: () => void; onAdded: (text: string) => void;
}) {
  const [f, setF] = useState({ fullName: '', phone: '', relation: 'MOTHER' as GuardianRelation, email: '', occupation: '' });
  const [makePrimary, setMakePrimary] = useState(student.guardians.length === 0);
  const [existing, setExisting] = useState<{ parentId: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const first = student.guardians.length === 0;
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  async function submit(link?: string) {
    setBusy(true); setErr(null);
    try {
      await api.students.addGuardian(student.id, link
        ? { mode: 'LINK', parentId: link, relation: f.relation, isPrimary: makePrimary }
        : {
          mode: 'CREATE', fullName: f.fullName.trim(), phone: f.phone.trim(), relation: f.relation, isPrimary: makePrimary,
          ...(f.email.trim() ? { email: f.email.trim() } : {}), ...(f.occupation.trim() ? { occupation: f.occupation.trim() } : {}),
        });
      onAdded(`${link ? 'Existing guardian linked' : `${f.fullName.trim()} added`}${first || makePrimary ? ' as primary' : ''}.`);
    } catch (e) {
      const issue = e instanceof ApiError && e.status === 409 && Array.isArray(e.details)
        ? (e.details as Array<{ field?: string; issue?: string }>).find((d) => d.field === 'parentId')?.issue : undefined;
      if (issue) setExisting({ parentId: issue, message: e instanceof ApiError ? e.message : '' });
      else setErr(e instanceof ApiError ? e.message : 'Could not add the guardian.');
    } finally { setBusy(false); }
  }

  return (
    <div className="stack" style={{ gap: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
      <strong style={{ fontSize: 14 }}>Add a guardian</strong>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px,1fr))', gap: 8 }}>
        <div><label htmlFor="ng-name">Name</label><input id="ng-name" value={f.fullName} onChange={(e) => set('fullName', e.target.value)} disabled={busy} autoFocus /></div>
        <div><label htmlFor="ng-phone">Phone</label><input id="ng-phone" value={f.phone} onChange={(e) => { set('phone', e.target.value); setExisting(null); }} disabled={busy} inputMode="tel" placeholder="03001234567" /></div>
        <div><label htmlFor="ng-rel">Relation</label>
          <select id="ng-rel" value={f.relation} onChange={(e) => set('relation', e.target.value)} disabled={busy}>
            {RELATIONS.map((r) => <option key={r} value={r}>{relationLabel(r)}</option>)}
          </select>
        </div>
        <div><label htmlFor="ng-email">Email <span className="muted">(optional)</span></label><input id="ng-email" value={f.email} onChange={(e) => set('email', e.target.value)} disabled={busy} /></div>
        <div><label htmlFor="ng-occ">Occupation <span className="muted">(optional)</span></label><input id="ng-occ" value={f.occupation} onChange={(e) => set('occupation', e.target.value)} disabled={busy} /></div>
      </div>
      {/* The first guardian is primary whatever is ticked — the server enforces it — so the box is locked on. */}
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
        <input type="checkbox" checked={first || makePrimary} disabled={first || busy} onChange={(e) => setMakePrimary(e.target.checked)} style={{ width: 'auto' }} />
        Primary guardian {first ? '(the first guardian always is)' : '— receives fee receipts and every SMS'}
      </label>

      {existing && (
        <div className="toast warn stack" style={{ margin: 0, gap: 6 }}>
          <span>{existing.message}</span>
          <span><button type="button" className="small" disabled={busy} onClick={() => submit(existing.parentId)}>Link the existing guardian</button></span>
        </div>
      )}
      {err && <div className="toast err" style={{ margin: 0 }} role="alert">{err}</div>}
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="small" disabled={busy || !f.fullName.trim() || !f.phone.trim() || !!existing} onClick={() => submit()}>{busy ? 'Adding…' : 'Add guardian'}</button>
        <button type="button" className="ghost small" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** Two steps: send the code to the guardian's phone, then enter the code they read back. */
function VerifyPhone({ row, onClose, onVerified }: { row: StudentGuardianRow; onClose: () => void; onVerified: (text: string) => void }) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send() {
    setBusy(true); setErr(null);
    try { setSentTo((await api.students.sendGuardianOtp(row.parent.id)).sentTo); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not send the code.'); }
    finally { setBusy(false); }
  }
  async function confirm() {
    setBusy(true); setErr(null);
    try {
      await api.students.confirmGuardianOtp(row.parent.id, code.trim());
      onVerified(`${row.parent.fullName}'s number is verified. SMS will now reach them.`);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not verify the code.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="stack" style={{ gap: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
      <strong style={{ fontSize: 14 }}>Verify {row.parent.fullName}&apos;s number</strong>
      {!sentTo ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          A six-digit code is texted to <span className="mono">{row.parent.phone}</span>. Ask the guardian to read it back.
        </p>
      ) : (
        <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ maxWidth: 160 }}>
            <label htmlFor={`otp-${row.id}`}>Code sent to {sentTo}</label>
            <input id={`otp-${row.id}`} inputMode="numeric" maxLength={6} value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} disabled={busy} autoFocus />
          </div>
        </div>
      )}
      {err && <div className="toast err" style={{ margin: 0 }} role="alert">{err}</div>}
      <div className="row" style={{ gap: 8 }}>
        {!sentTo
          ? <button type="button" className="small" disabled={busy} onClick={send}>{busy ? 'Sending…' : 'Send code'}</button>
          : <button type="button" className="small" disabled={busy || code.length !== 6} onClick={confirm}>{busy ? 'Checking…' : 'Verify'}</button>}
        <button type="button" className="ghost small" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function ConfirmGuardian({ title, body, confirmLabel, destructive, onConfirm, onClose }: {
  title: string; body: React.ReactNode; confirmLabel: string; destructive: boolean;
  onConfirm: () => Promise<void>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div role="dialog" aria-modal="true" aria-label={title}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 60, display: 'grid', placeItems: 'center', padding: 16 }}>
      <div className="card stack" style={{ width: 'min(460px, 100%)', gap: 12, background: '#fff' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>
        <div className="muted" style={{ fontSize: 13 }}>{body}</div>
        {err && <div className="toast err" style={{ margin: 0 }} role="alert">{err}</div>}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" disabled={busy} autoFocus
            style={destructive ? { background: '#b91c1c', borderColor: '#b91c1c' } : undefined}
            onClick={async () => {
              setBusy(true); setErr(null);
              try { await onConfirm(); onClose(); }
              catch (e) { setErr(e instanceof ApiError ? e.message : 'That did not go through.'); setBusy(false); }
            }}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
