'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  api, apiGet, type AttendanceStatus, type Paged, type Student, type StudentDetail, type StudentPerformance,
  type StudentStatus, type StudentSummary,
} from '@sw/api-client';
import {
  DataTable, DetailDrawer, EmptyState, KpiStrip, RowActions, ScopeBar, StatusPill, useScope,
  type Column, type KpiTileSpec, type Tone,
} from '@school/components/oversight';
import { moneyShort } from '@school/lib/money';
import { PerformanceTab } from './owner-performance';

/**
 * The owner's Students hub (Owner UX Remediation Plan, Phase 1b — issues 3, 4, 8).
 *
 * Summary → slice → record: the KPI strip answers "how are my students today?", the scope bar narrows
 * Campus ▸ Class ▸ Section, the table lists the children with the signals an owner acts on (today's mark,
 * attendance, test average, fees), and a row opens the record in a drawer without leaving the list.
 *
 * Oversight, not operation: no admit / status / move buttons here. Those belong to the office roles; the
 * owner reaches the full profile (and the rare typed-confirmation delete) from the drawer.
 */

const PAGE_SIZE = 25;

/** One tile = one filter = one query. The SAME params the server counts the tile with. */
type TileKey = 'ACTIVE' | 'PRESENT' | 'ABSENT' | 'ON_LEAVE' | 'NEW' | 'DEFAULTER' | 'NO_GUARDIAN' | 'WITHDRAWN';
const TILE_QUERY: Record<TileKey, Record<string, string>> = {
  ACTIVE: { status: 'ACTIVE' },
  PRESENT: { status: 'ACTIVE', today: 'PRESENT' },
  ABSENT: { status: 'ACTIVE', today: 'ABSENT' },
  ON_LEAVE: { status: 'ACTIVE', today: 'ON_LEAVE' },
  NEW: { status: 'ACTIVE', newThisMonth: 'true' },
  DEFAULTER: { status: 'ACTIVE', feeDefaulter: 'true' },
  NO_GUARDIAN: { status: 'ACTIVE', missingGuardian: 'true' },
  WITHDRAWN: { status: 'WITHDRAWN' },
};
const TILE_TITLE: Record<TileKey, string> = {
  ACTIVE: 'Active students', PRESENT: 'Present today', ABSENT: 'Absent today', ON_LEAVE: 'On leave today',
  NEW: 'New this month', DEFAULTER: 'Fee defaulters', NO_GUARDIAN: 'Missing guardian', WITHDRAWN: 'Withdrawn',
};

const STATUS_TONE: Record<StudentStatus, Tone> = {
  ACTIVE: 'ok', SUSPENDED: 'warn', RESTRICTED: 'warn', STRUCK_OFF: 'bad', WITHDRAWN: 'neutral', GRADUATED: 'info',
};
const STATUS_WORD: Record<StudentStatus, string> = {
  ACTIVE: 'Active', SUSPENDED: 'Suspended', RESTRICTED: 'Restricted', STRUCK_OFF: 'Struck off', WITHDRAWN: 'Withdrawn', GRADUATED: 'Graduated',
};
const TODAY: Record<AttendanceStatus, { word: string; tone: Tone }> = {
  PRESENT: { word: 'Present', tone: 'ok' }, LATE: { word: 'Late', tone: 'warn' }, HALF_DAY: { word: 'Half day', tone: 'warn' },
  ABSENT: { word: 'Absent', tone: 'bad' }, ON_LEAVE: { word: 'On leave', tone: 'info' },
};

function qs(o: Record<string, string | number | null | undefined>) {
  return new URLSearchParams(
    Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => [k, String(v)]),
  ).toString();
}
const n = (v: number) => v.toLocaleString('en-US');

