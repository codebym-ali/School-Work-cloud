'use client';

import { useEffect, useState } from 'react';
import { api, type MyTimetable } from '@sw/api-client';
import { DAY_NAMES, DAY_SHORT, byCell, gridShape, teacherLabel, todayDow } from '@sw/ui';

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
/** A phone shows one day at a time: six columns either scroll sideways or shrink past reading. */
function useIsPhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const m = window.matchMedia('(max-width: 720px)');
    const apply = () => setPhone(m.matches);
    apply();
    m.addEventListener('change', apply);
    return () => m.removeEventListener('change', apply);
  }, []);
  return phone;
}

export default function MyTimetable() {
  const [data, setData] = useState<MyTimetable | null>(null);
  const [pickedDay, setPickedDay] = useState<number | null>(null);
  const phone = useIsPhone();

  useEffect(() => { api.timetable.mine().then(setData).catch(() => setData({ as: 'NONE', academicYearId: '', slots: [] })); }, []);

  if (!data) return <p className="muted">Loading…</p>;

  const dow = todayDow();
  const cells = byCell(data.slots);
  const { days, periods } = gridShape(data.slots, { minDays: 0, minPeriods: 0 });
  const activeDay = pickedDay ?? (days.includes(dow) ? dow : days[0]);

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
      {phone ? (
        <>
          <div className="day-chips" role="group" aria-label="Day of the week">
            {days.map((d) => (
              <button key={d} type="button" className={`chip${d === activeDay ? ' active' : ''}`} aria-pressed={d === activeDay} onClick={() => setPickedDay(d)}>
                {DAY_SHORT[d]}{d === dow ? ' · today' : ''}
              </button>
            ))}
          </div>
          <div className="card">
            <ul className="day-rail">
              {periods.map((p) => {
                const slot = cells.get(`${activeDay}:${p}`);
                return (
                  <li key={p}>
                    <span className="p">P{p}</span>
                    <div>
                      {slot ? (
                        <>
                          <div className="what"><strong>{slot.subject.name}</strong></div>
                          <div className="where">
                            {[slot.startTime ? `${slot.startTime}–${slot.endTime}` : null, teacherLabel(slot), slot.room].filter(Boolean).join(' · ')}
                          </div>
                        </>
                      ) : <span className="muted">Free</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      ) : (
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
                          {/* When, before what — a student reading their week is placing the
                              lesson in the day. Absent until the school sets its timings. */}
                          {slot.startTime && (
                            <span className="muted" style={{ fontSize: 11 }}>{slot.startTime}–{slot.endTime}</span>
                          )}
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
      )}
    </div>
  );
}
