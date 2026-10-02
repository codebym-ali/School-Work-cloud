'use client';

import { useEffect, useState } from 'react';
import { api, type PortalAttendanceSummary } from '@sw/api-client';
import { Metric, MetricFilter } from '@/components/metric';
import { attendanceBadge, humanizeStatus } from '@sw/ui';

/**
 * My Attendance — the counts first, the day list second.
 *
 * "How many days was I absent?" is the actual question, and it was previously answerable only by
 * counting 60 rows by hand. The percentage uses the same shared helper as the teacher, staff and
 * SMS paths, so one student never has two different figures depending on the screen.
 */
export default function MyAttendance() {
  const [focus, setFocus] = useState('');
  const [data, setData] = useState<PortalAttendanceSummary | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => { api.portal.attendanceSummary().then(setData).catch(() => setErr(true)); }, []);

  if (err) return <p className="error">Couldn&apos;t load your attendance.</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const c = data.counts;
  /**
   * ⚠️ The status key is carried on the card, so the count and the filter are the same key rather
   * than a label matched to a status by eye. One row per status, so a student sees exactly the
   * behaviour a teacher gets on `/my-attendance`.
   */
  const cards: Array<{ label: string; value: number; status: string }> = [
    { label: 'Present', value: c.PRESENT ?? 0, status: 'PRESENT' },
    { label: 'Absent', value: c.ABSENT ?? 0, status: 'ABSENT' },
    { label: 'Late', value: c.LATE ?? 0, status: 'LATE' },
    { label: 'Half day', value: c.HALF_DAY ?? 0, status: 'HALF_DAY' },
    { label: 'On leave', value: c.ON_LEAVE ?? 0, status: 'ON_LEAVE' },
  ];
  const visible = data.records.filter((r) => !focus || r.status === focus);

  return (
    <div className="stack">
      <h1>My Attendance</h1>

      <div className="grid">
        <Metric label={`Attendance (last ${data.days} days)`}
          value={data.percent == null ? '—' : `${data.percent}%`} />
        {cards.map((k) => (
          <MetricFilter key={k.status} label={k.label} value={k.value}
            alert={k.status === 'ABSENT' && k.value > 0}
            active={focus === k.status}
            onClick={() => setFocus(focus === k.status ? '' : k.status)} />
        ))}
      </div>

      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Present and late count as a full day, half day as half. Approved leave isn&apos;t counted against you.
      </p>

      <div style={{ overflowX: 'auto' }}>
        <table className="stacked">
          <thead><tr><th>Date</th><th>Session</th><th>Status</th></tr></thead>
          <tbody>
            {visible.map((r, i) => (
              <tr key={i}>
                <td data-label="Date">{new Date(r.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</td>
                <td data-label="Session">{humanizeStatus(r.session)}</td>
                <td data-label="Status"><span className={`badge ${attendanceBadge(r.status)}`}>{humanizeStatus(r.status)}</span></td>
              </tr>
            ))}
            {visible.length === 0 && <tr><td colSpan={3} className="muted">
              {focus ? 'No days with that status in this period.' : 'No attendance recorded in this period.'}
            </td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
