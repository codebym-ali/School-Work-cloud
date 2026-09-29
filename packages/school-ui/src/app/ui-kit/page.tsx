'use client';

import { useCallback, useEffect, useState } from 'react';
import { notFound } from 'next/navigation';
import { apiGet, type Paged, type Student, type StudentDetail, type StudentStatus } from '@sw/api-client';
import {
  DataTable, DetailDrawer, EmptyState, KpiStrip, RowActions, ScopeBar, StatusPill, useScope,
  type Column, type KpiTileSpec, type Tone,
} from '@school/components/oversight';

/**
 * DEV-ONLY preview of the Owner Oversight building blocks (Owner UX plan, Phase 1a), wired to REAL data so
 * each piece is verified live before Phase 1b builds the Students hub on them. 404s in production builds.
 */
const PAGE_SIZE = 25;
const STATUS_TONE: Record<StudentStatus, Tone> = {
  ACTIVE: 'ok', SUSPENDED: 'warn', RESTRICTED: 'warn', STRUCK_OFF: 'bad', WITHDRAWN: 'neutral', GRADUATED: 'info',
};
const STATUS_WORD: Record<StudentStatus, string> = {
  ACTIVE: 'Active', SUSPENDED: 'Suspended', RESTRICTED: 'Restricted', STRUCK_OFF: 'Struck off', WITHDRAWN: 'Withdrawn', GRADUATED: 'Graduated',
};
const FILTERS: Array<{ key: StudentStatus | ''; label: string; tone: Tone }> = [
  { key: '', label: 'All students', tone: 'neutral' },
  { key: 'ACTIVE', label: 'Active', tone: 'ok' },
  { key: 'SUSPENDED', label: 'Suspended', tone: 'warn' },
  { key: 'WITHDRAWN', label: 'Withdrawn', tone: 'neutral' },
];

function qs(o: Record<string, string | number | null | undefined>) {
  return new URLSearchParams(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString();
}

/** The production guard sits in a wrapper so it never precedes a hook (rules of hooks). */
export default function UiKitPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <UiKitPreview />;
}

