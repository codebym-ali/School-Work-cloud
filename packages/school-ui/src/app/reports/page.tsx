'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { api, apiGet, ApiError, type ReportStudentOption } from '@sw/api-client';
import { useMe } from '@sw/session';
import { hasAnyRole, type Role } from '@sw/roles';
import { Icon, type IconName } from '@sw/ui';
import { StudentPicker } from '@school/components/student-picker';
import { SearchableSelect } from '@school/components/searchable-select';
import { DateField } from '@school/components/date-field';
import { DataTable, EmptyState, type Column } from '@school/components/oversight';
import { moneyExact, moneyShort } from '@school/lib/money';

/**
 * Reports centre (Owner UX Remediation Plan, Phase 1d — issues 6, 7).
 *
 * The old screen was one dropdown of seven report names and a row of parameter boxes: nothing said what a
 * report was FOR, nothing showed what it would say before it ran, and results were a raw table of field names.
 * Now:
 *  - **Gallery**, grouped the way an owner thinks — Enrollment · Attendance · Fees · Exams · Staff ·
 *    Communication. Each card is the question it answers, a live preview figure, and when you last ran it.
 *    The live oversight screens (attendance overview, performance, staff register) sit in the same gallery,
 *    because to an owner they ARE reports.
 *  - **Report view**: its filters up front with sensible defaults, results inline (a chart where the data is
 *    visual, the table below), and Export CSV / PDF together at the top right of the results.
 */

type ParamKind = 'date' | 'from' | 'to' | 'minDays' | 'student' | 'section' | 'exam';
type Row = Record<string, unknown>;
type Category = 'Enrollment' | 'Attendance' | 'Fees' | 'Exams' | 'Staff' | 'Communication';

interface ReportSpec {
  key: string;
  title: string;
  question: string;
  category: Category;
  icon: IconName;
  params: ParamKind[];
  required?: ParamKind[];
  financial?: boolean;
  /** A chart for results whose shape is visual; the table always follows. */
  chart?: (rows: Row[]) => ReactNode;
  /** One line summarising the result set ("12 receipts · Rs 45,000"). */
  total?: (rows: Row[]) => string;
}
interface LiveSpec { key: string; title: string; question: string; category: Category; icon: IconName; href: string; roles: Role[] }

const sum = (rows: Row[], k: string) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;

const REPORTS: ReportSpec[] = [
  { key: 'class-strength', title: 'Class strength', category: 'Enrollment', icon: 'classes', params: [],
    question: 'How many students are in each class and section?',
    total: (rows) => `${plural(sum(rows, 'activeStudents'), 'student')} across ${plural(rows.length, 'section')}`,
    chart: (rows) => <Bars rows={rows.map((r) => ({ label: `${r.class} — ${r.section}`, value: Number(r.activeStudents) }))} unit="students" /> },
  { key: 'attendance-register', title: 'Attendance register', category: 'Attendance', icon: 'attendance', params: ['section', 'from', 'to'], required: ['section'],
    question: 'Who was present, day by day, in one section?',
    total: (rows) => {
      const present = rows.filter((r) => r.status === 'PRESENT' || r.status === 'LATE' || r.status === 'HALF_DAY').length;
      return rows.length ? `${plural(rows.length, 'mark')} · ${Math.round((present / rows.length) * 100)}% present` : '';
    } },
  { key: 'daily-collection', title: 'Daily collection', category: 'Fees', icon: 'fees', params: ['date'], financial: true,
    question: 'What did we collect on a day, and from whom?',
    total: (rows) => `${plural(rows.length, 'receipt')} · ${moneyExact(sum(rows, 'amountPaid'))}`,
    chart: (rows) => {
      const by = new Map<string, number>();
      for (const r of rows) by.set(String(r.method), (by.get(String(r.method)) ?? 0) + (Number(r.amountPaid) || 0));
      return <Bars rows={[...by].map(([label, value]) => ({ label: humanize(label), value }))} money />;
    } },
  { key: 'defaulters', title: 'Fee defaulters', category: 'Fees', icon: 'alert', params: ['minDays'], financial: true,
    question: 'Who owes fees, and how much?',
    total: (rows) => `${plural(rows.length, 'student')} · ${moneyExact(sum(rows, 'outstanding'))} outstanding`,
    chart: (rows) => <Bars rows={rows.slice(0, 10).map((r) => ({ label: String(r.name), value: Number(r.outstanding) }))} money caption="The ten largest balances" /> },
  { key: 'fee-ledger', title: 'Fee ledger', category: 'Fees', icon: 'fee-claims', params: ['student'], required: ['student'], financial: true,
    question: 'What has one family been billed and paid?',
    total: (rows) => `${plural(rows.length, 'invoice')} · ${moneyExact(sum(rows, 'balance'))} balance` },
  { key: 'exam-summary', title: 'Exam summary', category: 'Exams', icon: 'exams', params: ['exam'], required: ['exam'],
    question: 'How did every student do in one exam?',
    total: (rows) => {
      const sat = rows.filter((r) => typeof r.marksObtained === 'number');
      const pct = sum(sat, 'totalMarks') ? Math.round((sum(sat, 'marksObtained') / sum(sat, 'totalMarks')) * 100) : null;
      return `${plural(new Set(rows.map((r) => r.grNumber)).size, 'student')}${pct === null ? '' : ` · ${pct}% average`}`;
    } },
  { key: 'sms-usage', title: 'SMS usage', category: 'Communication', icon: 'message', params: ['from', 'to'],
    question: 'How many messages did we send, and did they arrive?',
    total: (rows) => `${plural(sum(rows, 'count'), 'message')} · ${plural(sum(rows, 'segments'), 'segment')}`,
    chart: (rows) => <Bars rows={rows.map((r) => ({ label: humanize(String(r.status)), value: Number(r.count) }))} unit="messages" /> },
];

