'use client';

import { useEffect, useRef, useState } from 'react';
import { api, type AttendanceOverview, type AttendanceOverviewCell, type AttendanceOverviewSection } from '@sw/api-client';
import { EmptyState, KpiStrip, ScopeBar, StatusPill, useScope, type KpiTileSpec } from '@school/components/oversight';

/**
 * The owner's attendance overview (Owner UX Remediation Plan, Phase 1c — issues 1, 3).
 *
 * Oversight, not operation: the owner never marks. The page answers, in order,
 *  1. how is today going?            → KPI strip
 *  2. where must I act, and who?     → needs attention: unmarked registers (teacher named), children
 *                                      absent 3+ days running, sections under the threshold
 *  3. what is the pattern?           → sections × last 14 days heatmap; a cell opens that register
 */

const n = (v: number) => v.toLocaleString('en-US');
const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayNum = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDate();
const dayInitial = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'narrow', timeZone: 'UTC' });

/** One colour language: green ≥ 90, amber 75–89, red < 75; grey = closed; outlined = not marked. */
function band(c: AttendanceOverviewCell, today: string): { cls: string; text: string } {
  if (c.closed) return { cls: 'is-closed', text: 'closed' };
  if (c.marked === 0) return { cls: c.date === today ? 'is-pending' : 'is-missing', text: c.date === today ? 'not marked yet' : 'not marked' };
  const p = c.percent ?? 0;
  return { cls: p >= 90 ? 'is-good' : p >= 75 ? 'is-mid' : 'is-low', text: `${p}% present` };
}

