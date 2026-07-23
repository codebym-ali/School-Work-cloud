'use client';

import { useEffect, useState } from 'react';
import { api, apiGet, apiPatch, apiPost, ApiError, type AdmissionsSummary, type Campus, type Klass, type Section } from '@/lib/api';
import type { Inquiry } from '@/lib/api';
import { hasModule, useMe } from '@/lib/me-context';

const STATUSES = ['INQUIRY', 'ENTRY_TEST_SCHEDULED', 'ENTRY_TEST_PASSED', 'ENTRY_TEST_FAILED', 'ADMITTED', 'REJECTED', 'WITHDRAWN'];
const funnelBadge = (s: string) =>
  s === 'ADMITTED' || s === 'ENTRY_TEST_PASSED' ? 'ok'
  : s === 'REJECTED' || s === 'ENTRY_TEST_FAILED' ? 'bad'
  : s === 'WITHDRAWN' ? '' : 'warn';

export default function AdmissionsPage() {
  const me = useMe();
  const canManage = hasModule(me, 'admissions.inquiries');
  const canAdmit = hasModule(me, 'admissions.admit');
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [summary, setSummary] = useState<AdmissionsSummary | null>(null);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [classes, setClasses] = useState<Klass[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [status, setStatus] = useState('');
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    const q = status ? `?status=${status}` : '';
    const [res, sum] = await Promise.all([
      apiGet<{ data: Inquiry[] }>(`/inquiries${q}`),
      api.admissions.summary().catch(() => null),
    ]);
    setInquiries(res.data);
    if (sum) setSummary(sum);
  }
  useEffect(() => {
    apiGet<Campus[]>('/campuses').then(setCampuses).catch(() => {});
    apiGet<Klass[]>('/classes').then(setClasses).catch(() => {});
    apiGet<Section[]>('/sections').then(setSections).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { load().catch(() => {}); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const className = (id: string) => classes.find((c) => c.id === id)?.name ?? id.slice(0, 8);

  async function run(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      await load();
      setMsg({ ok: true, text: ok });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed' });
      return false;
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <h1>Admissions</h1>
        {canManage && <button onClick={() => setAdding((v) => !v)}>{adding ? 'Close' : '+ New inquiry'}</button>}
      </div>
      {msg && <div className={`toast ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}

      {summary && (
        <div className="grid">
          <div className="metric"><div className="value">{summary.totals.open}</div><div className="label">Open inquiries</div></div>
          <div className="metric"><div className="value">{summary.testsToday}</div><div className="label">Tests today</div></div>
          <div className="metric"><div className="value">{summary.totals.readyToAdmit}</div><div className="label">Ready to admit</div></div>
          <div className="metric"><div className="value">{summary.admittedThisMonth}</div><div className="label">Admitted this month</div></div>
          <div className="metric"><div className="value">{summary.conversionRate}%</div><div className="label">Conversion rate</div></div>
        </div>
      )}

      {adding && (
        <NewInquiry campuses={campuses} classes={classes}
          onDone={async (ok, text) => { setMsg({ ok, text }); if (ok) { setAdding(false); await load(); } }} />
      )}

      {summary && (
        <div className="card stack">
          <h2 style={{ margin: 0, fontSize: 17 }}>Pipeline</h2>
          <div className="row" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
            <button className={`chip ${status === '' ? 'active' : ''}`} onClick={() => setStatus('')}>All ({summary.totals.total})</button>
            {STATUSES.map((s) => (
              <button key={s} className={`chip ${status === s ? 'active' : ''}`} onClick={() => setStatus(s)}>
                <span className={`badge ${funnelBadge(s)}`}>{summary.byStatus[s] ?? 0}</span> {s.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        </div>
      )}

      <table>
        <thead><tr><th>Student</th><th>Guardian</th><th>Phone</th><th>Desired class</th><th>Status</th><th>Entry test</th><th></th></tr></thead>
        <tbody>
          {inquiries.map((i) => (
            <InquiryRow key={i.id} inquiry={i} classes={classes} sections={sections} className={className} onAction={run}
              canManage={canManage} canAdmitModule={canAdmit} />
          ))}
          {inquiries.length === 0 && <tr><td colSpan={7} className="muted">No inquiries. Create one above.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function NewInquiry({ campuses, classes, onDone }: { campuses: Campus[]; classes: Klass[]; onDone: (ok: boolean, text: string) => void }) {
  const [f, setF] = useState<Record<string, string>>({});
  const set = (k: string, v: string) => setF({ ...f, [k]: v });

  async function submit() {
    try {
      await apiPost('/inquiries', {
        campusId: f.campusId, guardianName: f.guardianName, guardianPhone: f.guardianPhone,
        studentName: f.studentName, desiredClassId: f.desiredClassId,
      });
      onDone(true, `Inquiry created for ${f.studentName}`);
    } catch (e) {
      onDone(false, e instanceof ApiError ? e.message : 'Failed to create inquiry');
    }
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>New inquiry</h2>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))' }}>
        <div><label>Campus</label>
          <select value={f.campusId ?? ''} onChange={(e) => set('campusId', e.target.value)}>
            <option value="">Select…</option>{campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div><label>Desired class</label>
          <select value={f.desiredClassId ?? ''} onChange={(e) => set('desiredClassId', e.target.value)}>
            <option value="">Select…</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div><label>Student name</label><input value={f.studentName ?? ''} onChange={(e) => set('studentName', e.target.value)} /></div>
        <div><label>Guardian name</label><input value={f.guardianName ?? ''} onChange={(e) => set('guardianName', e.target.value)} /></div>
        <div><label>Guardian phone</label><input value={f.guardianPhone ?? ''} onChange={(e) => set('guardianPhone', e.target.value)} placeholder="03001234567" /></div>
      </div>
      <div><button onClick={submit} disabled={!f.campusId || !f.desiredClassId || !f.studentName || !f.guardianName || !f.guardianPhone}>Create inquiry</button></div>
    </div>
  );
}

type ActionFn = (fn: () => Promise<unknown>, ok: string) => Promise<boolean>;

function InquiryRow({
  inquiry, classes, sections, className, onAction, canManage, canAdmitModule,
}: {
  inquiry: Inquiry;
  classes: Klass[];
  sections: Section[];
  className: (id: string) => string;
  onAction: ActionFn;
  canManage: boolean;
  canAdmitModule: boolean;
}) {
  const [open, setOpen] = useState<'schedule' | 'record' | 'admit' | 'reject' | 'withdraw' | null>(null);
  const badge = (s: string) =>
    s === 'ADMITTED' || s === 'ENTRY_TEST_PASSED' ? 'ok'
    : s === 'REJECTED' || s === 'ENTRY_TEST_FAILED' ? 'bad'
    : s === 'WITHDRAWN' ? '' : 'warn';

  const canSchedule = inquiry.status === 'INQUIRY';
  const canRecord = inquiry.status === 'ENTRY_TEST_SCHEDULED';
  const canAdmit = ['INQUIRY', 'ENTRY_TEST_PASSED', 'ENTRY_TEST_FAILED'].includes(inquiry.status);
  const canRejectWithdraw = !['ADMITTED', 'REJECTED', 'WITHDRAWN'].includes(inquiry.status);

  async function act(fn: () => Promise<unknown>, ok: string) {
    const success = await onAction(fn, ok);
    if (success) setOpen(null);
  }

  return (
    <>
      <tr>
        <td>{inquiry.studentName}</td>
        <td>{inquiry.guardianName}</td>
        <td>{inquiry.guardianPhone}</td>
        <td>{className(inquiry.desiredClassId)}</td>
        <td><span className={`badge ${badge(inquiry.status)}`}>{inquiry.status}</span></td>
        <td className="muted">
          {inquiry.entryTest
            ? `Scheduled ${new Date(inquiry.entryTest.scheduledAt).toLocaleString()}${inquiry.entryTest.score != null ? ` · score ${inquiry.entryTest.score}` : ''}`
            : '—'}
        </td>
        <td>
          <span className="inline-form">
            {canSchedule && canManage && <button className="ghost small" onClick={() => setOpen(open === 'schedule' ? null : 'schedule')}>Schedule test</button>}
            {canRecord && canManage && <button className="ghost small" onClick={() => setOpen(open === 'record' ? null : 'record')}>Record result</button>}
            {canAdmit && canAdmitModule && <button className="small" onClick={() => setOpen(open === 'admit' ? null : 'admit')}>Admit</button>}
            {canRejectWithdraw && canManage && <button className="ghost small" onClick={() => setOpen(open === 'reject' ? null : 'reject')}>Reject</button>}
            {canRejectWithdraw && canManage && <button className="ghost small" onClick={() => setOpen(open === 'withdraw' ? null : 'withdraw')}>Withdraw</button>}
          </span>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7}>
            {open === 'schedule' && (
              <ScheduleForm onSubmit={(scheduledAt) => act(() => apiPost(`/inquiries/${inquiry.id}/entry-test`, { scheduledAt }), 'Entry test scheduled')} onClose={() => setOpen(null)} />
            )}
            {open === 'record' && (
              <RecordForm onSubmit={(body) => act(() => apiPatch(`/inquiries/${inquiry.id}/entry-test`, body), 'Entry test recorded')} onClose={() => setOpen(null)} />
            )}
            {open === 'admit' && (
              <AdmitForm inquiry={inquiry} classes={classes} sections={sections}
                onSubmit={(body) => act(() => apiPost('/admissions', body), `Admitted ${inquiry.studentName}`)} onClose={() => setOpen(null)} />
            )}
            {open === 'reject' && (
              <ReasonForm label="Reject" onSubmit={(reason) => act(() => apiPost(`/inquiries/${inquiry.id}/reject`, { reason }), 'Inquiry rejected')} onClose={() => setOpen(null)} />
            )}
            {open === 'withdraw' && (
              <ReasonForm label="Withdraw" onSubmit={(reason) => act(() => apiPost(`/inquiries/${inquiry.id}/withdraw`, { reason }), 'Inquiry withdrawn')} onClose={() => setOpen(null)} />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function ScheduleForm({ onSubmit, onClose }: { onSubmit: (scheduledAtIso: string) => void; onClose: () => void }) {
  const [when, setWhen] = useState('');
  return (
    <div className="inline-form">
      <div><label>Scheduled at</label><input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></div>
      <button className="small" disabled={!when} onClick={() => onSubmit(new Date(when).toISOString())}>Save</button>
      <button className="ghost small" onClick={onClose}>Cancel</button>
    </div>
  );
}

function RecordForm({ onSubmit, onClose }: { onSubmit: (body: { passed: boolean; score?: number; remarks?: string }) => void; onClose: () => void }) {
  const [passed, setPassed] = useState('true');
  const [score, setScore] = useState('');
  const [remarks, setRemarks] = useState('');
  return (
    <div className="inline-form">
      <div><label>Result</label>
        <select value={passed} onChange={(e) => setPassed(e.target.value)}>
          <option value="true">Passed</option>
          <option value="false">Failed</option>
        </select>
      </div>
      <div style={{ maxWidth: 100 }}><label>Score</label><input value={score} onChange={(e) => setScore(e.target.value)} /></div>
      <div style={{ minWidth: 200 }}><label>Remarks</label><input value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>
      <button className="small" onClick={() => onSubmit({ passed: passed === 'true', score: score ? Number(score) : undefined, remarks: remarks || undefined })}>Save</button>
      <button className="ghost small" onClick={onClose}>Cancel</button>
    </div>
  );
}

function AdmitForm({
  inquiry, classes, sections, onSubmit, onClose,
}: {
  inquiry: Inquiry;
  classes: Klass[];
  sections: Section[];
  onSubmit: (body: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [f, setF] = useState<Record<string, string>>({
    classId: inquiry.desiredClassId, gender: 'MALE', relation: 'FATHER',
    fullName: inquiry.studentName, guardianName: inquiry.guardianName, guardianPhone: inquiry.guardianPhone,
  });
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  const classSections = sections.filter((s) => s.classId === f.classId);

  function submit() {
    onSubmit({
      inquiryId: inquiry.id,
      fullName: f.fullName,
      gender: f.gender,
      dateOfBirth: f.dateOfBirth,
      classId: f.classId,
      sectionId: f.sectionId,
      guardian: { mode: 'CREATE', fullName: f.guardianName, phone: f.guardianPhone, relation: f.relation },
      grNumber: f.grNumber || undefined,
    });
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0, fontSize: 17 }}>Admit {inquiry.studentName}</h2>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))' }}>
        <div><label>Full name</label><input value={f.fullName ?? ''} onChange={(e) => set('fullName', e.target.value)} /></div>
        <div><label>Gender</label><select value={f.gender} onChange={(e) => set('gender', e.target.value)}><option>MALE</option><option>FEMALE</option><option>OTHER</option></select></div>
        <div><label>Date of birth</label><input type="date" value={f.dateOfBirth ?? ''} onChange={(e) => set('dateOfBirth', e.target.value)} /></div>
        <div><label>Class</label><select value={f.classId ?? ''} onChange={(e) => setF({ ...f, classId: e.target.value, sectionId: '' })}><option value="">Select…</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div><label>Section</label><select value={f.sectionId ?? ''} onChange={(e) => set('sectionId', e.target.value)}><option value="">Select…</option>{classSections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <div><label>Guardian name</label><input value={f.guardianName ?? ''} onChange={(e) => set('guardianName', e.target.value)} /></div>
        <div><label>Guardian phone</label><input value={f.guardianPhone ?? ''} onChange={(e) => set('guardianPhone', e.target.value)} /></div>
        <div><label>Relation</label><select value={f.relation} onChange={(e) => set('relation', e.target.value)}><option>FATHER</option><option>MOTHER</option><option>GUARDIAN</option></select></div>
        <div><label>GR number (optional)</label><input value={f.grNumber ?? ''} onChange={(e) => set('grNumber', e.target.value)} /></div>
      </div>
      <div className="inline-form">
        <button onClick={submit} disabled={!f.classId || !f.sectionId || !f.dateOfBirth || !f.fullName}>Admit student</button>
        <button className="ghost" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function ReasonForm({ label, onSubmit, onClose }: { label: string; onSubmit: (reason: string) => void; onClose: () => void }) {
  const [reason, setReason] = useState('');
  return (
    <div className="inline-form">
      <div style={{ minWidth: 240 }}><label>Reason</label><input value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      <button className="small" disabled={!reason} onClick={() => onSubmit(reason)}>{label}</button>
      <button className="ghost small" onClick={onClose}>Cancel</button>
    </div>
  );
}