const LIVE: LiveSpec[] = [
  { key: 'live-attendance', title: 'Attendance overview', category: 'Attendance', icon: 'dashboard', href: '/attendance',
    question: 'How is today going, and which registers are behind?', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { key: 'live-performance', title: 'Class performance', category: 'Exams', icon: 'performance', href: '/students?tab=performance',
    question: 'Which classes are slipping, and which students are at risk?', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN'] },
  { key: 'live-staff', title: 'Staff attendance', category: 'Staff', icon: 'staff', href: '/staff-attendance',
    question: 'Who is in today, who is late, who is away?', roles: ['OWNER_ADMIN', 'CAMPUS_ADMIN', 'HR_MANAGER'] },
];

const CATEGORIES: Category[] = ['Enrollment', 'Attendance', 'Fees', 'Exams', 'Staff', 'Communication'];
const LABEL: Record<ParamKind, string> = { date: 'Day', from: 'From', to: 'To', minDays: 'Overdue by at least (days)', student: 'Student', section: 'Section', exam: 'Exam' };
const QUERY: Record<ParamKind, string> = { date: 'date', from: 'from', to: 'to', minDays: 'minDays', student: 'studentId', section: 'sectionId', exam: 'examId' };
/** Defaults, so a report opens ready to run: today, or this month so far. */
const DEFAULTS: Partial<Record<ParamKind, () => string>> = { date: today, from: monthStart, to: today };

const COLUMN: Record<string, string> = {
  grNumber: 'GR no.', receiptNo: 'Receipt no.', transactionRef: 'Reference', activeStudents: 'Students', marksObtained: 'Marks',
  totalMarks: 'Out of', dueDate: 'Due', amountPaid: 'Amount', paidAt: 'Paid at', oldestDue: 'Oldest due', name: 'Student',
};
const MONEY = new Set(['amountPaid', 'total', 'paid', 'balance', 'outstanding']);
const heading = (k: string) => COLUMN[k] ?? k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
function humanize(v: string) { return v.charAt(0) + v.slice(1).toLowerCase().replace(/_/g, ' '); }
function cellText(k: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (MONEY.has(k) && typeof v === 'number') return moneyExact(v);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const d = new Date(v);
    return k === 'paidAt' ? d.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('en-GB');
  }
  // Enum-looking values (PRESENT, BANK_TRANSFER) read as words, in sentence case.
  if (typeof v === 'string' && /^[A-Z][A-Z_]+$/.test(v)) return humanize(v);
  return String(v);
}

// ── "Last run", per viewer. A convenience only: browser storage can be blocked, so every access is guarded.
const RUN_KEY = 'sw.reports.lastRun';
function readRuns(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(RUN_KEY) ?? '{}') as Record<string, string>; } catch { return {}; }
}
function noteRun(key: string) {
  try { localStorage.setItem(RUN_KEY, JSON.stringify({ ...readRuns(), [key]: new Date().toISOString() })); } catch { /* storage blocked */ }
}
function ago(iso?: string): string {
  if (!iso) return 'Not run yet';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'Last run just now';
  if (mins < 60) return `Last run ${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `Last run ${hrs} h ago`;
  return `Last run ${new Date(iso).toLocaleDateString('en-GB')}`;
}

export default function ReportsPage() {
  const me = useMe();
  const isAdmin = hasAnyRole(me?.roles, ['OWNER_ADMIN', 'CAMPUS_ADMIN']);
  const reports = isAdmin ? REPORTS : REPORTS.filter((r) => r.financial);
  const live = LIVE.filter((l) => hasAnyRole(me?.roles, l.roles));
  const [open, setOpen] = useState<string | null>(() =>
    (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('report')));

  const go = (key: string | null) => {
    const url = new URL(window.location.href);
    if (key) url.searchParams.set('report', key); else url.searchParams.delete('report');
    window.history.pushState(window.history.state, '', url);
    setOpen(key);
    window.scrollTo({ top: 0 });
  };
  useEffect(() => {
    const onPop = () => setOpen(new URLSearchParams(window.location.search).get('report'));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (!me) return <p className="muted">Loading…</p>;
  const spec = reports.find((r) => r.key === open);
  // Keyed: Back/Forward between two reports must not carry one report's filters into the other.
  if (spec) return <ReportView key={spec.key} spec={spec} onBack={() => go(null)} />;
  return <Gallery reports={reports} live={live} onOpen={go} />;
}

// ── Gallery ────────────────────────────────────────────────────────────────────────────────────────────
function Gallery({ reports, live, onOpen }: { reports: ReportSpec[]; live: LiveSpec[]; onOpen: (key: string) => void }) {
  const [preview, setPreview] = useState<Record<string, string | null>>({});
  const [runs, setRuns] = useState<Record<string, string>>({});
  useEffect(() => { setRuns(readRuns()); }, []);

  // Live preview figures — one cheap call per card, each failing quietly to "—" rather than blocking the gallery.
  useEffect(() => {
    let alive = true;
    const put = (k: string, v: string | null) => { if (alive) setPreview((p) => ({ ...p, [k]: v })); };
    const keys = new Set(reports.map((r) => r.key));
    const rows = (path: string) => apiGet<Row[]>(path);
    if (keys.has('daily-collection')) rows(`/reports/daily-collection?date=${today()}`).then((r) => put('daily-collection', `${moneyShort(sum(r, 'amountPaid'))} today`)).catch(() => put('daily-collection', null));
    if (keys.has('defaulters')) rows('/reports/defaulters').then((r) => put('defaulters', `${plural(r.length, 'student')} · ${moneyShort(sum(r, 'outstanding'))}`)).catch(() => put('defaulters', null));
    if (keys.has('class-strength')) rows('/reports/class-strength').then((r) => put('class-strength', plural(sum(r, 'activeStudents'), 'student'))).catch(() => put('class-strength', null));
    if (keys.has('sms-usage')) rows(`/reports/sms-usage?from=${monthStart()}`).then((r) => put('sms-usage', `${plural(sum(r, 'count'), 'message')} this month`)).catch(() => put('sms-usage', null));
    if (keys.has('attendance-register')) api.reportLookups.sections().then((s) => put('attendance-register', plural(s.length, 'section'))).catch(() => put('attendance-register', null));
    if (keys.has('exam-summary')) api.reportLookups.exams().then((e) => put('exam-summary', plural(e.length, 'exam'))).catch(() => put('exam-summary', null));
    if (keys.has('fee-ledger')) put('fee-ledger', 'Any family');
    return () => { alive = false; };
  }, [reports.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = CATEGORIES
    .map((c) => ({ c, reports: reports.filter((r) => r.category === c), live: live.filter((l) => l.category === c) }))
    .filter((g) => g.reports.length + g.live.length > 0);

  return (
    <div className="oh">
      <div className="ov-head">
        <div>
          <h1 style={{ margin: 0 }}>Reports</h1>
          <p className="ov-lede">Pick the question you want answered. Every report can be downloaded as CSV or PDF.</p>
        </div>
      </div>
      {groups.map((g) => (
        <section key={g.c} aria-labelledby={`cat-${g.c}`} className="stack" style={{ gap: 10 }}>
          <h2 id={`cat-${g.c}`} className="ov-cat">{g.c}</h2>
          <div className="ov-gallery">
            {g.reports.map((r) => (
              <button key={r.key} type="button" className="ov-rcard" onClick={() => onOpen(r.key)}>
                <span className="ov-rcard-head">
                  <span className="ov-rcard-ico" aria-hidden><Icon name={r.icon} size={18} /></span>
                  <span className="ov-rcard-title">{r.title}</span>
                </span>
                <span className="ov-rcard-q">{r.question}</span>
                <span className="ov-rcard-fig">
                  {!(r.key in preview) ? <span className="ov-skel" style={{ display: 'inline-block', width: 110, height: 18 }} aria-label="Loading" />
                    : preview[r.key] ?? '—'}
                </span>
                <span className="ov-rcard-foot">{ago(runs[r.key])}</span>
              </button>
            ))}
            {g.live.map((l) => (
              <Link key={l.key} href={l.href} className="ov-rcard is-live">
                <span className="ov-rcard-head">
                  <span className="ov-rcard-ico" aria-hidden><Icon name={l.icon} size={18} /></span>
                  <span className="ov-rcard-title">{l.title}</span>
                </span>
                <span className="ov-rcard-q">{l.question}</span>
                <span className="ov-rcard-fig"><span className="ov-live-dot" aria-hidden /> Live view</span>
                <span className="ov-rcard-foot">Opens the live screen <Icon name="chevron-right" size={12} /></span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ── One report ─────────────────────────────────────────────────────────────────────────────────────────
function ReportView({ spec, onBack }: { spec: ReportSpec; onBack: () => void }) {
  const [values, setValues] = useState<Partial<Record<ParamKind, string>>>(() =>
    Object.fromEntries(spec.params.filter((p) => DEFAULTS[p]).map((p) => [p, DEFAULTS[p]!()])));
  const [student, setStudent] = useState<ReportStudentOption | null>(null);
  const [sections, setSections] = useState<Array<{ id: string; label: string; campus: string }> | null>(null);
  const [exams, setExams] = useState<Array<{ id: string; label: string; term: string }> | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [ranWith, setRanWith] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (spec.params.includes('section')) api.reportLookups.sections().then(setSections).catch(() => setSections([]));
    if (spec.params.includes('exam')) api.reportLookups.exams().then(setExams).catch(() => setExams([]));
  }, [spec]);

  const valueOf = (p: ParamKind) => (p === 'student' ? student?.id : values[p]);
  const missing = (spec.required ?? []).filter((p) => !valueOf(p));
  const query = (extra?: string) => {
    const parts = spec.params.map((p) => [QUERY[p], valueOf(p)] as const).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`);
    if (extra) parts.push(extra);
    return parts.length ? `?${parts.join('&')}` : '';
  };
  const current = query();

  async function run() {
    if (missing.length) return;
    setErr(null); setBusy(true);
    try {
      setRows(await apiGet<Row[]>(`/reports/${spec.key}${current}`));
      setRanWith(current);
      noteRun(spec.key);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not run the report.'); }
    finally { setBusy(false); }
  }
  // A report with everything it needs runs on open — the owner came to read it, not to press a button.
  useEffect(() => { if (!(spec.required ?? []).length) void run(); }, [spec.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (p: ParamKind, v: string) => setValues((cur) => ({ ...cur, [p]: v }));
  const stale = rows !== null && ranWith !== current;

  const columns: Column<Row>[] = useMemo(() => {
    const keys = rows && rows.length ? Object.keys(rows[0]!) : [];
    return keys.map((k, i) => ({
      key: k, header: heading(k), pinned: i === 0,
      align: MONEY.has(k) || typeof rows![0]![k] === 'number' ? 'right' as const : undefined,
      sortValue: (r: Row) => { const v = r[k]; return typeof v === 'number' ? v : v === null || v === undefined ? null : String(v); },
      cell: (r: Row) => <span className={MONEY.has(k) || typeof r[k] === 'number' ? 'ov-num' : undefined} style={{ fontWeight: MONEY.has(k) ? 600 : 400 }}>{cellText(k, r[k])}</span>,
    }));
  }, [rows]);

  return (
    <div className="oh">
      <div>
        <button type="button" className="ov-link" onClick={onBack}>← All reports</button>
        <div className="ov-head" style={{ marginTop: 6 }}>
          <div>
            <p className="ov-eyebrow">{spec.category}</p>
            <h1 style={{ margin: 0 }}>{spec.title}</h1>
            <p className="ov-lede">{spec.question}</p>
          </div>
        </div>
      </div>

      <form className="ov-card ov-filters" onSubmit={(e) => { e.preventDefault(); void run(); }} aria-label="Report filters">
        {spec.params.length === 0 && <p className="ov-sub" style={{ margin: 0 }}>This report has no filters — it covers the current academic year.</p>}
        {spec.params.map((p) => (
          // A div with a real <label> for the field — not a wrapping <label>, which folded the date control's
          // ‹ › buttons and readout into the input's accessible name.
          <div key={p} className="ov-field">
            <label htmlFor={`rep-${p}`}>{LABEL[p]}{spec.required?.includes(p) ? '' : ' (optional)'}</label>
            {p === 'student' ? (
              <StudentPicker id={`rep-${p}`} value={student} onChange={setStudent} />
            ) : p === 'section' ? (
              <SearchableSelect id={`rep-${p}`} value={values.section ?? ''} onChange={(v) => set('section', v)}
                placeholder={sections === null ? 'Loading…' : 'Search a section'} emptyLabel="No section matches."
                options={(sections ?? []).map((s) => ({ value: s.id, label: `${s.label}${new Set((sections ?? []).map((x) => x.campus)).size > 1 ? ` · ${s.campus}` : ''}` }))} />
            ) : p === 'exam' ? (
              <SearchableSelect id={`rep-${p}`} value={values.exam ?? ''} onChange={(v) => set('exam', v)}
                placeholder={exams === null ? 'Loading…' : 'Search an exam'} emptyLabel="No exam matches."
                options={(exams ?? []).map((x) => ({ value: x.id, label: `${x.label} · ${x.term}` }))} />
            ) : p === 'minDays' ? (
              <input id={`rep-${p}`} type="number" min={0} inputMode="numeric" placeholder="0" value={values.minDays ?? ''} onChange={(e) => set('minDays', e.target.value)} />
            ) : (
              <DateField id={`rep-${p}`} value={values[p] ?? ''} max={today()} onChange={(v) => set(p, v)} stepper={p === 'date'} />
            )}
          </div>
        ))}
        {spec.params.length > 0 && (
          <div className="ov-filters-go">
            <button type="submit" className="ov-btn-primary" disabled={busy || missing.length > 0}>{busy ? 'Running…' : rows ? 'Update' : 'Run report'}</button>
            {missing.length > 0 && <span className="ov-sub">Choose a {missing.map((m) => LABEL[m].toLowerCase()).join(' and ')} first.</span>}
          </div>
        )}
      </form>

      {err && <div className="toast err" role="alert">{err}</div>}

      {rows && (
        <section className="stack" style={{ gap: 12 }} aria-label="Results">
          <div className="ov-results-head">
            <div>
              <h2 className="ov-h3" style={{ margin: 0 }}>Results</h2>
              <p className="ov-sub" style={{ margin: 0 }}>
                {stale ? 'Filters changed — press Update to refresh.' : rows.length === 0 ? 'No rows' : spec.total?.(rows)}
              </p>
            </div>
            {/* Export sits WITH the results it exports, and exports exactly what was run — not unsaved filter edits. */}
            <div className="ov-export" role="group" aria-label="Export">
              <a className={`ov-btn-quiet-link${rows.length === 0 ? ' is-disabled' : ''}`} aria-disabled={rows.length === 0}
                href={rows.length ? `/api/v1/reports/${spec.key}${ranWith ? `${ranWith}&` : '?'}format=csv` : undefined}>Download CSV</a>
              <a className={`ov-btn-quiet-link${rows.length === 0 ? ' is-disabled' : ''}`} aria-disabled={rows.length === 0}
                href={rows.length ? `/api/v1/reports/${spec.key}${ranWith ? `${ranWith}&` : '?'}format=pdf` : undefined}>Download PDF</a>
            </div>
          </div>
          {rows.length === 0 ? (
            // One clear empty state — not an empty table under a second "nothing" line.
            <div className="ov-card"><EmptyState title="Nothing to report for these choices.">Try a different date or filter.</EmptyState></div>
          ) : (
            <>
              {spec.chart && <div className="ov-card">{spec.chart(rows)}</div>}
              <DataTable<Row>
                caption={`${spec.title} results`} noun="rows" columns={columns} rows={rows} rowKey={(r) => JSON.stringify(r)}
              />
            </>
          )}
        </section>
      )}
    </div>
  );
}

/** Horizontal bars, labelled with the value — readable without a legend or an axis. */
function Bars({ rows, money = false, unit = '', caption }: { rows: Array<{ label: string; value: number }>; money?: boolean; unit?: string; caption?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const fmt = (v: number) => (money ? moneyShort(v) : `${v.toLocaleString('en-US')}${unit ? ` ${unit}` : ''}`);
  return (
    <figure style={{ margin: 0 }}>
      {caption && <figcaption className="ov-sub" style={{ marginBottom: 8 }}>{caption}</figcaption>}
      <ul className="ov-hbars">
        {rows.map((r) => (
          <li key={r.label}>
            <span className="ov-hbars-label" title={r.label}>{r.label}</span>
            <span className="ov-bar"><span className="ov-bar-fill" style={{ width: `${(r.value / max) * 100}%` }} /></span>
            <span className="ov-num">{fmt(r.value)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