export function AttendanceOverviewPanel({ onOpenRegister }: { onOpenRegister: (sectionId: string, date: string) => void }) {
  const scopeState = useScope();
  const { scope } = scopeState;
  const [data, setData] = useState<AttendanceOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const attentionRef = useRef<HTMLDivElement>(null);
  const scopeKey = `${scope.campusId}|${scope.classId}|${scope.sectionId}`;

  useEffect(() => {
    let alive = true;
    setData(null); setFailed(false);
    api.staff.attendanceOverview(scope).then((d) => { if (alive) setData(d); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const t = data?.today;
  const unmarked = (data?.sections ?? []).filter((s) => !s.today.closed && s.today.marked < s.expected);
  const below = (data?.sections ?? []).filter((s) => data?.belowThreshold.includes(s.sectionId));
  const toAttention = () => attentionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const tiles: KpiTileSpec[] = [
    { key: 'present', label: 'Students present today', icon: 'check-circle', tone: 'ok',
      value: !t ? undefined : !t.open ? 'Closed' : t.percent === null ? '—' : `${t.percent}%`,
      sub: !t ? undefined : !t.open ? 'No school today' : t.marked === 0 ? 'No register marked yet' : `${n(t.present)} of ${n(t.marked)} marked`,
      hint: 'Present, late or half-day, out of the students marked so far today' },
    { key: 'absent', label: 'Absent', icon: 'x-circle', tone: t && t.absent > 0 ? 'bad' : 'neutral', value: t ? n(t.absent) : undefined,
      onClick: () => { window.location.href = '/students?show=ABSENT'; }, hint: 'Open the absent students in the Students hub' },
    { key: 'leave', label: 'On leave', icon: 'leave', tone: 'info', value: t ? n(t.onLeave) : undefined,
      onClick: () => { window.location.href = '/students?show=ON_LEAVE'; }, hint: 'Open the students on leave in the Students hub' },
    { key: 'late', label: 'Late', icon: 'timetable', tone: t && t.late > 0 ? 'warn' : 'neutral', value: t ? n(t.late) : undefined, hint: 'Arrived after the bell (counted as present)' },
    { key: 'unmarked', label: 'Classes that haven’t taken attendance', icon: 'attendance',
      tone: t && t.registersUnmarked > 0 ? (data?.due ? 'bad' : 'warn') : 'ok',
      value: t ? (t.open ? `${n(t.registersUnmarked)} of ${n(t.registers)}` : '—') : undefined,
      sub: data ? (t?.open ? (data.due ? `Due by ${data.markByTime} — overdue` : `Due by ${data.markByTime}`) : undefined) : undefined,
      onClick: toAttention, hint: 'See which registers, and who is responsible' },
    { key: 'chronic', label: 'Students absent 3+ days', icon: 'alert', tone: data && data.chronic.length > 0 ? 'bad' : 'neutral',
      value: data ? n(data.chronic.length) : undefined, sub: 'in a row, without leave', onClick: toAttention, hint: 'Children absent three or more school days running' },
  ];

  if (failed) return <EmptyState title="Couldn’t load the attendance overview">Refresh the page to try again.</EmptyState>;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <KpiStrip label="Student attendance today" tiles={tiles} />
      <ScopeBar state={scopeState} />

      <div ref={attentionRef} className="ov-panels" style={{ scrollMarginTop: 16 }}>
        <section className="ov-panel ov-card" aria-labelledby="att-unmarked">
          <h2 id="att-unmarked" className="ov-h3">Classes that haven’t taken attendance today {data && <span className="ov-sub">· {unmarked.length}</span>}</h2>
          {!data ? <span className="ov-skel" style={{ height: 80, display: 'block' }} /> : !t?.open ? (
            <p className="ov-sub" style={{ margin: 0 }}>No school today — nothing to mark.</p>
          ) : unmarked.length === 0 ? (
            <p className="ov-ok-line">Every register is marked.</p>
          ) : (
            <ul className="ov-attn">
              {unmarked.map((s) => (
                <li key={s.sectionId}>
                  <button type="button" className="ov-attn-row" onClick={() => onOpenRegister(s.sectionId, data.date)}>
                    <span className="ov-person-text">
                      <strong>{s.className} — {s.sectionName}</strong>
                      <span className="ov-sub">
                        {s.coveredBy ? <>Cover: {s.coveredBy}</> : s.teacher ? <>Class teacher: {s.teacher}</> : <span className="ov-warn-text">No class teacher assigned</span>}
                      </span>
                    </span>
                    <StatusPill tone={s.today.marked > 0 ? 'warn' : data.due ? 'bad' : 'neutral'}>
                      {s.today.marked > 0 ? `${s.today.marked} of ${s.expected} marked` : data.due ? 'Overdue' : 'Not yet'}
                    </StatusPill>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="ov-panel ov-card" aria-labelledby="att-chronic">
          <h2 id="att-chronic" className="ov-h3">Absent 3+ days in a row {data && <span className="ov-sub">· {data.chronic.length}</span>}</h2>
          {!data ? <span className="ov-skel" style={{ height: 80, display: 'block' }} /> : data.chronic.length === 0 ? (
            <p className="ov-ok-line">No child has missed three school days running.</p>
          ) : (
            <ul className="ov-attn">
              {data.chronic.slice(0, 8).map((c) => (
                <li key={c.studentId}>
                  <button type="button" className="ov-attn-row" onClick={() => onOpenRegister(c.sectionId, data.date)}>
                    <span className="ov-person-text">
                      <strong>{c.fullName}</strong>
                      <span className="ov-sub">{c.grNumber} · {c.className} — {c.sectionName} · since {dayLabel(c.since)}</span>
                    </span>
                    <StatusPill tone="bad">{c.days} days</StatusPill>
                  </button>
                </li>
              ))}
              {data.chronic.length > 8 && <li className="ov-sub">and {data.chronic.length - 8} more</li>}
            </ul>
          )}
        </section>

        <section className="ov-panel ov-card" aria-labelledby="att-below">
          <h2 id="att-below" className="ov-h3">Below {data?.threshold ?? 85}% over {data?.days.length ?? 14} days {data && <span className="ov-sub">· {below.length}</span>}</h2>
          {!data ? <span className="ov-skel" style={{ height: 80, display: 'block' }} /> : below.length === 0 ? (
            <p className="ov-ok-line">Every section is at or above {data.threshold}%.</p>
          ) : (
            <ul className="ov-attn">
              {below.sort((a, b) => (a.periodPercent ?? 0) - (b.periodPercent ?? 0)).map((s) => (
                <li key={s.sectionId}>
                  <button type="button" className="ov-attn-row" onClick={() => onOpenRegister(s.sectionId, data.date)}>
                    <span className="ov-person-text"><strong>{s.className} — {s.sectionName}</strong><span className="ov-sub">{s.teacher ?? 'No class teacher'}</span></span>
                    <StatusPill tone="bad">{s.periodPercent}%</StatusPill>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <Heatmap data={data} onOpen={onOpenRegister} />
    </div>
  );
}

function Heatmap({ data, onOpen }: { data: AttendanceOverview | null; onOpen: (sectionId: string, date: string) => void }) {
  if (!data) return <div className="ov-card"><span className="ov-skel" style={{ height: 220, display: 'block' }} /></div>;
  if (data.sections.length === 0) return <div className="ov-card"><EmptyState title="No sections with students here">Choose another campus or class.</EmptyState></div>;
  const allCampuses = new Set(data.sections.map((s) => s.campusName)).size > 1;
  return (
    <section className="ov-card" aria-labelledby="att-heat">
      <div className="ov-heat-head">
        <h2 id="att-heat" className="ov-h3" style={{ margin: 0 }}>Last {data.days.length} days by section</h2>
        <ul className="ov-legend" aria-label="Legend">
          <li><span className="ov-heat-swatch is-good" />90%+</li>
          <li><span className="ov-heat-swatch is-mid" />75–89%</li>
          <li><span className="ov-heat-swatch is-low" />Under 75%</li>
          <li><span className="ov-heat-swatch is-good is-partial" />Partly marked</li>
          <li><span className="ov-heat-swatch is-missing" />Not marked</li>
          <li><span className="ov-heat-swatch is-closed" />Closed</li>
        </ul>
      </div>
      <p className="ov-sub" style={{ margin: '4px 0 10px' }}>Each square is one register. Click it to open that day’s register (read-only).</p>
      <div className="ov-heat-scroll">
        <table className="ov-heat">
          <thead>
            <tr>
              <th scope="col" className="ov-heat-name">Section</th>
              {data.days.map((d) => (
                <th key={d} scope="col" className={d === data.date ? 'is-today' : undefined} title={dayLabel(d)}>
                  <span className="ov-heat-dow">{dayInitial(d)}</span>{dayNum(d)}
                </th>
              ))}
              <th scope="col" className="ov-heat-avg">Avg</th>
            </tr>
          </thead>
          <tbody>
            {data.sections.map((s) => <HeatRow key={s.sectionId} s={s} today={data.date} allCampuses={allCampuses} onOpen={onOpen} />)}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function HeatRow({ s, today, allCampuses, onOpen }: { s: AttendanceOverviewSection; today: string; allCampuses: boolean; onOpen: (sectionId: string, date: string) => void }) {
  return (
    <tr>
      <th scope="row" className="ov-heat-name">
        <span className="ov-person-text">
          <strong>{s.className} — {s.sectionName}</strong>
          <span className="ov-sub">{allCampuses ? `${s.campusName} · ` : ''}{s.teacher ?? 'No class teacher'}</span>
        </span>
      </th>
      {s.cells.map((c) => {
        const b = band(c, today);
        const label = `${s.className} ${s.sectionName}, ${dayLabel(c.date)}: ${c.closed ? `closed (${c.closed})` : c.marked === 0 ? b.text : `${c.percent}% present, ${c.marked} of ${c.expected} marked`}`;
        return (
          <td key={c.date} className={c.date === today ? 'is-today' : undefined}>
            {c.closed ? (
              <span className={`ov-heat-cell ${b.cls}`} title={label} aria-label={label} role="img" />
            ) : (
              <button type="button" className={`ov-heat-cell ${b.cls}${c.marked > 0 && c.marked < c.expected ? ' is-partial' : ''}`}
                title={label} aria-label={label} onClick={() => onOpen(s.sectionId, c.date)} />
            )}
          </td>
        );
      })}
      <td className="ov-heat-avg">{s.periodPercent === null ? <span className="ov-muted">—</span>
        : <span className={`ov-num ${s.periodPercent < 75 ? 'is-bad' : s.periodPercent < 90 ? 'is-warn' : ''}`}>{s.periodPercent}%</span>}</td>
    </tr>
  );
}
