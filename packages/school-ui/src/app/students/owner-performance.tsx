'use client';

import { useEffect, useState } from 'react';
import {
  api, apiGet, RANGE_LABEL, type ClassPerformance, type ClassStudents, type Paged, type PerformanceRange, type Student,
} from '@sw/api-client';
import { DataTable, EmptyState, StatusPill, type Column, type Scope } from '@school/components/oversight';

/**
 * The Performance tab of the owner's Students hub (Owner UX 1b / plan §1.3 — issue 5), scoped by the same
 * Campus ▸ Class ▸ Section bar as the directory.
 *
 *  - No class chosen → every class in scope, worst first, with the trend against the previous period.
 *  - A class (optionally a section) → class average, the grade distribution, top 5, and **students at
 *    risk**: below the pass mark, falling 10+ points, or under 75% attendance — the combination a
 *    Pakistani school actually acts on.
 *
 * A presentation layer over `/reports/performance/*` (class tests) — the same arithmetic the student sees.
 */

const RANGES: PerformanceRange[] = ['1m', '3m', '6m'];
const PASS = 50;
const ATTENDANCE_FLOOR = 75;
const FALL = -10;

/** Letter bands a Pakistani report card uses. */
const BANDS: Array<{ label: string; min: number; tone: string }> = [
  { label: 'A+', min: 90, tone: 'is-ok' }, { label: 'A', min: 80, tone: 'is-ok' }, { label: 'B', min: 70, tone: 'is-ok' },
  { label: 'C', min: 60, tone: 'is-warn' }, { label: 'D', min: 50, tone: 'is-warn' }, { label: 'F', min: 0, tone: 'is-bad' },
];

type StudentRow = ClassStudents['students'][number] & { attendancePercent: number | null; risks: string[] };

function Trend({ v }: { v: number | null }) {
  if (v === null) return <span className="ov-muted">—</span>;
  if (v === 0) return <span className="ov-num">±0</span>;
  return <span className={`ov-num ${v < 0 ? 'is-bad' : 'is-ok-text'}`}>{v > 0 ? '▲' : '▼'} {Math.abs(v)}</span>;
}
function Pct({ v }: { v: number | null }) {
  if (v === null) return <span className="ov-muted" title="No tests in this period">Not tested</span>;
  return <span className={`ov-num ${v < PASS ? 'is-bad' : v < 60 ? 'is-warn' : ''}`}>{v}%</span>;
}

export function PerformanceTab({ scope, onOpenStudent, onPickClass }: {
  scope: Scope;
  onOpenStudent: (studentId: string) => void;
  onPickClass: (classId: string) => void;
}) {
  const [range, setRange] = useState<PerformanceRange>('3m');
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="ov-seg" role="radiogroup" aria-label="Period">
        {RANGES.map((r) => (
          <button key={r} type="button" role="radio" aria-checked={range === r} className={`ov-seg-btn${range === r ? ' is-active' : ''}`} onClick={() => setRange(r)}>
            {RANGE_LABEL[r]}
          </button>
        ))}
        <span className="ov-sub" style={{ marginLeft: 8 }}>Class-test results. Trend compares with the period before.</span>
      </div>
      {scope.classId
        ? <ClassView classId={scope.classId} sectionId={scope.sectionId} range={range} onOpenStudent={onOpenStudent} />
        : <SchoolView campusId={scope.campusId} range={range} onPickClass={onPickClass} />}
    </div>
  );
}