/** "s/o Tariq Butt" for a father, the relation spelled out otherwise — how a register tells two Ahmeds apart. */
export function parentage(s: Pick<Student, 'gender' | 'primaryGuardian'>): string | null {
  const g = s.primaryGuardian;
  if (!g) return null;
  if (g.relation === 'FATHER') return `${s.gender === 'FEMALE' ? 'd/o' : 's/o'} ${g.fullName}`;
  return `${g.relation.charAt(0)}${g.relation.slice(1).toLowerCase()}: ${g.fullName}`;
}
export function classSection(s: Pick<Student, 'enrollments'>): string | null {
  const e = s.enrollments?.[0];
  return e ? `${e.class.name} — ${e.section.name}` : null;
}
function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
}
/** Percent with a tone: the thresholds Pakistani schools act on (75% attendance, 50% pass mark). */
function Pct({ v, warnBelow, badBelow }: { v: number | null | undefined; warnBelow: number; badBelow: number }) {
  if (v === null || v === undefined) return <span className="ov-muted" title="Nothing recorded yet">—</span>;
  const tone = v < badBelow ? 'is-bad' : v < warnBelow ? 'is-warn' : '';
  return <span className={`ov-num ${tone}`}>{v}%</span>;
}

function readTab(): 'students' | 'performance' {
  if (typeof window === 'undefined') return 'students';
  return new URLSearchParams(window.location.search).get('tab') === 'performance' ? 'performance' : 'students';
}

