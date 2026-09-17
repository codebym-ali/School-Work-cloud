'use client';

import { useEffect, useState } from 'react';
import { api, apiGet, ApiError, type BroadcastPreview, type Campus, type Klass, type Section } from '@sw/api-client';

/**
 * Text families by audience (GAP-15): whole school, a campus, a class or a section.
 *
 * ⚠️ **Nothing is sent without a count first.** "Check audience" asks the server who it would reach and what it
 * costs; "Send" then passes that count back, and the server refuses if the audience moved in between. The
 * office never types phone numbers, and a parent who opted out is never texted.
 */
export function BroadcastCard({ onSent }: { onSent: (text: string) => void }) {
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [classes, setClasses] = useState<Klass[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [campusId, setCampusId] = useState('');
  const [classId, setClassId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState<BroadcastPreview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Campus[]>('/campuses').then(setCampuses).catch(() => {});
    apiGet<Klass[]>('/classes').then(setClasses).catch(() => {});
    apiGet<Section[]>('/sections').then(setSections).catch(() => {});
  }, []);

  // Any change to who or what invalidates the count the sender agreed to.
  useEffect(() => { setPreview(null); setConfirming(false); }, [campusId, classId, sectionId, body]);

  const audience = {
    ...(campusId ? { campusId } : {}), ...(classId ? { classId } : {}), ...(sectionId ? { sectionId } : {}),
  };
  const visibleClasses = classes.filter((c) => !campusId || c.campusId === campusId).sort((a, b) => a.order - b.order);
  const visibleSections = sections.filter((s) => s.classId === classId);
  const chars = body.length;

  async function check() {
    setBusy(true); setErr(null);
    try { setPreview(await api.sms.previewBroadcast({ ...audience, body })); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not check the audience.'); }
    finally { setBusy(false); }
  }

  async function send() {
    if (!preview) return;
    setBusy(true); setErr(null);
    try {
      const res = await api.sms.broadcast({ ...audience, body, expectedRecipients: preview.recipients });
      onSent(`Queued to ${res.queued} ${res.queued === 1 ? 'family' : 'families'} (${res.totalSegments} credits). Delivery shows under Sent messages.`);
      setBody(''); setPreview(null); setConfirming(false);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not send.');
      setConfirming(false); setPreview(null);
    } finally { setBusy(false); }
  }

  const skippedTotal = preview ? preview.skipped.unverified + preview.skipped.optedOut + preview.skipped.noGuardian : 0;

  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="section-title" style={{ margin: 0 }}>Send a message to families</div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 8 }}>
        {campuses.length > 1 && (
          <div><label htmlFor="bc-campus">Campus</label>
            <select id="bc-campus" value={campusId} onChange={(e) => { setCampusId(e.target.value); setClassId(''); setSectionId(''); }}>
              <option value="">All campuses</option>
              {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <div><label htmlFor="bc-class">Class</label>
          <select id="bc-class" value={classId} onChange={(e) => { setClassId(e.target.value); setSectionId(''); }}>
            <option value="">All classes</option>
            {visibleClasses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div><label htmlFor="bc-section">Section</label>
          <select id="bc-section" value={sectionId} disabled={!classId} onChange={(e) => setSectionId(e.target.value)}>
            <option value="">All sections</option>
            {visibleSections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="bc-body">Message</label>
        <textarea id="bc-body" style={{ width: '100%', minHeight: 80 }} maxLength={612} value={body}
          placeholder="e.g. School will remain closed tomorrow due to rain. Classes resume on Monday."
          onChange={(e) => setBody(e.target.value)} />
        <div className="field-hint">{chars}/612 characters · one SMS is 160 characters (70 in Urdu)</div>
      </div>

      {err && <div className="toast err" style={{ margin: 0 }} role="alert">{err}</div>}

      {preview && (
        <div className={`toast ${preview.recipients === 0 || !preview.enoughCredits ? 'warn' : 'ok'}`} style={{ margin: 0 }} role="status">
          <strong>{preview.recipients} {preview.recipients === 1 ? 'family' : 'families'}</strong> will receive this
          {' '}({preview.students} students) · {preview.totalSegments} credits of {preview.balance.toLocaleString()} available.
          {skippedTotal > 0 && (
            <div style={{ fontSize: 13, marginTop: 4 }}>
              Not reached: {[
                preview.skipped.unverified && `${preview.skipped.unverified} unverified number${preview.skipped.unverified === 1 ? '' : 's'}`,
                preview.skipped.optedOut && `${preview.skipped.optedOut} opted out of SMS`,
                preview.skipped.noGuardian && `${preview.skipped.noGuardian} student${preview.skipped.noGuardian === 1 ? '' : 's'} with no guardian`,
              ].filter(Boolean).join(' · ')}
            </div>
          )}
          {!preview.enoughCredits && <div style={{ fontSize: 13, marginTop: 4 }}>Not enough credits — top up before sending. Nothing is sent partially.</div>}
        </div>
      )}

      <div className="row" style={{ gap: 8 }}>
        {!preview ? (
          <button type="button" disabled={busy || !body.trim()} onClick={check}>{busy ? 'Checking…' : 'Check audience'}</button>
        ) : !confirming ? (
          <button type="button" disabled={busy || preview.recipients === 0 || !preview.enoughCredits} onClick={() => setConfirming(true)}>
            Send to {preview.recipients} {preview.recipients === 1 ? 'family' : 'families'}
          </button>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={send}>{busy ? 'Sending…' : 'Yes, send now'}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
            <span className="muted" style={{ fontSize: 13 }}>Messages cannot be recalled once sent.</span>
          </>
        )}
      </div>
    </div>
  );
}