function UiKitPreview() {
  const scopeState = useScope();
  const { scope, classes, sections, campuses } = scopeState;
  const [status, setStatus] = useState<StudentStatus | ''>('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<Student> | null>(null);
  const [counts, setCounts] = useState<Record<string, number | undefined>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StudentDetail | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const base = { campusId: scope.campusId, classId: scope.classId, sectionId: scope.sectionId };
  const scopeKey = `${scope.campusId}|${scope.classId}|${scope.sectionId}`;

  useEffect(() => { setPage(1); }, [scopeKey, status]);

  useEffect(() => {
    let alive = true;
    setData(null);
    apiGet<Paged<Student>>(`/students?${qs({ ...base, status, page, pageSize: PAGE_SIZE })}`)
      .then((d) => { if (alive) setData(d); }).catch(() => { if (alive) setData({ data: [], total: 0, page: 1, pageSize: PAGE_SIZE }); });
    return () => { alive = false; };
  }, [scopeKey, status, page]); // eslint-disable-line react-hooks/exhaustive-deps

  // KPI counts are SERVER totals for the scope, never counts of the page in hand.
  useEffect(() => {
    let alive = true;
    setCounts({});
    Promise.all(FILTERS.map((f) => apiGet<Paged<Student>>(`/students?${qs({ ...base, status: f.key, pageSize: 1 })}`).then((d) => [f.key, d.total] as const)))
      .then((r) => { if (alive) setCounts(Object.fromEntries(r)); }).catch(() => {});
    return () => { alive = false; };
  }, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setDetail(null);
    if (openId) apiGet<StudentDetail>(`/students/${openId}`).then(setDetail).catch(() => {});
  }, [openId]);

  const closeDrawer = useCallback(() => setOpenId(null), []);

  const tiles: KpiTileSpec[] = FILTERS.map((f) => ({
    key: f.key || 'ALL', label: f.label, tone: f.tone, value: counts[f.key],
    icon: f.key === 'ACTIVE' ? 'check-circle' : f.key === 'SUSPENDED' ? 'alert' : f.key === 'WITHDRAWN' ? 'unknown' : 'students',
    active: status === f.key, onClick: () => setStatus(f.key),
    hint: `Show ${f.label.toLowerCase()} in this scope`,
  }));

  const columns: Column<Student>[] = [
    { key: 'gr', header: 'GR no.', pinned: true, sortValue: (s) => s.grNumber, cell: (s) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{s.grNumber}</span>, width: '120px' },
    { key: 'name', header: 'Student', sortValue: (s) => s.fullName, cell: (s) => <strong style={{ fontWeight: 600 }}>{s.fullName}</strong> },
    { key: 'gender', header: 'Gender', defaultHidden: true, sortValue: (s) => s.gender, cell: (s) => s.gender.charAt(0) + s.gender.slice(1).toLowerCase() },
    { key: 'guardian', header: 'Guardian', sortValue: (s) => (s.hasGuardian ? 1 : 0),
      cell: (s) => (s.hasGuardian ? <StatusPill tone="ok">On record</StatusPill> : <StatusPill tone="bad">Missing</StatusPill>) },
    { key: 'status', header: 'Status', sortValue: (s) => STATUS_WORD[s.status], cell: (s) => <StatusPill tone={STATUS_TONE[s.status]}>{STATUS_WORD[s.status]}</StatusPill> },
    { key: 'actions', header: '', pinned: true, align: 'right', width: '56px',
      cell: (s) => (
        <RowActions label={`Actions for ${s.fullName}`} actions={[
          { label: 'View profile', onSelect: () => setOpenId(s.id) },
          { label: 'Copy GR number', onSelect: () => { void navigator.clipboard?.writeText(s.grNumber); setNote(`Copied ${s.grNumber}`); } },
          { label: 'Delete (preview only)', danger: true, onSelect: () => setNote('Preview only — nothing was deleted.') },
        ]} />
      ) },
  ];

  const enrol = detail?.enrollments.find((e) => e.status === 'ACTIVE') ?? detail?.enrollments[0];
  const klass = classes.find((c) => c.id === enrol?.classId);
  const section = sections.find((s) => s.id === enrol?.sectionId);
  const campus = campuses.find((c) => c.id === enrol?.campusId);
  const guardian = detail?.guardians[0];

  const exportCsv = (rows: Student[], clear: () => void) => {
    const csv = ['GR,Name,Status', ...rows.map((r) => `${r.grNumber},"${r.fullName.replace(/"/g, '""')}",${STATUS_WORD[r.status]}`)].join('\n');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: 'students-selection.csv' });
    a.click();
    setNote(`Exported ${rows.length} student(s).`);
    clear();
  };

  return (
    <div className="oh">
      <div>
        <h1 style={{ margin: 0 }}>UI kit — Owner Oversight (preview)</h1>
        <p className="muted" style={{ margin: '4px 0 0' }}>Development-only page. Every piece below runs on live data.</p>
      </div>
      {note && <div className="toast ok" role="status">{note}</div>}

      <KpiStrip label="Students in scope" tiles={tiles} />
      <ScopeBar state={scopeState} />

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
        initialSort={{ key: 'name', dir: 'asc' }}
        selectable
        bulkActions={(rows, clear) => (
          <button type="button" className="ov-btn-quiet" onClick={() => exportCsv(rows, clear)}>Export selected</button>
        )}
        empty={<EmptyState title="No students match this view" action={<button type="button" className="ov-link" onClick={() => { setStatus(''); scopeState.reset(); }}>Clear filters</button>}>
          Try another campus, class or status.
        </EmptyState>}
      />

      <DetailDrawer open={!!openId} onClose={closeDrawer}
        title={detail?.fullName ?? 'Loading…'}
        subtitle={detail ? `${detail.grNumber}${klass ? ` · ${klass.name}${section ? ` — ${section.name}` : ''}` : ''}${campus ? ` · ${campus.name}` : ''}` : undefined}
        footer={<button type="button" className="ov-btn-quiet" onClick={closeDrawer}>Close</button>}>
        {!detail ? <span className="ov-skel" style={{ height: 120, display: 'block' }} /> : (
          <>
            <div><StatusPill tone={STATUS_TONE[detail.status]}>{STATUS_WORD[detail.status]}</StatusPill></div>
            <dl className="ov-dl">
              <dt>Registration no.</dt><dd>{detail.registrationNo ?? '—'}</dd>
              <dt>Date of birth</dt><dd>{new Date(detail.dateOfBirth).toLocaleDateString('en-GB')}</dd>
              <dt>Roll no.</dt><dd>{enrol?.rollNumber ?? '—'}</dd>
              <dt>Guardian</dt><dd>{guardian ? `${guardian.parent.fullName} (${guardian.relation.toLowerCase()})` : 'None on record'}</dd>
              <dt>Record</dt><dd>{detail.missingFields.length ? `Missing: ${detail.missingFields.join(', ')}` : 'Complete'}</dd>
            </dl>
          </>
        )}
      </DetailDrawer>
    </div>
  );
}
