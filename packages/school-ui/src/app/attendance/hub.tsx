'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { api, type AttendanceOverview, type AwayToday, type StaffDaySummary } from '@sw/api-client';
import { useCampusLens } from '@sw/session';
import { ProfileTabs } from '../students/profile-tabs';
import StaffAttendancePage from '../staff-attendance/page';
import LeavesPage from '../leaves/page';
import CoverPage from '../cover/page';
import { AttendanceOverviewPanel } from './owner-overview';

/**
 * The Attendance hub — one sidebar entry for owner and campus admin (Attendance Hub Plan).
 *
 * Three choices, nothing nested: **Today · Students · Staff**. Leave requests and Cover are not tabs: they are
 * the two decisions waiting on the owner, so they live in the "Waiting for you" strip on Today and open as
 * views with a way back. Students and staff are labelled as such everywhere — "Attendance" on its own used to
 * mean students while staff attendance sat in another sidebar group, and nothing said which was which.
 *
 * The view lives in the URL (`?tab=students|staff|leaves|cover`; Today is the bare `/attendance`). The older
 * deep links still work: `?view=register`, `?sectionId=…` and `?unmarked=1` open a class under Students.
 */
type HubView = 'today' | 'students' | 'staff' | 'leaves' | 'cover';
const VIEWS: HubView[] = ['today', 'students', 'staff', 'leaves', 'cover'];

function readHub(): { view: HubView; classOpen: boolean } {
  if (typeof window === 'undefined') return { view: 'today', classOpen: false };
  const q = new URLSearchParams(window.location.search);
  const classOpen = q.get('view') === 'register' || !!q.get('sectionId') || !!q.get('unmarked');
  const tab = q.get('tab') as HubView | null;
  if (tab && VIEWS.includes(tab)) return { view: tab, classOpen };
  return { view: classOpen ? 'students' : 'today', classOpen };
}

const today = () => new Date().toISOString().slice(0, 10);

interface HubData {
  students: AttendanceOverview | null;
  staff: StaffDaySummary | null;
  leaves: { students: number; staff: number } | null;
  cover: AwayToday | null;
  loaded: boolean;
}

/** One read shared by the Today panels and the counts on the bar, so a number can never differ between them. */
function useHubData(campusId: string | null): HubData {
  const [d, setD] = useState<HubData>({ students: null, staff: null, leaves: null, cover: null, loaded: false });
  useEffect(() => {
    let alive = true;
    const c = campusId ?? undefined;
    Promise.allSettled([
      api.staff.attendanceOverview({ campusId, days: 7 }),
      api.staffAttendance.daySummary(undefined, c),
      api.leaveQueue.students('PENDING', campusId),
      api.leaveQueue.staff('PENDING', campusId),
      api.cover.away(today(), campusId),
    ]).then(([s, st, ls, lf, cv]) => {
      if (!alive) return;
      setD({
        students: s.status === 'fulfilled' ? s.value : null,
        staff: st.status === 'fulfilled' ? st.value : null,
        leaves: ls.status === 'fulfilled' && lf.status === 'fulfilled' ? { students: ls.value.total, staff: lf.value.total } : null,
        cover: cv.status === 'fulfilled' ? cv.value : null,
        loaded: true,
      });
    });
    return () => { alive = false; };
  }, [campusId]);
  return d;
}

