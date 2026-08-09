'use client';

import { useEffect, useState } from 'react';
import { api, type MyTimetable } from '@/lib/api';
import { DAY_NAMES, DAY_SHORT, byCell, gridShape, sectionLabel, todayDow } from '@/lib/timetable';
import { useIsPhone } from '@/lib/use-phone';

/**
 * A teacher's own week — **today first**.
 *
 * This is the surface with a daily user, and it decided the shape: a teacher opening this at 7:50
 * wants "where am I now, and where next", not a wall of seven columns to scan. So today's periods
 * are a list at the top, in order, and the full week sits underneath for the once-a-term question
 * of what Thursday looks like.
 *
 * Self-scoped on the server — the request carries no id, so there is nothing to widen.
 */
export default function MyTimetablePage() {
  const [data, setData] = useState<MyTimetable | null>(null);
  const [err, setErr] = useState(false);
  // A week IS a grid, so the desktop keeps one. Six columns on a 375px screen either scroll
  // sideways or shrink past reading, and this is the one place where the right answer needs
  // different markup rather than different CSS.
  const isPhone = useIsPhone();
  const [pickedDay, setPickedDay] = useState<number | null>(null);

  useEffect(() => { api.timetable.mine().then(setData).catch(() => setErr(true)); }, []);

  if (err) return <p className="error">Couldn&apos;t load your timetable.</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const dow = todayDow();
  const today = data.slots.filter((s) => s.dayOfWeek === dow).sort((a, b) => a.periodNo - b.periodNo);
  const cells = byCell(data.slots);
  const { days, periods } = gridShape(data.slots, { minDays: 0, minPeriods: 0 });

  if (!data.slots.length) {
    return (
      <div className="stack">
        <h1>My Timetable</h1>
        {/* An empty week is almost always "the office hasn't built it yet" rather than "you teach
            nothing" — saying so stops it reading as a fault. */}
        <p className="muted">
          You have no periods on the timetable yet. If that looks wrong, the office builds it under
          Timetable.
        </p>
      </div>
    );
  }

  return (
    <div className="stack">
      <h1>My Timetable</h1>

      <div className="card stack" style={{ gap: 8 }}>
        <div className="section-title" style={{ margin: 0 }}>Today — {DAY_NAMES[dow]}</div>
        {today.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Nothing scheduled for you today.</p>
        ) : (
          <table>
            <thead><tr><th style={{ width: 70 }}>Period</th><th>Class</th><th>Subject</th><th>Room</th></tr></thead>
            <tbody>
              {today.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.periodNo}</strong></td>
                  <td>{sectionLabel(s)}</td>
                  <td>{s.subject.name}</td>
                  <td className="muted">{s.room ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {isPhone ? (
        /* One day at a time, chosen with a chip. Defaults to today, which is what someone
           checking their phone almost always wants — the other days are one tap away. */
        (() => {
          // Default to today — unless today has no periods, in which case fall to the first day
          // that does. Landing on an empty Sunday, with no Sunday chip to explain why, reads as
          // a broken timetable rather than as a day off.
          const day = pickedDay ?? (days.includes(dow) && today.length ? dow : days[0] ?? dow);
          const forDay = data.slots.filter((s) => s.dayOfWeek === day).sort((a, b) => a.periodNo - b.periodNo);
          return (
            <div className="card stack" style={{ gap: 10 }}>
              <div className="section-title" style={{ margin: 0 }}>The whole week</div>
              <div className="day-chips" role="tablist" aria-label="Day of the week">
                {days.map((d) => (
                  <button
                    key={d}
                    role="tab"
                    aria-selected={d === day}
                    className={`chip${d === day ? ' active' : ''}`}
                    onClick={() => setPickedDay(d)}
                  >
                    {DAY_SHORT[d]}
                  </button>
                ))}
              </div>
              {forDay.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>Nothing scheduled on {DAY_NAMES[day]}.</p>
              ) : (
                <ul className="day-rail">
                  {forDay.map((s) => (
                    <li key={s.id}>
                      <span className="p">P{s.periodNo}</span>
                      <span>
                        <span className="what">{sectionLabel(s)} · {s.subject.name}</span>
                        {s.room && <><br /><span className="where">{s.room}</span></>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })()
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <div className="section-title">The whole week</div>
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
                            <strong style={{ fontSize: 13 }}>{sectionLabel(slot)}</strong>
                            <span className="muted" style={{ fontSize: 12 }}>{slot.subject.name}</span>
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
