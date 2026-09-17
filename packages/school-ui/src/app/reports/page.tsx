'use client';

import { useEffect, useState } from 'react';
import { api, apiGet, ApiError, type ReportStudentOption } from '@sw/api-client';
import { useMe } from '@sw/session';
import { hasAnyRole } from '@sw/roles';
import { StudentPicker } from '@school/components/student-picker';

/** What a parameter IS, which decides how it is asked for. Nothing here is a free-text id any more. */
type ParamKind = 'date' | 'from' | 'to' | 'minDays' | 'student' | 'section' | 'exam';

const REPORTS: Array<{ key: string; label: string; params: ParamKind[]; required?: ParamKind[]; financial?: boolean; blurb: string }> = [
  { key: 'daily-collection', label: 'Daily collection', params: ['date'], financial: true, blurb: 'Every receipt taken on one day, with who paid.' },
  { key: 'defaulters', label: 'Defaulters', params: ['minDays'], financial: true, blurb: 'Students with unpaid invoices past their due date.' },
  { key: 'fee-ledger', label: 'Fee ledger', params: ['student'], required: ['student'], financial: true, blurb: 'One student’s invoices, payments and balance.' },
  { key: 'class-strength', label: 'Class strength', params: [], blurb: 'Active students in each class and section this year.' },
  { key: 'attendance-register', label: 'Attendance register', params: ['section', 'from', 'to'], required: ['section'], blurb: 'Day-by-day attendance for one section.' },
  { key: 'exam-summary', label: 'Exam summary', params: ['exam'], required: ['exam'], blurb: 'Marks for every student in one exam.' },
  { key: 'sms-usage', label: 'SMS usage', params: ['from', 'to'], blurb: 'Messages sent and segments used, by outcome.' },
];

const LABEL: Record<ParamKind, string> = {
  date: 'Day', from: 'From', to: 'To', minDays: 'Overdue by at least (days)', student: 'Student', section: 'Section', exam: 'Exam',
};

/** The API's query parameter for each kind. */
const QUERY: Record<ParamKind, string> = {
  date: 'date', from: 'from', to: 'to', minDays: 'minDays', student: 'studentId', section: 'sectionId', exam: 'examId',
};

/** `grNumber` → "GR number", `amountPaid` → "Amount paid". Column headers were raw field names. */
const COLUMN: Record<string, string> = { grNumber: 'GR number', receiptNo: 'Receipt no.', transactionRef: 'Reference', activeStudents: 'Active students', marksObtained: 'Marks', totalMarks: 'Out of', dueDate: 'Due' };
const heading = (k: string) => COLUMN[k] ?? k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

/** Dates arrive as ISO strings; show them as dates, not as `2026-09-16T00:00:00.000Z`. */
const cell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toLocaleDateString();
  return String(v);
};

type Row = Record<string, unknown>;

/**
 * Reports (GAP-09).
 *
 * ⚠️ Every parameter used to be a text box labelled with its field name — `studentId`, `sectionId`, `examId` —
 * asking for a UUID no screen ever shows. Three of seven reports could not be run from the screen that offered
 * them. Each is now a picker, a required one is asked for before the request rather than failing after it, and
 * the reports themselves return names instead of ids.
 */