export function AttendanceHub({ viewOnly, renderClass }: { viewOnly: boolean; renderClass: (key: number) => ReactNode }) {
  const lens = useCampusLens();
  // ⚠️ Read the URL AFTER mount, not while rendering. On an in-app redirect (an old `/staff-attendance` link) the page
  // renders before the address bar has been updated, so a render-time read saw no `?tab=` and opened on Today.
  const [view, setView] = useState<HubView | null>(null);
  const [classOpen, setClassOpen] = useState(false);
  const [key, setKey] = useState(0);
  useEffect(() => { const h = readHub(); setView(h.view); setClassOpen(h.classOpen); }, []);
  const data = useHubData(lens.campusId);

  const go = (next: HubView, params: Record<string, string> = {}) => {
    const url = new URL(window.location.href);
    for (const k of ['tab', 'view', 'sectionId', 'date', 'unmarked', 'status']) url.searchParams.delete(k);
    if (next !== 'today') url.searchParams.set('tab', next);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    window.history.replaceState(window.history.state, '', url);
    setKey((k) => k + 1);
    setClassOpen(params.view === 'register');
    setView(next);
  };

  const needsCover = (data.cover?.away ?? []).flatMap((a) => a.sections.filter((s) => !s.coveredBy)).length;
  const leavesPending = data.leaves ? data.leaves.students + data.leaves.staff : 0;
  const behind = data.students?.today.open && data.students.due ? data.students.today.registersUnmarked : 0;
  const unmarkedStaff = data.staff?.workingDay ? data.staff.unmarked : 0;
  const count = (n: number) => (n > 0 ? ` (${n})` : '');

  const tabs: Array<{ key: 'today' | 'students' | 'staff'; label: string }> = [
    { key: 'today', label: `Today${count(leavesPending + needsCover)}` },
    { key: 'students', label: `Students${count(behind)}` },
    { key: 'staff', label: `Staff${count(unmarkedStaff)}` },
  ];
  if (view === null) return <p className="muted">Loading…</p>;
  const activeTab = view === 'leaves' ? 'today' : view === 'cover' ? 'staff' : view;

  return (
    <div className="oh">
      <div className="ov-head">
        <div>
          <h1 style={{ margin: 0 }}>Attendance</h1>
          <p className="ov-lede">Students, and teachers &amp; staff — who is in, who is behind, and what needs your decision.</p>
        </div>
        <ProfileTabs tabs={tabs} value={activeTab} onChange={(t) => go(t)} label="Attendance sections" />
      </div>

      {view === 'today' && <TodayView data={data} onGo={go} />}

      {view === 'students' && (
        <div className="stack">
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 18 }}>Student attendance</h2>
              <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>
                {viewOnly
                  ? 'View only — class teachers mark the register; your campus admin or Ops Admin makes corrections.'
                  : 'Class teachers mark the register; campus admins and the Ops Admin make corrections.'}
              </p>
            </div>
            {classOpen
              ? <button type="button" className="ghost small" onClick={() => go('students')}>← All classes</button>
              : <button type="button" className="ghost small" onClick={() => go('students', { view: 'register' })}>Open a class&rsquo;s attendance</button>}
          </div>
          {classOpen
            ? renderClass(key)
            : <AttendanceOverviewPanel onOpenRegister={(sectionId, date) => go('students', { view: 'register', sectionId, date })} />}
        </div>
      )}

      {view === 'staff' && (
        <div className="stack">
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>Staff attendance</h2>
            <button type="button" className="ghost small" onClick={() => go('cover')}>
              Arrange cover{needsCover > 0 ? ` (${needsCover} class${needsCover === 1 ? '' : 'es'} need one)` : ''} →
            </button>
          </div>
          <StaffAttendancePage embedded />
        </div>
      )}

      {view === 'leaves' && (
        <div className="stack">
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>Leave requests</h2>
            <button type="button" className="ghost small" onClick={() => go('today')}>← Back to Today</button>
          </div>
          <LeavesPage embedded />
        </div>
      )}

      {view === 'cover' && (
        <div className="stack">
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>Cover</h2>
            <button type="button" className="ghost small" onClick={() => go('staff')}>← Back to Staff attendance</button>
          </div>
          <CoverPage embedded />
        </div>
      )}
    </div>
  );
}

// ── Today ────────────────────────────────────────────────────────────────────

function Line({ label, value, tone }: { label: string; value: ReactNode; tone?: 'bad' | 'warn' }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
      <span className="muted" style={{ fontSize: 14 }}>{label}</span>
      <span className={`ov-num ${tone === 'bad' ? 'is-bad' : tone === 'warn' ? 'is-warn' : ''}`} style={{ fontSize: 18 }}>{value}</span>
    </div>
  );
}

