'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api, type StaffHistory } from '@/lib/api';
import { attendanceBadge, humanizeStatus } from '@/lib/format';
import { RANGE_OPTIONS, rangeQuery, type RangeKey } from '@/lib/date-ranges';

const time = (t: string | null) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
const MARKED_BY: Record<string, string> = { SELF: 'Self', ADMIN: 'Office', SYSTEM: 'Auto' };

/**
 * One staff member's attendance over any period, up to their whole employment.
 *
 * The absences are grouped by month rather than listed flat, because the question a director
 * actually asks is "is this getting worse?" — not "what happened on the 4th?". A flat list of
 * forty dates answers the second question and hides the first.
 */
export default function StaffAttendanceHistory() {
  const params = useParams();
  const staffId = String(params?.staffId ?? '');
  const [range, setRange] = useState<RangeKey>('3m');
  const [data, setData] = useState<StaffHistory | null>(null);
  const [err, setErr] = useState(false);

  const load = useCallback(async () => {
    setData(await api.staffAttendance.history(staffId, range === 'all' ? '' : rangeQuery(range)));
  }, [staffId, range]);

  useEffect(() => { setData(null); load().catch(() => setErr(true)); }, [load]);

  if (err) return <p className="error">Couldn&apos;t load this person&apos;s attendance.</p>;

  const absences = (data?.rows ?? []).filter((r) => r.status === 'ABSENT');
  const byMonth = new Map<string, number>();
  for (const a of absences) {
    const key = a.date.slice(0, 7);
    byMonth.set(key, (byMonth.get(key) ?? 0) + 1);
  }
  const monthLabel = (ym: string) =>
    new Date(`${ym}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

  return (
    <div className="stack">
      <div className="row">
        <div className="stack" style={{ gap: 2 }}>
          <h1 style={{ marginBottom: 0 }}>{data?.staff.name ?? 'Staff attendance'}</h1>
          {data && (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {data.staff.staffType} · {data.staff.employeeCode}
              {data.staff.campus ? ` · ${data.staff.campus}` : ''} · joined {data.staff.joinedAt}
            </p>
          )}
        </div>
        <Link className="ghost small" href="/staff-attendance">← Staff register</Link>
      </div>

      <div className="chips">
        {RANGE_OPTIONS.map((o) => (
          <button key={o.key} type="button" className={`chip${range === o.key ? ' active' : ''}`}
            onClick={() => setRange(o.key)}>
            {o.label}
          </button>
        ))}
      </div>

      {!data ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="grid">
            <div className="metric">
              <div className="value">{data.percent == null ? '—' : `${data.percent}%`}</div>
              <div className="label">Attendance</div>
            </div>
            <div className="metric"><div className="value">{data.present + data.late}</div><div className="label">Days present</div></div>
            <div className={`metric${data.absent > 0 ? ' metric-alert' : ''}`}>
              <div className="value">{data.absent}</div><div className="label">Days absent</div>
            </div>
            <div className="metric"><div className="value">{data.onLeave}</div><div className="label">On leave</div></div>
          </div>

          {byMonth.size > 0 && (
            <div className="card stack">
              <h2 style={{ margin: 0, fontSize: 17 }}>Absences by month</h2>
              <div className="chips">
                {[...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([ym, n]) => (
                  <span key={ym} className="badge warn">{monthLabel(ym)} · {n}</span>
                ))}
              </div>
            </div>
          )}

          <div className="card stack">
            <div className="row">
              <h2 style={{ margin: 0, fontSize: 17 }}>Records</h2>
              <span className="muted" style={{ fontSize: 12 }}>{data.from} → {data.to}</span>
            </div>
            <table>
              <thead><tr><th>Date</th><th>Status</th><th>Check-in</th><th>Marked by</th><th>Note</th></tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td>{new Date(r.date).toLocaleDateString()}</td>
                    <td><span className={`badge ${attendanceBadge(r.status)}`}>{humanizeStatus(r.status)}</span></td>
                    <td>{time(r.checkIn)}</td>
                    <td className="muted">{MARKED_BY[r.source] ?? r.source}</td>
                    <td className="muted">{r.note ?? '—'}</td>
                  </tr>
                ))}
                {data.rows.length === 0 && (
                  <tr><td colSpan={5} className="muted">Nothing recorded in this period.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