export function OwnerStudentsHub({ onOpenProfile, onDelete, reloadKey = 0 }: {
  /** Opens the full profile (the existing office screen) for this student. */
  onOpenProfile: (id: string) => void;
  /** The typed-confirmation delete lives with the parent page's dialog. */
  onDelete: (s: Student) => void;
  /** Bump to refetch after a change made outside the hub (a delete). */
  reloadKey?: number;
}) {
  const scopeState = useScope();
  const { scope } = scopeState;
  const [tab, setTabState] = useState<'students' | 'performance'>(readTab);
  const [tile, setTile] = useState<TileKey>('ACTIVE');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>({ key: 'name', dir: 'asc' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<Student> | null>(null);
  const [summary, setSummary] = useState<StudentSummary | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const setTab = (t: 'students' | 'performance') => {
    setTabState(t);
    const url = new URL(window.location.href);
    if (t === 'performance') url.searchParams.set('tab', 'performance'); else url.searchParams.delete('tab');
    window.history.replaceState(window.history.state, '', url);
  };

  // Search as you type, without a request per keystroke.
  useEffect(() => { const t = setTimeout(() => setDebounced(search.trim()), 300); return () => clearTimeout(t); }, [search]);

  const scopeQ = { campusId: scope.campusId, classId: scope.classId, sectionId: scope.sectionId };
  const scopeKey = `${scope.campusId}|${scope.classId}|${scope.sectionId}`;
  const sortParam = sort ? `${sort.key}:${sort.dir}` : 'name:asc';

  useEffect(() => { setPage(1); }, [scopeKey, tile, debounced, sortParam]);

  useEffect(() => {
    if (tab !== 'students') return;
    let alive = true;
    setData(null);
    apiGet<Paged<Student>>(`/students?${qs({ ...scopeQ, ...TILE_QUERY[tile], search: debounced, sort: sortParam, page, pageSize: PAGE_SIZE })}`)
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setData({ data: [], total: 0, page: 1, pageSize: PAGE_SIZE }); });
    return () => { alive = false; };
  }, [tab, scopeKey, tile, debounced, sortParam, page, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    setSummary(null);
    api.students.summary({ campusId: scope.campusId ?? undefined, classId: scope.classId ?? undefined, sectionId: scope.sectionId ?? undefined })
      .then((s) => { if (alive) setSummary(s); }).catch(() => {});
    return () => { alive = false; };
  }, [scopeKey, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeDrawer = useCallback(() => setOpenId(null), []);
  const pick = (k: TileKey) => { setTile((cur) => (cur === k && k !== 'ACTIVE' ? 'ACTIVE' : k)); setTab('students'); };

  const t = summary?.today;
  const marked = t ? t.present + t.absent + t.onLeave : 0;
  const tiles: KpiTileSpec[] = ([
    { key: 'ACTIVE', label: 'Active students', value: summary ? n(summary.active) : undefined, icon: 'students', tone: 'neutral',
      sub: summary ? `${n(summary.withdrawn)} withdrawn` : undefined, hint: 'Everyone currently enrolled in this scope' },
    { key: 'PRESENT', label: 'Present today', icon: 'check-circle', tone: 'ok',
      value: !t ? undefined : t.schoolDayOpen ? (t.presentPercent === null ? '—' : `${t.presentPercent}%`) : 'Closed',
      sub: !t ? undefined : !t.schoolDayOpen ? (t.closedReason ?? 'No school today')
        : marked === 0 ? 'No register marked yet' : `${n(t.present)} of ${n(marked)} marked${t.late ? ` · ${n(t.late)} late` : ''}`,
      hint: 'Present, late or half-day, out of the students marked so far today' },
    { key: 'ABSENT', label: 'Absent today', icon: 'x-circle', tone: t && t.absent > 0 ? 'bad' : 'neutral', value: t ? n(t.absent) : undefined,
      sub: t && t.schoolDayOpen && t.unmarked > 0 ? `${n(t.unmarked)} not marked yet` : undefined, hint: 'Marked absent on today’s register' },
    { key: 'ON_LEAVE', label: 'On leave', icon: 'leave', tone: 'info', value: t ? n(t.onLeave) : undefined, hint: 'On approved leave today' },
    { key: 'NEW', label: 'New this month', icon: 'admissions', tone: 'info', value: summary ? n(summary.newThisMonth) : undefined, hint: 'Joined since the 1st of this month' },
    { key: 'DEFAULTER', label: 'Fee defaulters', icon: 'fees', tone: summary && summary.feeDefaulters > 0 ? 'warn' : 'neutral',
      value: summary ? n(summary.feeDefaulters) : undefined, hint: 'An unpaid invoice past its due date' },
    { key: 'NO_GUARDIAN', label: 'Missing guardian', icon: 'alert', tone: summary && summary.missingGuardian > 0 ? 'bad' : 'neutral',
      value: summary ? n(summary.missingGuardian) : undefined, hint: 'Nobody on record to contact — these families get no SMS' },
  ] satisfies KpiTileSpec[]).map((x) => ({ ...x, active: tab === 'students' && tile === x.key, onClick: () => pick(x.key as TileKey) }));

  const allCampuses = !scope.campusId && scopeState.campuses.length > 1;
  const columns: Column<Student>[] = [
    { key: 'name', header: 'Student', pinned: true, serverSortable: true, cell: (s) => (
      <span className="ov-person">
        <span className="ov-avatar" aria-hidden>{initials(s.fullName)}</span>
        <span className="ov-person-text">
          <strong>{s.fullName}</strong>
          <span className="ov-sub">{parentage(s) ?? <span className="ov-warn-text">No guardian on record</span>}</span>
        </span>
      </span>
    ) },
    { key: 'class', header: 'Class', cell: (s) => {
      const cs = classSection(s);
      if (!cs) return <span className="ov-muted">Not enrolled</span>;
      return <span className="ov-person-text"><span>{cs}</span>{allCampuses && <span className="ov-sub">{s.enrollments![0]!.campus.name}</span>}</span>;
    } },
    { key: 'gr', header: 'GR no.', serverSortable: true, width: '110px', cell: (s) => <span className="ov-num">{s.grNumber}</span> },
    { key: 'today', header: 'Today', cell: (s) => (s.todayStatus
      ? <StatusPill tone={TODAY[s.todayStatus].tone}>{TODAY[s.todayStatus].word}</StatusPill>
      : <span className="ov-muted">Not marked</span>) },
    { key: 'att', header: 'Attendance', align: 'right', cell: (s) => <Pct v={s.attendancePercent} warnBelow={85} badBelow={75} /> },
    { key: 'perf', header: 'Test avg', align: 'right', cell: (s) => <Pct v={s.performancePercent} warnBelow={60} badBelow={50} /> },
    { key: 'fees', header: 'Fees', cell: (s) => (s.feeStatus === 'OVERDUE'
      ? <StatusPill tone="bad">Overdue {moneyShort(s.outstanding ?? 0, 'short')}</StatusPill>
      : s.feeStatus === 'DUE' ? <StatusPill tone="warn">Due {moneyShort(s.outstanding ?? 0, 'short')}</StatusPill>
        : <StatusPill tone="ok">Clear</StatusPill>) },
    { key: 'status', header: 'Status', defaultHidden: true, cell: (s) => <StatusPill tone={STATUS_TONE[s.status]}>{STATUS_WORD[s.status]}</StatusPill> },
    { key: 'gender', header: 'Gender', defaultHidden: true, cell: (s) => s.gender.charAt(0) + s.gender.slice(1).toLowerCase() },
    { key: 'reg', header: 'Reg. no.', defaultHidden: true, cell: (s) => s.registrationNo ?? '—' },
    { key: 'joined', header: 'Added', defaultHidden: true, serverSortable: true, cell: (s) => {
      const d = s.enrollments?.[0]?.startedAt;
      return d ? new Date(d).toLocaleDateString('en-GB') : '—';
    } },
    { key: 'actions', header: '', pinned: true, align: 'right', width: '56px', cell: (s) => (
      <RowActions label={`Actions for ${s.fullName}`} actions={[
        { label: 'View summary', onSelect: () => setOpenId(s.id) },
        { label: 'Open full profile', onSelect: () => onOpenProfile(s.id) },
        { label: 'Copy GR number', onSelect: () => { void navigator.clipboard?.writeText(s.grNumber); setNote(`Copied ${s.grNumber}`); } },
      ]} />
    ) },
  ];

  const exportCsv = (rows: Student[], clear: () => void) => {
    // Formula-injection-safe, like every report CSV (Key Decisions 2026-09-24): a cell starting = + - @ tab/CR
    // is prefixed with ' so a spreadsheet shows it as text instead of running it.
    const esc = (v: string | number | null | undefined) => {
      const s = String(v ?? '');
      return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
    };
    const head = ['GR', 'Name', 'Parentage', 'Class', 'Today', 'Attendance %', 'Test avg %', 'Fees', 'Outstanding', 'Status'];
    const body = rows.map((r) => [r.grNumber, r.fullName, parentage(r), classSection(r), r.todayStatus ? TODAY[r.todayStatus].word : 'Not marked',
      r.attendancePercent, r.performancePercent, r.feeStatus === 'OVERDUE' ? 'Overdue' : r.feeStatus === 'DUE' ? 'Due' : 'Clear', r.outstanding, STATUS_WORD[r.status]].map(esc).join(','));
    const url = URL.createObjectURL(new Blob([[head.join(','), ...body].join('\n')], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: 'students.csv' }).click();
    URL.revokeObjectURL(url);
    setNote(`Exported ${rows.length} student${rows.length === 1 ? '' : 's'}.`);
    clear();
  };

  const filtered = tile !== 'ACTIVE' || !!debounced;
  return (
    <div className="oh">
      <div className="ov-head">
        <div>
          <h1 style={{ margin: 0 }}>Students</h1>
          <p className="ov-lede">Who is enrolled, who is here today, and who needs attention.</p>
        </div>
        <div className="ov-tabs" role="tablist" aria-label="Students view">
          <button type="button" role="tab" aria-selected={tab === 'students'} className={`ov-tab${tab === 'students' ? ' is-active' : ''}`} onClick={() => setTab('students')}>Directory</button>
          <button type="button" role="tab" aria-selected={tab === 'performance'} className={`ov-tab${tab === 'performance' ? ' is-active' : ''}`} onClick={() => setTab('performance')}>Performance</button>
        </div>
      </div>
      {note && <div className="toast ok" role="status">{note}</div>}

      <KpiStrip label="Students at a glance" tiles={tiles} />

      <ScopeBar state={scopeState}>
        {tab === 'students' && (
          <label className="ov-field ov-search">
            <span>Search</span>
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, GR no. or parent’s phone" />
          </label>
        )}
      </ScopeBar>

      {tab === 'performance' ? (
        <PerformanceTab scope={scope} onOpenStudent={(id) => setOpenId(id)} onPickClass={(id) => scopeState.setClass(id)} />
      ) : (
        <DataTable<Student>
          caption="Students"
          noun="students"
          columns={columns}
          rows={data?.data ?? []}
          rowKey={(s) => s.id}
          loading={!data}
          onRowClick={(s) => setOpenId(s.id)}
          rowLabel={(s) => `Open ${s.fullName}`}
          serverPaging={data ? { page: data.page, pageSize: data.pageSize, total: data.total, onPageChange: setPage } : undefined}
          serverSort={{ sort, onSortChange: setSort }}
          selectable
          toolbar={filtered ? (
            <span className="ov-filter-chip">
              Showing: <strong>{TILE_TITLE[tile]}</strong>{debounced && <> matching “{debounced}”</>}
              <button type="button" className="ov-link" onClick={() => { setTile('ACTIVE'); setSearch(''); }}>Reset</button>
            </span>
          ) : undefined}
          bulkActions={(rows, clear) => <button type="button" className="ov-btn-quiet" onClick={() => exportCsv(rows, clear)}>Export selected</button>}
          empty={
            <EmptyState title={debounced ? `No students match “${debounced}”` : `No ${TILE_TITLE[tile].toLowerCase()} here`}
              action={<button type="button" className="ov-link" onClick={() => { setTile('ACTIVE'); setSearch(''); scopeState.reset(); }}>Clear all filters</button>}>
              {tile === 'ACTIVE' ? 'Try another campus, class or section.' : 'That is good news, or the scope is narrow — widen it to check.'}
            </EmptyState>
          }
        />
      )}

      <StudentDrawer id={openId} onClose={closeDrawer}
        onOpenProfile={(id) => { closeDrawer(); onOpenProfile(id); }}
        onDelete={(s) => { closeDrawer(); onDelete(s); }} />
    </div>
  );
}

/** The record without leaving the list: identity, placement, guardians, and the three signals over time. */
function StudentDrawer({ id, onClose, onOpenProfile, onDelete }: {
  id: string | null; onClose: () => void; onOpenProfile: (id: string) => void; onDelete: (s: Student) => void;
}) {
  const [detail, setDetail] = useState<StudentDetail | null>(null);
  const [row, setRow] = useState<Student | null>(null);
  const [perf, setPerf] = useState<StudentPerformance | null | 'none'>(null);

  useEffect(() => {
    setDetail(null); setRow(null); setPerf(null);
    if (!id) return;
    let alive = true;
    apiGet<StudentDetail>(`/students/${id}`).then((d) => {
      if (!alive) return;
      setDetail(d);
      // The list row carries the computed signals (attendance, fees) — fetch it by exact GR.
      apiGet<Paged<Student>>(`/students?${qs({ search: d.grNumber, pageSize: 5 })}`)
        .then((p) => { if (alive) setRow(p.data.find((x) => x.id === id) ?? null); }).catch(() => {});
    }).catch(() => {});
    api.performance.forStudent(id, '6m').then((p) => { if (alive) setPerf(p); }).catch(() => { if (alive) setPerf('none'); });
    return () => { alive = false; };
  }, [id]);

  const enrol = row?.enrollments?.[0];
  const title = detail?.fullName ?? 'Loading…';
  const subtitle = detail ? [detail.grNumber, enrol ? `${enrol.class.name} — ${enrol.section.name}` : null, enrol?.campus.name].filter(Boolean).join(' · ') : undefined;
  const p = perf && perf !== 'none' ? perf : null;

  return (
    <DetailDrawer open={!!id} onClose={onClose} title={title} subtitle={subtitle}
      footer={
        <>
          {detail && row && (
            <button type="button" className="ov-btn-danger-quiet" onClick={() => onDelete(row)}>Delete record…</button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="ov-btn-quiet" onClick={onClose}>Close</button>
          {id && <button type="button" className="ov-btn-primary" onClick={() => onOpenProfile(id)}>Open full profile</button>}
        </>
      }>
      {!detail ? <span className="ov-skel" style={{ height: 160, display: 'block' }} /> : (
        <>
          <div className="ov-drawer-pills">
            <StatusPill tone={STATUS_TONE[detail.status]}>{STATUS_WORD[detail.status]}</StatusPill>
            {row?.todayStatus ? <StatusPill tone={TODAY[row.todayStatus].tone}>Today: {TODAY[row.todayStatus].word}</StatusPill>
              : <StatusPill tone="neutral">Today: not marked</StatusPill>}
          </div>

          <div className="ov-stats3">
            <div><span className="ov-stat-label">Attendance</span><span className="ov-stat-value"><Pct v={row?.attendancePercent} warnBelow={85} badBelow={75} /></span><span className="ov-sub">this year</span></div>
            <div><span className="ov-stat-label">Test average</span><span className="ov-stat-value"><Pct v={p?.overall.percent ?? null} warnBelow={60} badBelow={50} /></span><span className="ov-sub">{p ? `${p.overall.testsTaken} tests · 6 months` : 'last 6 months'}</span></div>
            <div><span className="ov-stat-label">Fees</span><span className="ov-stat-value">{row?.feeStatus === 'CLEAR' || !row ? <span className="ov-num">Clear</span>
              : <span className={`ov-num ${row.feeStatus === 'OVERDUE' ? 'is-bad' : 'is-warn'}`}>{moneyShort(row.outstanding ?? 0, 'short')}</span>}</span>
              <span className="ov-sub">{row?.feeStatus === 'OVERDUE' ? 'overdue' : row?.feeStatus === 'DUE' ? 'due, not late' : 'nothing owed'}</span></div>
          </div>

          {p && p.monthly.length > 0 && (
            <section>
              <h3 className="ov-h3">Results by month</h3>
              <MonthBars months={p.monthly} />
            </section>
          )}
          {p && p.subjects.length > 0 && (
            <section>
              <h3 className="ov-h3">By subject <span className="ov-sub">(weakest first)</span></h3>
              <ul className="ov-bars">
                {p.subjects.slice(0, 6).map((s) => (
                  <li key={s.subjectId}>
                    <span>{s.subjectName}</span>
                    <span className="ov-bar"><span className={`ov-bar-fill ${barTone(s.percent)}`} style={{ width: `${s.percent ?? 0}%` }} /></span>
                    <Pct v={s.percent} warnBelow={60} badBelow={50} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 className="ov-h3">Guardians</h3>
            {detail.guardians.length === 0 ? <p className="ov-warn-text" style={{ margin: 0 }}>No guardian on record — this family receives no SMS.</p> : (
              <ul className="ov-list">
                {detail.guardians.map((g) => (
                  <li key={g.id}>
                    <strong>{g.parent.fullName}</strong> <span className="ov-sub">{g.relation.charAt(0) + g.relation.slice(1).toLowerCase()}{g.isPrimary ? ' · primary' : ''}</span>
                    <div className="ov-sub">{g.parent.phone}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="ov-h3">Record</h3>
            <dl className="ov-dl">
              <dt>Registration no.</dt><dd>{detail.registrationNo ?? '—'}</dd>
              <dt>Date of birth</dt><dd>{new Date(detail.dateOfBirth).toLocaleDateString('en-GB')}</dd>
              <dt>Gender</dt><dd>{detail.gender.charAt(0) + detail.gender.slice(1).toLowerCase()}</dd>
              <dt>Roll no.</dt><dd>{enrol?.rollNumber ?? '—'}</dd>
              <dt>Joined</dt><dd>{enrol ? new Date(enrol.startedAt).toLocaleDateString('en-GB') : '—'}</dd>
              <dt>Outstanding</dt><dd>{detail.missingFields.length ? detail.missingFields.join(', ') : 'Nothing — record complete'}</dd>
            </dl>
          </section>
        </>
      )}
    </DetailDrawer>
  );
}

export function barTone(v: number | null | undefined) {
  if (v === null || v === undefined) return '';
  return v < 50 ? 'is-bad' : v < 60 ? 'is-warn' : 'is-ok';
}

/** A small month-by-month column chart — the trend is the point, so no axes beyond the labels. */
function MonthBars({ months }: { months: StudentPerformance['monthly'] }) {
  // The API lists newest first; a trend reads left → right in time, so order it here, then keep the last 6.
  const last = [...months].sort((a, b) => a.month.localeCompare(b.month)).slice(-6);
  const spoken = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  return (
    <div className="ov-months" role="img" aria-label={`Monthly results: ${last.map((m) => `${spoken(m.month)} ${m.percent === null ? 'no tests' : `${m.percent}%`}`).join(', ')}`}>
      {last.map((m) => (
        <div key={m.month} className="ov-month">
          <span className="ov-month-val">{m.percent === null ? '—' : `${m.percent}%`}</span>
          <span className="ov-month-col"><span className={`ov-month-fill ${barTone(m.percent)}`} style={{ height: `${m.percent ?? 0}%` }} /></span>
          <span className="ov-month-lbl">{new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}</span>
        </div>
      ))}
    </div>
  );
}
