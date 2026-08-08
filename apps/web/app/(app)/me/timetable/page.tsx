'use client';

import { useEffect, useState } from 'react';
import { api, type MyTimetable } from '@/lib/api';
import { DAY_NAMES, DAY_SHORT, byCell, gridShape, teacherLabel, todayDow } from '@/lib/timetable';

/**
 * A student's week (§28 portal).
 *
 * A reference version of this page survived on the abandoned `latestcode` branch and was the only
 * reason that branch was still alive; it could not simply be copied, because the endpoint, the
 * client method and the type it called all belonged to an architecture that no longer exists. The
 * shape it got right — periods down, days across — is kept.
 *
 * Read once a term, not daily, so the week is the whole page and today is merely highlighted.
 * The same `@/lib/timetable` helpers as the teacher and admin views: a week that starts on Monday
 * in one screen and Sunday in another is a bug, and one definition is how it stays fixed.
 */
export default function MyTimetable() {
  const [data, setData] = useState<MyTimetable | null>(null);

  useEffect(() => { api.timetable.mine().then(setData).catch(() => setData({ as: 'NONE', academicYearId: '', slots: [] })); }, []);

  if (!data) return <p className="muted">Loading…</p>;

  const dow = todayDow();
  const cells = byCell(data.slots);
  const { days, periods } = gridShape(data.slots, { minDays: 0, minPeriods: 0 });

  if (!data.slots.length) {
    return (
      <div className="stack">
        <h1>My Timetable</h1>
        <p className="muted">No timetable published for your class yet.</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <h1>My Timetable</h1>
      <p className="muted" style={{ margin: 0 }}>Today is {DAY_NAMES[dow]}.</p>
      <div className="card" style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr><th style={{ width: 70 }}>Period</th>{days.map((d) => (
              <th key={d} style={d === dow ? { color: 'var(--brand)' } : undefined}>{DAY_SHORT[d]}</th>
            ))}</tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p}>
                <td><strong>{p}</strong></td>
                {days.map((d) => {
                  const slot = cells.get(`${d}:${p}`);
                  return (
                    <td key={d} style={{ verticalAlign: 'top', minWidth: 130 }}>
                      {slot ? (
                        <div className="stack" style={{ gap: 1 }}>
                          <strong style={{ fontSize: 13 }}>{slot.subject.name}</strong>
                          <span className="muted" style={{ fontSize: 12 }}>{teacherLabel(slot)}</span>
                          {slot.room && <span className="muted" style={{ fontSize: 12 }}>{slot.room}</span>}
                        </div>
                      ) : <span className="muted">—</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
