'use client';

import { Icon, type IconName } from '@sw/ui';
import { RegisterBar, CollectionsTrend } from '@school/components/charts';
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { api, type AdmissionsSummary, type Dashboard, type NotificationItem, type StaffDaySummary } from '@sw/api-client';
import { useMe } from '@sw/session';
import { canReach } from '@sw/roles';

/**
 * Tone is MEANING, never decoration (UI Retheme Plan U4, design reference §6.4). One rule, applied
 * everywhere on this page so a colour can be read without checking what it is attached to:
 *
 *   ok     money in, a register that is complete, staff who turned up
 *   danger money owed or a delivery that failed — someone loses something
 *   warn   waiting on a human: pending, unmarked, below the line
 *   info   a neutral count that is neither good nor bad news
 *
 * A count of zero is not an alert, so tiles carry a resting tone AND the tone they take once their
 * threshold trips — "0 defaulters" in red would train people to ignore red.
 */
type Tone = 'ok' | 'warn' | 'danger' | 'info';

type Tile = {
  key: keyof Dashboard;
  label: string;
  href: string;
  icon: IconName;
  tone: Tone;
  /** Render the numeral through `.money` (currency prefix, separators, two decimals). */
  money?: boolean;
  fmt?: (v: number) => string;
  alert?: (v: number) => boolean;
  /** The tone once `alert` fires — the same number now means something different. */
  alertTone?: Tone;
};

/**
 * `Rs 1,850,000.00` — prefix, thousands separators, two decimals (design reference §5). It was
 * `Rs ${v.toLocaleString()}` here and something else on every other screen.
 *
 * ⚠️ The locale is PINNED rather than left to the browser: South-Asian locales group by lakh
 * (`Rs 18,50,000`), so an unpinned total silently regroups itself depending on which machine opens
 * the dashboard — and a figure that renders two ways is a figure nobody can check against a ledger.
 */
