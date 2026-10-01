'use client';

import { Icon, type IconName } from '@sw/ui';
import { CollectionsTrend } from '@school/components/charts';
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { api, type AdmissionsSummary, type ClassCollection, type Dashboard, type NotificationItem, type StaffDaySummary } from '@sw/api-client';
import { useMe, useCampusLens } from '@sw/session';
import { canReach, MFA_REQUIRED_ROLES } from '@sw/roles';
import { moneyShort, percentOf } from '@school/lib/money';

/**
 * The owner's home (Owner Dashboard Redesign Plan, Phase 1 — 2026-09-27). Also the landing page of
 * the Ops Admin, Campus Admin and Accountant, each seeing only what `data.visible` allows.
 *
 * **Read top to bottom, it answers the owner's questions in the order they are asked**
 * (research: the Pakistani/Indian owner dashboards lead with cash, then attendance):
 *
 *   1. status line   — is the school running today?
 *   2. headline      — how much needs me? (a count, not a clock greeting)
 *   3. one sentence  — the day and the month in words, for someone who does not read charts
 *   4. four cards    — money in, money owed, children in, staff in
 *   5. action list   — what to do next, ranked, one button per row
 *   6. one chart     — is this month normal?
 *
 * **Tone is MEANING, never decoration** (UI Retheme Plan U4, unchanged): `ok` money in / a complete
 * register · `danger` money not received / a message that failed · `warn` waiting on a human ·
 * `info` neutral. A pending state is never green — "Not marked yet" used to be.
 *
 * Supersedes the `ownerHomeV2` pilot flag: its four fixes (headline count, no grey wall before any
 * register is marked, month context, campus scope labels) are the default now.
 */
type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

/**
 * How each server-derived "needs attention" item is presented and ranked. The server decides WHAT
 * needs this role (`/notifications`, shared with the bell); this page decides only how it looks and
 * the order: money not received first, then money waiting, then people waiting, then information.
 * An unknown kind still renders (neutral, "Open") — a new server kind must never silently vanish.
 */
const KIND: Partial<Record<NotificationItem['kind'], { tone: Tone; icon: IconName; action: string; rank: number }>> = {
  // Opens the Defaulters screen with everyone textable ticked and its confirmation already showing
  // (Phase 3) — the send is still one deliberate press on a screen that states the SMS cost.
  DEFAULTERS: { tone: 'danger', icon: 'fees', action: 'Send reminders', rank: 0 },
  SMS_FAILED: { tone: 'danger', icon: 'message', action: 'Review', rank: 1 },
  // The owner's own job: vouchers held for sign-off — nothing reaches families until this is done.
  APPROVALS_PENDING: { tone: 'warn', icon: 'inbox', action: 'Review & approve', rank: 2 },
  CLAIMS_PENDING: { tone: 'warn', icon: 'fee-claims', action: 'Review payments', rank: 3 },
  SALARIES_TO_PAY: { tone: 'warn', icon: 'payslips', action: 'Open payroll', rank: 4 },
  REGISTERS_UNMARKED: { tone: 'warn', icon: 'attendance', action: 'Open registers', rank: 5 },
  STAFF_UNMARKED: { tone: 'warn', icon: 'staff', action: 'Open register', rank: 6 },
  LEAVES_PENDING: { tone: 'warn', icon: 'leaves', action: 'Review', rank: 7 },
  STAFF_ABSENT: { tone: 'info', icon: 'staff', action: 'View', rank: 8 },
  READY_TO_ADMIT: { tone: 'info', icon: 'admissions', action: 'Open', rank: 9 },
  TESTS_TODAY: { tone: 'info', icon: 'exams', action: 'Open', rank: 10 },
};

/** Shown at once; the rest sit behind "Show N more" — a list of twelve alerts is read as none. */
const ATTENTION_CAP = 5;
/** Classes shown in the "fees paid by class" card before "Show all". The question is who is behind. */
const CLASS_CAP = 5;