export default function ReportsPage() {
  const me = useMe();
  const isAdmin = hasAnyRole(me?.roles, ['OWNER_ADMIN', 'CAMPUS_ADMIN']);
  const reports = isAdmin ? REPORTS : REPORTS.filter((r) => r.financial);

  const [key, setKey] = useState('daily-collection');
  const [values, setValues] = useState<Partial<Record<ParamKind, string>>>({});
  const [student, setStudent] = useState<ReportStudentOption | null>(null);
  const [sections, setSections] = useState<Array<{ id: string; label: string; campus: string }> | null>(null);
  const [exams, setExams] = useState<Array<{ id: string; label: string; term: string }> | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const spec = reports.find((r) => r.key === key) ?? reports[0];

  // Load a picker's options only when a report that needs it is chosen.
  useEffect(() => {
    if (spec.params.includes('section') && !sections) api.reportLookups.sections().then(setSections).catch(() => setSections([]));
    if (spec.params.includes('exam') && !exams) api.reportLookups.exams().then(setExams).catch(() => setExams([]));
  }, [spec, sections, exams]);

  const valueOf = (p: ParamKind) => (p === 'student' ? student?.id : values[p]);
  const missing = (spec.required ?? []).filter((p) => !valueOf(p));

  const query = (extra?: string) => {
    const parts = spec.params.map((p) => [QUERY[p], valueOf(p)] as const).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`);
    if (extra) parts.push(extra);
    return parts.length ? `?${parts.join('&')}` : '';
  };

  async function run() {
    if (missing.length) return;
    setErr(null); setRows(null); setBusy(true);
    try { setRows(await apiGet<Row[]>(`/reports/${spec.key}${query()}`)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not run the report.'); }
    finally { setBusy(false); }
  }

  const headers = rows && rows.length ? Object.keys(rows[0]) : [];
  const set = (p: ParamKind, v: string) => setValues((cur) => ({ ...cur, [p]: v }));

  return (
    <div className="stack">
      <h1>Reports</h1>
      <div className="card stack">
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, alignItems: 'end' }}>
          <div>
            <label htmlFor="rep-key">Report</label>
            <select id="rep-key" value={spec.key} onChange={(e) => { setKey(e.target.value); setRows(null); setErr(null); }}>
              {reports.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </div>

          {spec.params.map((p) => (
            <div key={p}>
              <label htmlFor={`rep-${p}`}>{LABEL[p]}{spec.required?.includes(p) ? '' : ' (optional)'}</label>
              {p === 'student' ? (
                <StudentPicker id={`rep-${p}`} value={student} onChange={setStudent} />
              ) : p === 'section' ? (
                <select id={`rep-${p}`} value={values.section ?? ''} onChange={(e) => set('section', e.target.value)}>
                  <option value="">{sections === null ? 'Loading…' : 'Choose a section'}</option>
                  {sections?.map((s) => <option key={s.id} value={s.id}>{s.label}{new Set(sections.map((x) => x.campus)).size > 1 ? ` · ${s.campus}` : ''}</option>)}
                </select>
              ) : p === 'exam' ? (
                <select id={`rep-${p}`} value={values.exam ?? ''} onChange={(e) => set('exam', e.target.value)}>
                  <option value="">{exams === null ? 'Loading…' : 'Choose an exam'}</option>
                  {exams?.map((x) => <option key={x.id} value={x.id}>{x.label} · {x.term}</option>)}
                </select>
              ) : p === 'minDays' ? (
                <input id={`rep-${p}`} type="number" min={0} inputMode="numeric" placeholder="0" value={values.minDays ?? ''} onChange={(e) => set('minDays', e.target.value)} />
              ) : (
                <input id={`rep-${p}`} type="date" value={values[p] ?? ''} onChange={(e) => set(p, e.target.value)} />
              )}
            </div>
          ))}
        </div>

        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{spec.blurb}{spec.params.some((p) => p === 'date' || p === 'from' || p === 'to') ? ' Dates left blank mean today.' : ''}</p>

        <div className="row" style={{ gap: 8 }}>
          <button type="button" onClick={run} disabled={busy || missing.length > 0}>{busy ? 'Running…' : 'View'}</button>
          {/* Download is a link; with a required choice missing it would only download an error. */}
          {missing.length === 0
            ? <a href={`/api/v1/reports/${spec.key}${query('format=csv')}`} className="ghost small" style={{ padding: '10px 16px', textDecoration: 'none' }}>Download CSV</a>
            : <span className="muted" style={{ fontSize: 13, alignSelf: 'center' }}>Choose a {missing.map((m) => LABEL[m].toLowerCase()).join(' and ')} first.</span>}
        </div>
      </div>

      {err && <div className="toast err" role="alert">{err}</div>}
      {rows && (rows.length === 0 ? <p className="muted">Nothing to report for these choices.</p> : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table>
            <thead><tr>{headers.map((h) => <th key={h}>{heading(h)}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => <tr key={i}>{headers.map((h) => <td key={h}>{cell(r[h])}</td>)}</tr>)}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
