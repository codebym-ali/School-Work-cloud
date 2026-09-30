'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type AttendanceRegisterView, type AttendanceStatus, type UnmarkedRegisters } from '@sw/api-client';
import { EmptyState, StatusPill, type Tone } from '@school/components/oversight';

const shift = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const longDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const shortDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });

/**
 * Section + date, aligned on one baseline for every viewer.
 *
 * ⚠️ The weekday used to hang UNDER the date box, which made the Date block taller than the Section block, so
 * with bottom alignment the two labels sat at different heights. It now sits beside the controls. The
 * `<label>` stays directly before its `<select>` — the browser tests find the picker that way.
 */
export function RegisterFilters({ options, sectionId, onSection, date, onDate, min, max, today, children }: {
  options: Array<{ id: string; label: string }>;
  sectionId: string; onSection: (id: string) => void;
  date: string; onDate: (iso: string) => void;
  min?: string; max: string; today: string;
  children?: ReactNode;
}) {
  const canPrev = !min || shift(date, -1) >= min;
  const canNext = shift(date, 1) <= max;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 20px', alignItems: 'flex-end' }}>
      <div style={{ flex: '1 1 220px', maxWidth: 340, minWidth: 0 }}>
        <label htmlFor="att-section">Section</label>
        <select id="att-section" aria-label="Section" value={sectionId} onChange={(e) => onSection(e.target.value)} style={{ width: '100%' }}>
          <option value="">Choose a section…</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="att-date">Date</label>
        <div className="date-field-row">
          <button type="button" className="date-step" aria-label="Previous day" disabled={!canPrev} onClick={() => onDate(shift(date, -1))}>‹</button>
          <input id="att-date" type="date" value={date} min={min} max={max} onChange={(e) => e.target.value && onDate(e.target.value)} />
          <button type="button" className="date-step" aria-label="Next day" disabled={!canNext} onClick={() => onDate(shift(date, 1))}>›</button>
        </div>
      </div>
      <span className="ov-sub" style={{ paddingBottom: 10, fontWeight: 600 }}>
        {weekday(date)}{date === today ? ' · Today' : ''}
        {date !== today && <> · <button type="button" className="ov-link" onClick={() => onDate(today)}>Back to today</button></>}
      </span>
      {children}
    </div>
  );
}