interface AttentionRow { key: string; tone: Tone; icon: IconName; text: string; sub?: string; action: string; href: string; rank: number; primary?: boolean }

/** One headline card. The whole card is the link into the screen behind the number. */
function Kpi({ title, icon, tone, value, children, href }: {
  title: string; icon: IconName; tone: Tone; value: ReactNode; children?: ReactNode; href?: string;
}) {
  const inner = (
    <>
      <div className="oh-kpi-head">
        <span className="oh-kpi-title">{title}</span>
        <span className={`oh-ico is-${tone}`}><Icon name={icon} size={16} /></span>
      </div>
      <div className={`oh-kpi-value is-${tone}`}>{value}</div>
      {children}
    </>
  );
  // A role entitled to the NUMBER always sees it; it is a link only when the role can open the
  // destination, otherwise it would dead-end on "Not authorized" (QA #5 — unchanged rule).
  return href
    ? <Link href={href} className="oh-card oh-kpi">{inner}</Link>
    : <div className="oh-card oh-kpi">{inner}</div>;
}

/** A single-colour progress bar. One hue on purpose: red beside green is unreadable to a
 *  deuteranope (see charts.tsx), and "how much of the whole" needs only one. */
function Meter({ pct, tone, label }: { pct: number; tone: Tone; label: string }) {
  return (
    <div className="oh-meter" role="img" aria-label={label}>
      <span className={`is-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function DashboardPage() {
  const me = useMe();
  const lens = useCampusLens();
  const [data, setData] = useState<Dashboard | null>(null);
  const [adm, setAdm] = useState<AdmissionsSummary | null>(null);
  const [staff, setStaff] = useState<StaffDaySummary | null>(null);
  // Derived server-side (N2) so the bell and this list cannot phrase the same fact two ways.
  const [attention, setAttention] = useState<NotificationItem[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [byClass, setByClass] = useState<ClassCollection | null>(null);
  const [allClasses, setAllClasses] = useState(false);
  const [err, setErr] = useState(false);

  useEffect(() => {
    // The campus lens narrows the owner's numbers to one campus; a campus-bound user is forced to
    // their own campus server-side, so this value only ever matters for the whole-school owner.
    api.dashboard(lens.campusId ?? undefined).then(setData).catch(() => setErr(true));
    // Fails silently for a role the API denies, so that card simply doesn't render.
    api.staffAttendance.daySummary().then(setStaff).catch(() => {});
    api.notifications.list().then((r) => setAttention(r.items)).catch(() => {});
    // Separate call (Phase 3): the bell reuses `/dashboard`, and this breakdown should not ride along.
    api.collectionByClass(lens.campusId ?? undefined).then(setByClass).catch(() => setByClass(null));
    // Every admissions figure counts Inquiry rows — meaningless in a DIRECT school, so not fetched.
    if (me?.admissionsMode === 'PIPELINE') api.admissions.summary().then(setAdm).catch(() => {});
  }, [me?.admissionsMode, lens.campusId]);

  if (err) return <p className="error">Couldn&apos;t load the dashboard.</p>;
  if (!data) {
    // Skeleton in the page's own shape, not a bare "Loading…" (NN/g: a full-page load should show
    // where things will be, so the page does not jump when they arrive).
    return (
      <div className="oh" aria-busy="true" aria-label="Loading the dashboard">
        <div className="oh-skel" style={{ height: 34, width: '55%' }} />
        <div className="oh-skel" style={{ height: 20, width: '80%' }} />
        <div className="oh-kpis">{[0, 1, 2, 3].map((i) => <div key={i} className="oh-skel" style={{ height: 132 }} />)}</div>
      </div>
    );
  }

  const shows = (k: string) => data.visible.includes(k);
  const reach = (href: string) => canReach(me?.roles, href, me?.admissionsMode, me?.campusAdminSeesFees);
  const monthName = MONTHS[new Date().getMonth()];

  // ── Is the school running today? ─────────────────────────────────────────────────────────────
  // From the dashboard API itself (Phase 2): weekly off + holiday calendar, per open campus. On a
  // closed day the API expects nobody, so the page cannot nag about a register that cannot be taken.
  const closed = !data.schoolDay.open;
  const closedWhy = (data.schoolDay.reason ?? 'weekly off').toLowerCase() === 'weekly off' ? 'weekly off' : data.schoolDay.reason;

  // ── Students ─────────────────────────────────────────────────────────────────────────────────
  const expected = data.todayAttendanceExpected ?? 0;
  const marked = data.todayAttendanceMarked ?? 0;
  const bd = data.attendanceBreakdown;
  const inSchool = bd ? bd.present + bd.late : 0;
  const anyMarked = marked > 0;
  const registersComplete = expected > 0 && marked >= expected;

  // ── Money ────────────────────────────────────────────────────────────────────────────────────
  const collected = data.monthCollections ?? 0;
  const trend = data.collectionsTrend ?? [];
  const earlierAllZero = trend.slice(0, -1).every((p) => p.collected <= 0);
  const defaulters = data.defaulterCount ?? 0;
  const owed = data.outstandingTotal ?? 0;
  // Share of THIS month's fees that is paid (null when nothing was billed yet — no base to share).
  const paidPct = percentOf(data.monthBilledPaid ?? 0, data.monthBilled ?? 0);
  // Month-to-date against last month to the same day; silent when last month had nothing to compare.
  const lastToDate = data.lastMonthToDate ?? 0;
  const delta = lastToDate > 0 ? Math.round(((collected - lastToDate) / lastToDate) * 100) : null;

  // ── Needs attention ──────────────────────────────────────────────────────────────────────────
  const needsMfa = !!me && !me.mfaEnabled && me.roles.some((r) => (MFA_REQUIRED_ROLES as readonly string[]).includes(r));
  const rows: AttentionRow[] = attention
    .filter((a) => reach(a.href))
    // The status line already says the school is shut; the same fact twice is noise.
    .filter((a) => a.kind !== 'SCHOOL_CLOSED')
    .map((a) => {
      const k = KIND[a.kind] ?? { tone: a.severity === 'warn' ? 'warn' as Tone : 'info' as Tone, icon: 'alert' as IconName, action: 'Open', rank: 20 };
      // The bell says "144 fee defaulters."; here the row can say what that costs. Only without a
      // campus lens: the list is school-wide, the amount would otherwise be one campus's.
      const text = a.kind === 'DEFAULTERS' && !lens.campusId && shows('defaulterCount') && owed > 0
        ? `${defaulters} student${defaulters === 1 ? ' owes' : 's owe'} ${moneyShort(owed)}`
        : a.text;
      const sub = a.kind === 'DEFAULTERS' && text !== a.text ? 'All past their fee due date' : undefined;
      const href = a.kind === 'DEFAULTERS' ? '/defaulters?remind=all' : a.href;
      return { key: a.id, tone: k.tone, icon: k.icon, text, sub, action: k.action, href, rank: k.rank };
    });
  if (needsMfa) {
    // Was a plain-text banner in the shell that read as decoration — and the reason "Appoint" looked
    // broken (it 403s until this is done). Here it is a task with a button, ranked just after money.
    rows.push({
      key: 'mfa', tone: 'warn', icon: 'lock', text: 'Turn on 2-step sign-in',
      sub: 'Needed to approve salaries, waive or reverse fees, or appoint a deputy',
      action: 'Set up · 1 min', href: '/security', rank: 2,
    });
  }
  rows.sort((a, b) => a.rank - b.rank);
  if (rows[0]) rows[0].primary = true;
  const visibleRows = showAll ? rows : rows.slice(0, ATTENTION_CAP);
  const n = rows.length;

  // Campus lens: the cards honour it, the action list is school-wide — say so on each (#15).
  const activeCampus = lens.campusId ? (lens.campuses.find((c) => c.id === lens.campusId)?.name ?? 'This campus') : null;

  // ── The one sentence ─────────────────────────────────────────────────────────────────────────
  // Built only from facts this role may see, in words, with every number carrying its context.
  const sentence: ReactNode[] = [];
  // Today's cash first when there is any — the figure owners in this market check first. Silent at
  // zero: "Rs 0 today" at 8 a.m. is not news, and a closed day has no counter open.
  const todayCash = data.todayCollections ?? 0;
  if (shows('monthCollections') && todayCash > 0) {
    sentence.push(
      <span key="t">
        Today <strong className="is-ok">{moneyShort(todayCash)}</strong> came in from {data.todayPayments} payment{data.todayPayments === 1 ? '' : 's'}.{' '}
      </span>,
    );
  }
  if (shows('monthCollections')) {
    sentence.push(
      <span key="m">
        So far in {monthName} you have collected <strong className="is-ok">{moneyShort(collected)}</strong>
        {paidPct !== null ? <> — {paidPct}% of this month&apos;s fees are paid</> : null}.{' '}
      </span>,
    );
  }
  if (shows('defaulterCount') && defaulters > 0) {
    sentence.push(
      <span key="d">
        <strong className="is-danger">{defaulters} student{defaulters === 1 ? '' : 's'}</strong> still owe{defaulters === 1 ? 's' : ''} {moneyShort(owed)}.{' '}
      </span>,
    );
  }
  if (shows('todayAttendancePercent')) {
    if (closed) sentence.push(<span key="a">No classes today, so there is no register to take.</span>);
    else if (anyMarked) sentence.push(<span key="a">Today <strong>{inSchool} of {expected}</strong> students are in school.</span>);
    else if (expected > 0) sentence.push(<span key="a">No student register has been marked yet today.</span>);
  }

  const empty = (data.enrollmentCount ?? 0) === 0;
  const admitHref = me?.admissionsMode === 'PIPELINE' ? '/admissions' : '/students';
  const quick = [
    { href: '/fees', label: 'Record a payment' },
    { href: admitHref, label: 'Admit a student' },
    { href: '/reports', label: 'Reports' },
    { href: '/sms', label: 'Send a notice to parents' },
  ]
    .filter((q) => reach(q.href));

  return (
    <div className="oh">
      <div className="oh-status">
        {closed ? (
          <span className="oh-pill is-neutral"><Icon name="calendar" size={14} /> School closed · {closedWhy}</span>
        ) : (
          <span className="oh-pill is-ok"><span className="oh-dot" aria-hidden="true" /> School open today</span>
        )}
        <span className="muted">{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
        {activeCampus && <span className="badge oh-scope">{activeCampus}</span>}
      </div>

      <div className="oh-hero">
        <h1>{greeting()}. {n ? `${n} thing${n === 1 ? ' needs' : 's need'} you today.` : "You're all caught up."}</h1>
        {sentence.length > 0 && <p>{sentence}</p>}
      </div>

      <div className="oh-kpis">
        {shows('monthCollections') && (
          <Kpi title={`Fees collected · ${monthName}`} icon="fees" tone="ok" value={moneyShort(collected)} href={reach('/fees') ? '/fees' : undefined}>
            {/* A bar only against a real base: this month's own bills. Nothing billed yet is said in
                words — an empty bar would read as "nobody paid". */}
            {paidPct !== null ? (
              <>
                <Meter pct={paidPct} tone="ok" label={`${paidPct}% of this month's fees paid`} />
                <span className="oh-kpi-sub">{paidPct}% of {moneyShort(data.monthBilled)} billed is paid</span>
              </>
            ) : (
              <span className="oh-kpi-sub">No fees billed yet for {monthName}</span>
            )}
            {todayCash > 0 && <span className="oh-kpi-sub is-ok">{moneyShort(todayCash)} today</span>}
            {delta !== null && (
              <span className={`oh-kpi-sub ${delta > 0 ? 'is-ok' : delta < 0 ? 'is-warn' : ''}`}>
                {delta > 0 ? '▲' : delta < 0 ? '▼' : '='} {Math.abs(delta)}% vs last month by this date
              </span>
            )}
          </Kpi>
        )}
        {shows('defaulterCount') && (
          <Kpi title="Still owed" icon="alert" tone={defaulters > 0 ? 'danger' : 'ok'}
               value={defaulters > 0 ? moneyShort(owed) : 'Nothing overdue'}
               href={reach('/defaulters') ? '/defaulters' : undefined}>
            <span className="oh-kpi-sub">
              {defaulters > 0 ? `${defaulters} student${defaulters === 1 ? ' is' : 's are'} past their fee due date` : 'Every fee due so far is paid'}
            </span>
            {defaulters > 0 && reach('/defaulters') && <span className="oh-kpi-go">See who owes →</span>}
          </Kpi>
        )}
        {shows('todayAttendancePercent') && (
          closed ? (
            <Kpi title="Students in school" icon="students" tone="neutral" value="Closed today">
              <span className="oh-kpi-sub">No register today · {data.enrollmentCount} enrolled</span>
            </Kpi>
          ) : (
            <Kpi title="Students in school" icon="students" tone={anyMarked ? 'info' : 'warn'}
                 value={anyMarked ? <>{inSchool} <small>of {expected}</small></> : 'Not marked yet'}
                 href={reach('/attendance') ? '/attendance' : undefined}>
              {anyMarked && expected > 0 && (
                <Meter pct={Math.min(100, Math.round((inSchool / expected) * 100))} tone="ok"
                       label={`${inSchool} of ${expected} students present`} />
              )}
              {/* Coverage sits BESIDE the count, never inside it: "95%" over two of twenty marked
                  registers is a reassuring lie (the rule the old statline carried). */}
              <span className={`oh-kpi-sub ${registersComplete ? 'is-ok' : anyMarked ? 'is-warn' : ''}`}>
                {registersComplete
                  ? 'Every register marked'
                  : anyMarked
                    ? `${marked} of ${expected} marked so far`
                    : `${expected} students expected`}
              </span>
            </Kpi>
          )
        )}
        {staff && reach('/staff-attendance') && (
          staff.workingDay ? (
            <Kpi title="Teachers & staff at work" icon="staff" tone={staff.unmarked ? 'warn' : 'info'}
                 value={<>{staff.present + staff.late} <small>of {staff.totalStaff}</small></>}
                 href={`/attendance?tab=staff&date=${staff.date}`}>
              {/* "Not marked" is its own figure, never folded into "absent": nothing derives absence,
                  and calling unrecorded people absent would be a lie about who came to work. */}
              <span className={`oh-kpi-sub ${staff.unmarked ? 'is-warn' : ''}`}>
                {staff.unmarked ? `${staff.unmarked} not marked yet` : staff.absent ? `${staff.absent} absent · ${staff.onLeave} on leave` : 'Everyone accounted for'}
              </span>
            </Kpi>
          ) : (
            <Kpi title="Teachers & staff at work" icon="staff" tone="neutral" value="Closed today" href={`/attendance?tab=staff&date=${staff.date}`}>
              <span className="oh-kpi-sub">{staff.holidayName ?? 'Weekly off'} — no register today</span>
            </Kpi>
          )
        )}
      </div>

      <div className="oh-row">
        <section className="oh-card oh-attn" aria-labelledby="oh-attn-h">
          <div className="oh-card-head">
            <h2 id="oh-attn-h">{n ? 'Needs your attention' : 'All clear'}</h2>
            {activeCampus && <span className="badge oh-scope">Whole school</span>}
          </div>
          {n === 0 ? (
            <p className="muted oh-allclear"><Icon name="check-circle" size={18} /> Nothing is waiting on you right now.</p>
          ) : (
            <ul className="oh-list">
              {visibleRows.map((r) => (
                <li key={r.key}>
                  <span className={`oh-ico lg is-${r.tone}`}><Icon name={r.icon} size={20} /></span>
                  <span className="oh-list-text">
                    <span className="t">{r.text}</span>
                    {r.sub && <span className="s">{r.sub}</span>}
                  </span>
                  <Link href={r.href} className={`oh-btn${r.primary ? ' is-primary' : ''}`}>{r.action}</Link>
                </li>
              ))}
            </ul>
          )}
          {n > ATTENTION_CAP && (
            <button type="button" className="ghost small oh-more" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show fewer' : `Show ${n - ATTENTION_CAP} more`}
            </button>
          )}
        </section>

        {trend.length > 0 && (
          <section className="oh-card oh-trend" aria-labelledby="oh-trend-h">
            <div className="oh-card-head">
              <h2 id="oh-trend-h">Fees collected</h2>
              <span className="muted">last 6 months</span>
            </div>
            <CollectionsTrend points={trend} money={(v) => moneyShort(v, 'short')} />
            {/* An empty history is stated, not left as a flat line that reads like a crash. */}
            {earlierAllZero && trend.length > 1 && (
              <p className="muted oh-note">No collections recorded in the earlier months.</p>
            )}
          </section>
        )}
      </div>

      {byClass && byClass.classes.some((c) => c.percentPaid !== null) && (() => {
        const billedClasses = byClass.classes.filter((c) => c.percentPaid !== null);
        const shown = allClasses ? billedClasses : billedClasses.slice(0, CLASS_CAP);
        return (
          <section className="oh-card" aria-labelledby="oh-class-h">
            <div className="oh-card-head">
              <h2 id="oh-class-h">Fees paid by class · {monthName}</h2>
              <span className="muted">{allClasses ? 'all classes' : 'lowest first'}</span>
            </div>
            {/* Sorted worst first by the API; one hue for every bar (a ranking, not a status), with
                the weakest classes' percentage in amber so "who is behind" reads without the bars. */}
            <ul className="oh-classes">
              {shown.map((c) => (
                <li key={c.classId}>
                  <span className="oh-class-name">{c.name}</span>
                  <span className="oh-meter oh-class-bar" role="img" aria-label={`${c.name}: ${c.percentPaid}% of this month's fees paid`}>
                    <span className="is-brand" style={{ width: `${c.percentPaid}%` }} />
                  </span>
                  <span className={`oh-class-pct${(c.percentPaid ?? 0) < 50 ? ' is-warn' : ''}`}>{c.percentPaid}%</span>
                  <span className="oh-class-amt muted">{moneyShort(c.paid, 'short')} of {moneyShort(c.billed, 'short')}</span>
                </li>
              ))}
            </ul>
            {billedClasses.length > CLASS_CAP && (
              <button type="button" className="ghost small oh-more" onClick={() => setAllClasses((v) => !v)}>
                {allClasses ? 'Show the lowest 5' : `Show all ${billedClasses.length} classes`}
              </button>
            )}
          </section>
        );
      })()}

      {adm && (
        <section className="oh-card" aria-labelledby="oh-adm-h">
          <div className="oh-card-head"><h2 id="oh-adm-h">Admissions</h2></div>
          <p className="oh-adm">
            <Link href="/admissions"><strong>{adm.totals.open}</strong> open inquiries</Link>
            <span><strong>{adm.admittedThisMonth}</strong> admitted this month</span>
            <span><strong>{adm.conversionRate}%</strong> of inquiries become admissions</span>
          </p>
        </section>
      )}

      {quick.length > 0 && (
        <nav className="oh-quick" aria-label="Quick actions">
          {quick.map((q) => <Link key={q.href + q.label} href={q.href}>{q.label}</Link>)}
        </nav>
      )}

      {empty && (
        <div className="oh-card">
          <p className="muted" style={{ margin: 0 }}>
            New here? Go to <b>Setup</b> to create an academic year, campus, class and section,
            then add students under <b>Students</b> — the figures above will start filling in.
          </p>
        </div>
      )}
    </div>
  );
}