function TodayView({ data, onGo }: { data: HubData; onGo: (v: HubView) => void }) {
  const s = data.students;
  const st = data.staff;
  const pending = data.leaves ? data.leaves.students + data.leaves.staff : null;
  const needsCover = (data.cover?.away ?? []).flatMap((a) => a.sections.filter((x) => !x.coveredBy)).length;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        <section className="card stack" style={{ gap: 12 }} aria-labelledby="hub-students">
          <h2 id="hub-students" style={{ margin: 0, fontSize: 13, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>Students</h2>
          {!data.loaded ? <span className="ov-skel" style={{ height: 120, display: 'block' }} />
            : !s ? <p className="muted" style={{ margin: 0 }}>Could not load today&rsquo;s student attendance.</p>
            : !s.today.open ? <p style={{ margin: 0 }}><strong>School is closed today.</strong> <span className="muted">No attendance is taken.</span></p>
            : (
              <>
                <Line label="Present" value={s.today.marked > 0 ? <>{s.today.present} <small>of {s.today.expected}</small></> : 'Not taken yet'} />
                <Line label="Absent" value={s.today.absent} tone={s.today.absent > 0 ? 'warn' : undefined} />
                <Line label="Late · On leave" value={`${s.today.late} · ${s.today.onLeave}`} />
                <Line label="Classes that haven’t taken attendance"
                  value={`${s.today.registersUnmarked} of ${s.today.registers}`}
                  tone={s.today.registersUnmarked > 0 ? (s.due ? 'bad' : 'warn') : undefined} />
                {s.today.registersUnmarked > 0 && <span className="ov-sub">{s.due ? `Overdue — due by ${s.markByTime}` : `Due by ${s.markByTime}`}</span>}
              </>
            )}
          <div><button type="button" className="ghost small" onClick={() => onGo('students')}>Open student attendance →</button></div>
        </section>

        <section className="card stack" style={{ gap: 12 }} aria-labelledby="hub-staff">
          <h2 id="hub-staff" style={{ margin: 0, fontSize: 13, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>Teachers &amp; staff</h2>
          {!data.loaded ? <span className="ov-skel" style={{ height: 120, display: 'block' }} />
            : !st ? <p className="muted" style={{ margin: 0 }}>Could not load today&rsquo;s staff attendance.</p>
            : !st.workingDay ? <p style={{ margin: 0 }}><strong>No staff attendance today.</strong> <span className="muted">{st.holidayName ?? 'Weekly off'}.</span></p>
            : (
              <>
                <Line label="At work" value={<>{st.present + st.late} <small>of {st.totalStaff}</small></>} />
                <Line label="Absent" value={st.absent} tone={st.absent > 0 ? 'warn' : undefined} />
                <Line label="On leave" value={st.onLeave} />
                <Line label="Not marked yet" value={st.unmarked} tone={st.unmarked > 0 ? 'warn' : undefined} />
              </>
            )}
          <div><button type="button" className="ghost small" onClick={() => onGo('staff')}>Open staff attendance →</button></div>
        </section>
      </div>

      <section className="card stack" style={{ gap: 10 }} aria-labelledby="hub-waiting">
        <h2 id="hub-waiting" style={{ margin: 0, fontSize: 13, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>Waiting for you</h2>
        {!data.loaded ? <span className="ov-skel" style={{ height: 48, display: 'block' }} /> : (
          <>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <span>
                {pending === null ? 'Leave requests could not be loaded.'
                  : pending === 0 ? 'No leave requests are waiting.'
                  : <><strong>{pending}</strong> leave request{pending === 1 ? '' : 's'} to review
                    <span className="ov-sub"> · {data.leaves!.students} student{data.leaves!.students === 1 ? '' : 's'}, {data.leaves!.staff} staff</span></>}
              </span>
              {pending !== null && pending > 0 && <button type="button" className="ghost small" onClick={() => onGo('leaves')}>Review →</button>}
            </div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <span>
                {!data.cover ? 'Cover could not be loaded.'
                  : needsCover === 0 ? 'No class needs a substitute.'
                  : <><strong>{needsCover}</strong> class{needsCover === 1 ? '' : 'es'} need a substitute today</>}
              </span>
              {needsCover > 0 && <button type="button" className="ghost small" onClick={() => onGo('cover')}>Arrange cover →</button>}
            </div>
            {data.cover && !data.cover.staffRegisterMarked && (
              <span className="ov-sub">Based on approved leave only — today&rsquo;s staff register has not been marked.</span>
            )}
          </>
        )}
      </section>
    </div>
  );
}