function SchoolView({ campusId, range, onPickClass }: { campusId: string | null; range: PerformanceRange; onPickClass: (id: string) => void }) {
  const [rows, setRows] = useState<ClassPerformance[] | null>(null);
  useEffect(() => {
    let alive = true;
    setRows(null);
    api.performance.byClass(range, campusId ?? undefined).then((r) => { if (alive) setRows(r); }).catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [campusId, range]);

  const tested = (rows ?? []).filter((r) => r.percent !== null);
  const obtained = tested.reduce((a, r) => a + r.marksObtained, 0);
  const total = tested.reduce((a, r) => a + r.marksTotal, 0);
  const avg = total > 0 ? Math.round((obtained / total) * 100) : null;
  const below = tested.filter((r) => (r.percent ?? 0) < PASS).length;
  const falling = tested.filter((r) => (r.trend ?? 0) <= FALL).length;
  const untested = (rows ?? []).filter((r) => r.percent === null && r.students > 0).length;

  const columns: Column<ClassPerformance>[] = [
    { key: 'class', header: 'Class', pinned: true, sortValue: (r) => r.order, cell: (r) => <strong style={{ fontWeight: 600 }}>{r.className}</strong> },
    { key: 'students', header: 'Students', align: 'right', sortValue: (r) => r.students, cell: (r) => <span className="ov-num">{r.students}</span> },
    { key: 'avg', header: 'Average', align: 'right', sortValue: (r) => r.percent, cell: (r) => <Pct v={r.percent} /> },
    { key: 'trend', header: 'Trend', align: 'right', sortValue: (r) => r.trend, cell: (r) => <Trend v={r.trend} /> },
    { key: 'tests', header: 'Marks entered', align: 'right', sortValue: (r) => r.testsTaken, cell: (r) => <span className="ov-num">{r.testsTaken}</span> },
    { key: 'flag', header: 'Needs attention', cell: (r) => (r.percent === null
      ? (r.students > 0 ? <StatusPill tone="neutral">Not assessed</StatusPill> : null)
      : r.percent < PASS ? <StatusPill tone="bad">Below pass</StatusPill>
        : (r.trend ?? 0) <= FALL ? <StatusPill tone="warn">Falling</StatusPill> : null) },
  ];

  return (
    <>
      <div className="ov-mini-kpis">
        <MiniKpi label="School average" value={rows ? (avg === null ? '—' : `${avg}%`) : undefined} tone={avg !== null && avg < PASS ? 'is-bad' : ''} />
        <MiniKpi label="Classes below pass" value={rows ? String(below) : undefined} tone={below ? 'is-bad' : ''} />
        <MiniKpi label="Classes falling 10+ pts" value={rows ? String(falling) : undefined} tone={falling ? 'is-warn' : ''} />
        <MiniKpi label="Classes not assessed" value={rows ? String(untested) : undefined} />
      </div>
      <DataTable<ClassPerformance>
        caption="Class performance" noun="classes" columns={columns} rows={rows ?? []} rowKey={(r) => r.classId}
        loading={!rows} onRowClick={(r) => onPickClass(r.classId)} rowLabel={(r) => `Open ${r.className}`}
        initialSort={{ key: 'avg', dir: 'asc' }}
        empty={<EmptyState title="No classes in this scope">Choose another campus.</EmptyState>}
      />
      <p className="ov-sub" style={{ margin: 0 }}>Worst first. Click a class to see its students, top performers and who is at risk.</p>
    </>
  );
}

function ClassView({ classId, sectionId, range, onOpenStudent }: {
  classId: string; sectionId: string | null; range: PerformanceRange; onOpenStudent: (id: string) => void;
}) {
  const [data, setData] = useState<{ name: string; rows: StudentRow[] } | null>(null);
  useEffect(() => {
    let alive = true;
    setData(null);
    Promise.all([
      api.performance.byStudent(classId, range, sectionId ?? undefined),
      // Attendance rides from the directory rows (one page of ≤100 covers a class).
      apiGet<Paged<Student>>(`/students?classId=${classId}${sectionId ? `&sectionId=${sectionId}` : ''}&status=ACTIVE&pageSize=100`).catch(() => null),
    ]).then(([perf, dir]) => {
      if (!alive) return;
      const att = new Map((dir?.data ?? []).map((s) => [s.id, s.attendancePercent ?? null]));
      setData({
        name: perf.className,
        rows: perf.students.map((s) => {
          const attendancePercent = att.get(s.studentId) ?? null;
          const risks: string[] = [];
          if (s.percent !== null && s.percent < PASS) risks.push('Below pass');
          if ((s.trend ?? 0) <= FALL) risks.push(`Down ${Math.abs(s.trend!)} pts`);
          if (attendancePercent !== null && attendancePercent < ATTENDANCE_FLOOR) risks.push(`Attendance ${attendancePercent}%`);
          return { ...s, attendancePercent, risks };
        }),
      });
    }).catch(() => { if (alive) setData({ name: '', rows: [] }); });
    return () => { alive = false; };
  }, [classId, sectionId, range]);

  const rows = data?.rows ?? [];
  const tested = rows.filter((r) => r.percent !== null);
  const obtained = tested.reduce((a, r) => a + r.marksObtained, 0);
  const total = tested.reduce((a, r) => a + r.marksTotal, 0);
  const avg = total > 0 ? Math.round((obtained / total) * 100) : null;
  const atRisk = rows.filter((r) => r.risks.length > 0);
  const top = [...tested].sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0)).slice(0, 5);
  const bandCounts = BANDS.map((b, i) => ({
    ...b, count: tested.filter((r) => (r.percent ?? 0) >= b.min && (i === 0 || (r.percent ?? 0) < BANDS[i - 1]!.min)).length,
  }));
  const maxBand = Math.max(1, ...bandCounts.map((b) => b.count));

  const columns: Column<StudentRow>[] = [
    { key: 'name', header: 'Student', pinned: true, sortValue: (r) => r.fullName, cell: (r) => (
      <span className="ov-person-text"><strong>{r.fullName}</strong><span className="ov-sub">{r.grNumber}</span></span>
    ) },
    { key: 'avg', header: 'Average', align: 'right', sortValue: (r) => r.percent, cell: (r) => <Pct v={r.percent} /> },
    { key: 'trend', header: 'Trend', align: 'right', sortValue: (r) => r.trend, cell: (r) => <Trend v={r.trend} /> },
    { key: 'weak', header: 'Weakest subject', sortValue: (r) => r.weakestSubject?.percent ?? null, cell: (r) => (r.weakestSubject
      ? <span>{r.weakestSubject.name} <span className="ov-sub">{r.weakestSubject.percent}%</span></span> : <span className="ov-muted">—</span>) },
    { key: 'att', header: 'Attendance', align: 'right', sortValue: (r) => r.attendancePercent, cell: (r) => (r.attendancePercent === null
      ? <span className="ov-muted">—</span>
      : <span className={`ov-num ${r.attendancePercent < ATTENDANCE_FLOOR ? 'is-bad' : ''}`}>{r.attendancePercent}%</span>) },
    { key: 'risk', header: 'At risk', sortValue: (r) => r.risks.length || null, cell: (r) => (r.risks.length
      ? <span className="ov-pills">{r.risks.map((x) => <StatusPill key={x} tone="bad">{x}</StatusPill>)}</span> : null) },
  ];

  return (
    <>
      <div className="ov-mini-kpis">
        <MiniKpi label={`${data?.name || 'Class'} average`} value={data ? (avg === null ? '—' : `${avg}%`) : undefined} tone={avg !== null && avg < PASS ? 'is-bad' : ''} />
        <MiniKpi label="Students at risk" value={data ? String(atRisk.length) : undefined} tone={atRisk.length ? 'is-bad' : ''} />
        <MiniKpi label="Tested" value={data ? `${tested.length} of ${rows.length}` : undefined} />
      </div>

      {data && tested.length > 0 && (
        <div className="ov-panels">
          <section className="ov-panel">
            <h3 className="ov-h3">Grade distribution</h3>
            <ul className="ov-bars">
              {bandCounts.map((b) => (
                <li key={b.label}>
                  <span>{b.label} <span className="ov-sub">{b.label === 'F' ? `< ${PASS}%` : `${b.min}%+`}</span></span>
                  <span className="ov-bar"><span className={`ov-bar-fill ${b.tone}`} style={{ width: `${(b.count / maxBand) * 100}%` }} /></span>
                  <span className="ov-num">{b.count}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="ov-panel">
            <h3 className="ov-h3">Top 5</h3>
            <ol className="ov-rank">
              {top.map((r) => (
                <li key={r.studentId}>
                  {/* GR beside the name: two children in one class can share a name. */}
                  <button type="button" className="ov-link" onClick={() => onOpenStudent(r.studentId)}>{r.fullName}</button>
                  {' '}<span className="ov-sub">{r.grNumber}</span>
                  <Pct v={r.percent} />
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}

      <DataTable<StudentRow>
        caption="Student performance" noun="students" columns={columns} rows={rows} rowKey={(r) => r.studentId}
        loading={!data} onRowClick={(r) => onOpenStudent(r.studentId)} rowLabel={(r) => `Open ${r.fullName}`}
        initialSort={{ key: 'avg', dir: 'asc' }}
        empty={<EmptyState title="No students in this class">Choose another class or section.</EmptyState>}
      />
      <p className="ov-sub" style={{ margin: 0 }}>
        At risk = below {PASS}%, down {Math.abs(FALL)}+ points on the previous period, or attendance under {ATTENDANCE_FLOOR}%.
      </p>
    </>
  );
}

function MiniKpi({ label, value, tone = '' }: { label: string; value: string | undefined; tone?: string }) {
  return (
    <div className="ov-mini">
      <span className="ov-kpi-label">{label}</span>
      {value === undefined ? <span className="ov-skel ov-kpi-skel" aria-label="Loading" /> : <span className={`ov-mini-value ${tone}`}>{value}</span>}
    </div>
  );
}