/** Nothing chosen yet: say what the page is for and offer the registers that need a look — never a blank page. */
export function RegisterEmptyState({ readOnly, date, today, schoolWide, attention, loading, onPick }: {
  readOnly: boolean; date: string; today: string; schoolWide: boolean;
  attention: UnmarkedRegisters | null; loading: boolean; onPick: (sectionId: string) => void;
}) {
  const isToday = date === today;
  return (
    <div className="stack" style={{ gap: 14 }}>
      {isToday && attention?.closed ? (
        <EmptyState icon="attendance" title="School is closed today">
          {attention.closed} — there is no register to mark. You can still open a section to look at another day.
        </EmptyState>
      ) : isToday && attention && attention.sections.length === 0 ? (
        <EmptyState icon="check-circle" title="All registers are marked for today">
          Choose a section above to look at its register, or pick another day.
        </EmptyState>
      ) : (
        <EmptyState icon="attendance" title="Choose a section to see its register">
          {readOnly
            ? `Showing ${shortDay(date)}. You can look but not change marks — corrections go through the campus admin.`
            : `Pick a section, then mark ${shortDay(date)}.`}
        </EmptyState>
      )}
      {schoolWide && loading && <span className="ov-skel" style={{ height: 64, display: 'block' }} />}
      {isToday && attention && !attention.closed && attention.sections.length > 0 && (
        <section className="card stack" style={{ gap: 10 }}>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 15 }}>Needs attention today <span className="ov-sub">· {attention.sections.length}</span></h2>
            <span className={`badge ${attention.due ? 'bad' : ''}`}>{attention.due ? `Overdue — due by ${attention.markByTime}` : `Due by ${attention.markByTime}`}</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {attention.sections.map((u) => (
              <button key={u.sectionId} type="button" className="chip" onClick={() => onPick(u.sectionId)}>
                {u.className} {u.sectionName}
                {u.partial ? ` — ${u.marked}/${u.expected} done` : ' — not started'}
                {u.coveredBy ? ` · ${u.coveredBy} covering` : ''} →
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ── The read-only register ───────────────────────────────────────────────────

const STATUS_WORD: Record<AttendanceStatus, { word: string; tone: Tone }> = {
  PRESENT: { word: 'Present', tone: 'ok' },
  LATE: { word: 'Late', tone: 'warn' },
  HALF_DAY: { word: 'Half day', tone: 'warn' },
  ABSENT: { word: 'Absent', tone: 'bad' },
  ON_LEAVE: { word: 'On leave', tone: 'info' },
};
type Filter = 'ALL' | 'ABSENT' | 'LATE' | 'ON_LEAVE' | 'NOT_MARKED';
const recentTone = (p: number | null) => (p === null ? '' : p < 75 ? 'is-bad' : p < 85 ? 'is-warn' : 'is-ok');

export function ReadOnlyRegister({ sectionId, date, today, onDate }: { sectionId: string; date: string; today: string; onDate: (iso: string) => void }) {
  const [data, setData] = useState<AttendanceRegisterView | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [search, setSearch] = useState('');

  useEffect(() => {
    let alive = true;
    setData(null); setFailed(false); setFilter('ALL'); setSearch('');
    api.staff.attendanceRegister(sectionId, date).then((r) => { if (alive) setData(r); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [sectionId, date]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.students.filter((s) =>
      (filter === 'ALL' || (filter === 'NOT_MARKED' ? s.status === null : s.status === filter))
      && (!q || s.fullName.toLowerCase().includes(q) || s.grNumber.toLowerCase().includes(q)));
  }, [data, filter, search]);

  if (failed) return <p className="muted" style={{ margin: 0 }}>Could not load this register. Try again in a moment.</p>;
  if (!data) return <span className="ov-skel" style={{ height: 220, display: 'block' }} />;

  const { counts } = data;
  const untaken = data.marked === 0;
  const badge: { tone: Tone; text: string } = data.closed ? { tone: 'neutral', text: `School closed — ${data.closed}` }
    : data.marked >= data.expected && data.expected > 0 ? { tone: 'ok', text: 'Register complete' }
    : untaken ? { tone: data.overdue ? 'bad' : 'neutral', text: data.overdue ? 'Not taken — overdue' : 'Not taken yet' }
    : { tone: data.overdue ? 'bad' : 'warn', text: `${data.marked} of ${data.expected} marked${data.overdue ? ' — overdue' : ''}` };
  const who = data.teacher ? `Class teacher: ${data.teacher}` : 'No class teacher assigned';

  const chips: Array<{ key: Filter; label: string; n: number }> = [
    { key: 'ALL', label: 'All', n: data.students.length },
    { key: 'ABSENT', label: 'Absent', n: counts.absent },
    { key: 'LATE', label: 'Late', n: counts.late },
    { key: 'ON_LEAVE', label: 'On leave', n: counts.onLeave },
    { key: 'NOT_MARKED', label: 'Not marked', n: counts.notMarked },
  ];

  return (
    <div className="stack" style={{ gap: 16 }}>
      {/* This week: dot + head-count, so a day's state is readable without opening it. */}
      <div className="card stack" style={{ gap: 8 }}>
        <strong style={{ fontSize: 14 }}>Last 7 days</strong>
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 2 }}>
          {data.week.map((d) => {
            const sel = d.date === data.date;
            const complete = d.expected > 0 && d.marked >= d.expected;
            const colour = !d.working ? '#c6cedb' : complete ? '#2f8f5b' : d.marked > 0 ? '#c98a12' : d.date < today ? '#c0392b' : '#9aa6b8';
            const text = !d.working ? 'Closed' : `${d.marked}/${d.expected}`;
            return (
              <button key={d.date} type="button" disabled={!d.working} onClick={() => onDate(d.date)}
                title={!d.working ? d.closedFor ?? 'Weekly off' : complete ? `All ${d.expected} marked` : d.marked > 0 ? `Only ${d.marked} of ${d.expected} marked` : `Not taken (${d.expected} students)`}
                aria-pressed={sel}
                style={{ flex: '1 0 64px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '8px 6px', borderRadius: 10,
                  background: sel ? 'var(--brand)' : 'var(--card)', color: sel ? '#fff' : 'var(--ink)', border: `1px solid ${sel ? 'var(--brand)' : '#d9e0ea'}`, fontWeight: 600, fontSize: 13 }}>
                <span>{new Date(`${d.date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })} {Number(d.date.slice(8))}</span>
                <span aria-hidden style={{ width: 9, height: 9, borderRadius: '50%', background: colour, boxShadow: sel ? '0 0 0 2px #fff' : undefined }} />
                <span style={{ fontSize: 11, fontWeight: 500, opacity: sel ? 0.9 : 0.75, fontVariantNumeric: 'tabular-nums' }}>{text}</span>
              </button>
            );
          })}
        </div>
        <div className="ov-sub" style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {[['#2f8f5b', 'Complete'], ['#c98a12', 'Partly marked'], ['#c0392b', 'Not taken'], ['#c6cedb', 'Closed']].map(([c, w]) => (
            <span key={w} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: c }} />{w}</span>
          ))}
        </div>
      </div>

      <div className="card stack" style={{ gap: 14 }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>{data.section.className} — {data.section.sectionName}</h2>
            <p className="ov-sub" style={{ margin: '2px 0 0', fontSize: 13 }}>
              {data.section.campusName} · {longDay(data.date)} · {who}{data.coveredBy ? ` · covered by ${data.coveredBy}` : ''} · {data.expected} student{data.expected === 1 ? '' : 's'}
            </p>
          </div>
          <StatusPill tone={badge.tone}>{badge.text}</StatusPill>
        </div>

        {data.closed ? (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>The school is closed on this day, so there is no register. Pick another day above.</p>
        ) : untaken ? (
          <div className={`toast ${data.overdue ? 'err' : 'warn'}`} role="status">
            <strong>The register has not been taken.</strong>{' '}
            {data.overdue ? `It was due by ${data.markByTime}.` : `It is due by ${data.markByTime}.`}{' '}
            {data.coveredBy ? `${data.coveredBy} is covering today.` : data.teacher ? `${data.teacher} is the class teacher.` : 'No class teacher is assigned to this section.'}
          </div>
        ) : (
          <>
            <div className="ov-kpis" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(104px, 1fr))' }}>
              {[
                ['Present', counts.present + counts.halfDay, ''], ['Absent', counts.absent, counts.absent > 0 ? 'is-bad' : ''],
                ['Late', counts.late, counts.late > 0 ? 'is-warn' : ''], ['On leave', counts.onLeave, ''],
                ['Not marked', counts.notMarked, counts.notMarked > 0 ? 'is-warn' : ''],
              ].map(([label, n, tone]) => (
                <div key={label as string} className="ov-kpi">
                  <span className="ov-kpi-label">{label}</span>
                  <span className={`ov-num ${tone}`} style={{ fontSize: 24 }}>{n}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }} aria-label={`Attendance ${data.percent ?? 0} percent`}>
              <span className="ov-sub" style={{ flex: 'none' }}>Attendance</span>
              <span className="ov-bar" style={{ flex: 1 }}><span className={`ov-bar-fill ${recentTone(data.percent)}`} style={{ width: `${data.percent ?? 0}%` }} /></span>
              <span className="ov-num">{data.percent === null ? '—' : `${data.percent}%`}</span>
            </div>
          </>
        )}
      </div>

      {!data.closed && data.students.length > 0 && (
        <div className="ov-table-card">
          <div className="ov-toolbar">
            <div className="ov-toolbar-left" role="group" aria-label="Filter by status">
              {chips.map((c) => (
                <button key={c.key} type="button" className={`chip${filter === c.key ? ' active' : ''}`} aria-pressed={filter === c.key}
                  disabled={untaken && c.key !== 'ALL' && c.key !== 'NOT_MARKED'} onClick={() => setFilter(c.key)}>
                  {c.label} <span className="ov-sub" style={{ color: 'inherit', opacity: 0.8 }}>{c.n}</span>
                </button>
              ))}
            </div>
            <div className="ov-toolbar-right">
              <input type="search" aria-label="Search students" placeholder="Search name or GR…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 180 }} />
            </div>
          </div>
          <div className="ov-table-scroll">
            <table className="ov-table">
              <thead><tr><th>Roll</th><th>Student</th><th>{shortDay(data.date)}</th><th>Last 30 days</th></tr></thead>
              <tbody>
                {rows.map((s) => {
                  const st = s.status ? STATUS_WORD[s.status] : null;
                  return (
                    <tr key={s.enrollmentId}>
                      <td style={{ width: 52 }} className="ov-sub">{s.rollNumber ?? '—'}</td>
                      <td>
                        <strong style={{ fontWeight: 600 }}>{s.fullName}</strong>
                        <div className="ov-sub">{s.grNumber}</div>
                      </td>
                      <td>{st ? <StatusPill tone={st.tone}>{st.word}</StatusPill> : <span className="ov-sub">Not marked</span>}</td>
                      <td style={{ minWidth: 150 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className="ov-bar" style={{ width: 70, flex: 'none' }}><span className={`ov-bar-fill ${recentTone(s.recentPercent)}`} style={{ width: `${s.recentPercent ?? 0}%` }} /></span>
                          <span className="ov-num" style={{ fontSize: 13 }}>{s.recentPercent === null ? '—' : `${s.recentPercent}%`}</span>
                        </div>
                        {s.absentStreak >= 3 && <div className="ov-warn-text" style={{ fontSize: 12 }}>Absent {s.absentStreak} days running</div>}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={4} className="muted">No students match{search ? ` “${search}”` : ' this filter'}.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {!data.closed && data.students.length === 0 && (
        <p className="muted">No students in this section yet — admit or move students into it first.</p>
      )}
    </div>
  );
}