const money = (v: number) =>
  `Rs ${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const SECTIONS: Array<{ title: string; icon: IconName; tiles: Tile[] }> = [
  {
    title: 'Academics & Enrollment',
    icon: 'admissions-team',
    tiles: [
      { key: 'enrollmentCount', label: 'Active students', href: '/students', icon: 'students', tone: 'info' },
      { key: 'todayAttendancePercent', label: "Today's attendance", href: '/attendance', icon: 'attendance', tone: 'ok', fmt: (v) => `${v}%`, alert: (v) => v < 75, alertTone: 'warn' },
      { key: 'pendingLeaves', label: 'Pending leaves', href: '/leaves', icon: 'leaves', tone: 'info', alert: (v) => v > 0, alertTone: 'warn' },
    ],
  },
  {
    // ⚠️ "Collections", not "Finance" (GAP-10). The panel shows money IN — collected and owed — and no cost.
    // Titled "Finance", revenue with no expense beside it reads as profit. Expense tracking is a separate,
    // undecided scope question (Decision D5); until it exists, the label must not imply it does.
    title: 'Collections',
    icon: 'fees',
    // Money in is `ok`; money that did not arrive is `danger`. That pairing is the whole point of
    // the section — the two numbers are the same fact from opposite ends.
    tiles: [
      { key: 'monthCollections', label: 'Collections (month)', href: '/fees', icon: 'fees', tone: 'ok', money: true },
      { key: 'defaulterCount', label: 'Defaulters', href: '/defaulters', icon: 'trend-up', tone: 'info', alert: (v) => v > 0, alertTone: 'danger' },
    ],
  },
  {
    title: 'Communication',
    icon: 'message',
    // `danger`, not `warn`: a failed SMS is not something waiting to be done, it is a message the
    // parent never received. Nothing will retry it unless somebody looks.
    tiles: [
      { key: 'failedSmsCount', label: 'Failed SMS', href: '/reports', icon: 'message', tone: 'info', alert: (v) => v > 0, alertTone: 'danger' },
    ],
  },
];

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

/**
 * One metric tile: circular icon badge, then the numeral **stacked over** its caption (design
 * reference §5, "Student Statistics"). Every tile is a link — these are the way into the screen
 * behind the number — so `.metric-link` stays for the focus ring (`a.metric-link:focus-visible`
 * in globals.css is what a keyboard user steers by).
 *
 * ⚠️ **The numeral and caption are stacked, not side by side, and that is a bug fix rather than
 * a restyle.** Laid out as three flex children in a ROW, the tile's width was the *sum* of icon +
 * numeral + caption: "Rs 90,000.00 / Collections (month)" needed **311px** in a **228px** grid
 * cell and spilled **73px into the next tile**, where the neighbour's opaque background covered
 * it on hover. Stacking makes the width `max(numeral, caption)` instead of their sum, which is
 * what the reference does and what stops the tile outgrowing its column.
 *
 * `stat--money` exists because a currency string is intrinsically several times longer than a
 * count — "Rs 90,000.00" against "17" — so it takes a smaller step of the same scale. One size
 * for both means either a tiny count or an overflowing total.
 */
function Stat({ href, icon, tone, value, caption, money }: {
  href: string; icon: IconName; tone: Tone; value: ReactNode; caption: string; money?: boolean;
}) {
  return (
    <Link href={href} className={`stat metric-link is-${tone}${money ? ' stat--money' : ''}`}>
      <span className={`ico is-${tone}`}><Icon name={icon} size={20} /></span>
      <span className="stat-text">
        <span className="value">{value}</span>
        <span className="caption">{caption}</span>
      </span>
    </Link>
  );
}

export default function DashboardPage() {
  const me = useMe();
  const [data, setData] = useState<Dashboard | null>(null);
  const [adm, setAdm] = useState<AdmissionsSummary | null>(null);
  const [staff, setStaff] = useState<StaffDaySummary | null>(null);
  // The "needs attention" strip. Derived server-side (N2) so the bell in the shell and this
  // strip cannot phrase the same fact two ways — and so the roles that never see this page still
  // get the items, in the bell.
  const [attention, setAttention] = useState<NotificationItem[]>([]);
  const [err, setErr] = useState(false);

  useEffect(() => {
    api.dashboard().then(setData).catch(() => setErr(true));
    // Fails silently for a role the API denies, so the section simply doesn't render — the
    // same pattern the other rollups use rather than showing an error to someone who was
    // never meant to see the card.
    api.staffAttendance.daySummary().then(setStaff).catch(() => {});
    // One call replaces four: pending claims, unmarked registers, the staff-day chips and the
    // dashboard counters were each fetched here and phrased here. The server decides what needs
    // this role and how to say it; this page only lays it out.
    api.notifications.list().then((r) => setAttention(r.items)).catch(() => {});
    // Every figure in this summary counts Inquiry rows, so in a DIRECT school (no enquiry
    // pipeline) the card would advertise "0 open inquiries · 0% conversion" for ever — a
    // metric that can never move is worse than no metric. Skip the fetch entirely.
    if (me?.admissionsMode === 'PIPELINE') api.admissions.summary().then(setAdm).catch(() => {});
  }, [me?.admissionsMode]);

  if (err) return <p className="error">Couldn&apos;t load the dashboard.</p>;
  if (!data) return <p className="muted">Loading…</p>;

  // Show a tile only when the metric is role-visible AND the role can open its destination —
  // otherwise it dead-ends on the "Not authorized" screen (e.g. Collections → /fees for a
  // campus admin, who sees the financial metric but has no Fees access).
  const visible = (t: Tile) => data.visible.includes(t.key) && canReach(me?.roles, t.href, me?.admissionsMode);
  const val = (t: Tile) => data[t.key] as number | null;
  const isAlert = (t: Tile) => {
    const v = val(t);
    return v != null && !!t.alert?.(v);
  };
  const toneOf = (t: Tile): Tone => (isAlert(t) && t.alertTone ? t.alertTone : t.tone);
  const display = (t: Tile): ReactNode => {
    const v = val(t);
    if (v == null) return '—';
    // ⚠️ `.money` is applied to an INLINE span rather than to `.value` itself: the class carries
    // right-alignment for table rows, which inside a left-aligned tile would fling the numeral to
    // one edge and leave its caption at the other. The tabular numerals still apply.
    if (t.money) return <span className="money">{money(v)}</span>;
    return t.fmt ? t.fmt(v) : String(v);
  };

  /**
   * The strip is now **rendered, not derived** (Notifications Plan, N2).
   *
   * It used to assemble nine chips here from five separate fetches, restating each threshold and
   * each sentence. `/notifications` does that once, server-side, and the bell in the shell renders
   * the same list — so the two cannot phrase the same fact differently, and a rule like "stay
   * quiet until the school's own attendance deadline" exists in one place.
   *
   * It also fixed a gap this page could not: the chips only ever appeared here, and an
   * ADMISSION_CONTROLLER lands on `/admissions` while an HR_MANAGER lands on `/staff`. Neither had
   * ever seen "5 students ready to admit" or "3 staff not marked today". They get them in the bell.
   */
  const reachableAttention = attention.filter((a) => canReach(me?.roles, a.href, me?.admissionsMode));
  const needsAttention = reachableAttention.length > 0;

  const empty = (data.enrollmentCount ?? 0) === 0;

  // Attendance coverage, read once so the statline below can size the shortfall.
  const marked = data.todayAttendanceMarked ?? 0;
  const expected = data.todayAttendanceExpected ?? 0;
  const registersComplete = expected > 0 && marked >= expected;

  return (
    <div className="stack">
      <div>
        <h1 style={{ marginBottom: 2 }}>{greeting()}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · {me?.email}
        </p>
      </div>

      {/* The one panel that changes colour by state rather than by subject: accent when something
          is waiting, plain when nothing is. The accent is a FILL behind white header text, which is
          the only place it is allowed to appear (it measures 4.17:1 — below the floor for text). */}
      <section className={needsAttention ? 'panel panel--accent' : 'panel'}>
        <header>
          <span className="ico"><Icon name={needsAttention ? 'alert' : 'check-circle'} size={18} /></span>
          {needsAttention ? 'Needs attention' : 'All clear'}
          {needsAttention
            ? <span className="badge warn">{reachableAttention.length}</span>
            : <span className="dot-live" aria-hidden="true" />}
        </header>
        <div className="body">
          {needsAttention ? (
            <div className="chips">
              {reachableAttention.map((a, i) => (
                <Link key={i} className="chip" href={a.href}>{a.text} →</Link>
              ))}
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>Nothing is waiting on you right now.</p>
          )}
        </div>
      </section>

      {SECTIONS.map((s) => {
        const tiles = s.tiles.filter(visible);
        if (!tiles.length) return null;
        // The coverage line belongs to the attendance tile, so it appears only when that tile does
        // and only when a register was actually expected today.
        const showCoverage = tiles.some((t) => t.key === 'todayAttendancePercent') && expected > 0;
        return (
          <section className="panel" key={s.title}>
            <header>
              <span className="ico"><Icon name={s.icon} size={18} /></span>
              {s.title}
            </header>
            <div className="body stack">
              <div className="grid">
                {tiles.map((t) => (
                  <Stat
                    key={t.key}
                    href={t.href}
                    icon={t.icon}
                    tone={toneOf(t)}
                    value={display(t)}
                    caption={t.label}
                    money={t.money}
                  />
                ))}
              </div>
              {/* The coverage sits BESIDE the percentage, never inside it. "95%" over two of
                  twenty marked registers is a reassuring lie; folding coverage in would make
                  a different one (a half-marked school is not "50% attendance"). */}
              {showCoverage && (
                <div className="statline">
                  <span>Registers marked today</span>
                  <span className={`v ${registersComplete ? 'is-ok' : 'is-warn'}`}>
                    {marked} of {expected}{registersComplete ? '' : ` · ${expected - marked} not yet`}
                  </span>
                </div>
              )}
              {/* The chart earns its place by answering what the percentage cannot: WHAT the day
                  was made of. "100%" over one marked register and sixteen blank ones is true and
                  useless — the bar shows the sixteen. */}
              {showCoverage && data?.attendanceBreakdown && (
                <RegisterBar b={data.attendanceBreakdown} />
              )}
              {/* Six months of context under the month's total: one figure says how much, the
                  trend says whether that is normal. */}
              {s.title === 'Finance' && data?.collectionsTrend?.length ? (
                <CollectionsTrend points={data.collectionsTrend} money={money} />
              ) : null}
            </div>
          </section>
        );
      })}

      {staff && canReach(me?.roles, '/staff-attendance', me?.admissionsMode) && (
        /* ⚠️ **Both classes, deliberately.** `staff-attendance.spec.ts` locates this block as a
           `.card` filtered by the text "Staff today", so dropping the class to make it a clean
           `.panel` would turn a real guard red for a purely visual reason.
           `.card` brings 24px of padding, which would inset the navy header bar from the panel's
           edges — so `.panel { padding: 0 }` lives in globals.css and the two compose. That is
           deliberately NOT an inline override here: the next `.panel.card` would hit the same
           thing, and a fix that only works at one call site is a fix that gets re-discovered. */
        <section className="panel card">
          <header>
            <span className="ico"><Icon name="calendar" size={18} /></span>
            Staff today
          </header>
          <div className="body stack">
            {staff.workingDay ? (
              <>
                <div className="grid">
                  {/* Present folds in the late arrivals — they are at work; lateness is the
                      register's business, not the headcount's. */}
                  <Stat href={`/staff-attendance?date=${staff.date}`} icon="check-circle" tone="ok"
                        value={String(staff.present + staff.late)} caption="Present" />
                  <Stat href={`/staff-attendance?date=${staff.date}`} icon="x-circle" tone={staff.absent ? 'danger' : 'info'}
                        value={String(staff.absent)} caption="Absent" />
                  <Stat href={`/staff-attendance?date=${staff.date}`} icon="leave" tone="info"
                        value={String(staff.onLeave)} caption="On leave" />
                  {/* Called out as its own tile because nothing derives absence yet: a big "not
                      marked" is the real state of the register, and folding it into "absent"
                      would be a lie about people who may well have been at work all day. */}
                  <Stat href={`/staff-attendance?date=${staff.date}`} icon="unknown" tone={staff.unmarked ? 'warn' : 'ok'}
                        value={String(staff.unmarked)} caption="Not marked" />
                </div>
                <div className="statline">
                  <span>Marked present</span>
                  <span className="v is-ok">{staff.present + staff.late} of {staff.totalStaff}</span>
                </div>
              </>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                {staff.holidayName ?? 'Weekly off'} — no register today.
              </p>
            )}
            {/* Kept on both branches so the route into the register never disappears — it was the
                whole card before, and a closed day is exactly when someone goes to check why. */}
            <Link href={`/staff-attendance?date=${staff.date}`}>Open register →</Link>
          </div>
        </section>
      )}

      {adm && (
        <section className="panel">
          <header>
            <span className="ico"><Icon name="admissions" size={18} /></span>
            Admissions
          </header>
          <div className="body stack">
            <div className="grid">
              <Stat href="/admissions" icon="inbox" tone="info" value={String(adm.totals.open)} caption="Open inquiries" />
              <Stat href="/admissions" icon="admissions-team" tone="ok" value={String(adm.admittedThisMonth)} caption="Admitted this month" />
            </div>
            <div className="statline">
              <span>Conversion rate</span>
              <span className="v is-info">{adm.conversionRate}%</span>
            </div>
          </div>
        </section>
      )}

      {empty && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            New here? Go to <b>Setup</b> to create an academic year, campus, class and section,
            then add students under <b>Students</b> — the metrics above will start filling in.
          </p>
        </div>
      )}
    </div>
  );
}
