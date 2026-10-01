'use client';

import { Icon } from '@sw/ui';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, ApiError, PROPOSAL_EVENT, type ClosureNotice, type Me } from '@sw/api-client';
import { MeContext } from '@sw/session';
import { CampusLensContext, CAMPUS_LENS_KEY } from '@sw/session';
import type { Campus } from '@sw/api-client';
import { NotificationBell } from '@school/components/notification-bell';
import { COLLAPSIBLE_GROUPS, feesHiddenFromMe, groupedNav, hasAnyRole, isFeeRoute, isSchoolWideAdmin, navItemFor, needsHomeLink, panelLabel, roleLabels, servesRoute, usesPersonalShell, MFA_REQUIRED_ROLES, type AppName } from '@sw/roles';
import { TeacherSidebarNav, TeacherTabs } from '@school/components/teacher-tabs';
import { CampusBadge } from '@school/components/campus-badge';

/**
 * `app` names the door this shell is rendering in (Front-End Instance Separation Plan, Phase 4).
 *
 * ⚠️ It exists to keep the sidebar HONEST about what this app actually mounts. The nav is built from
 * the user's roles, and the apps mount different route sets — so without this, an owner who also
 * teaches would be offered `/my-classes` on the owner door, where that route no longer exists, and
 * the link would 404. Omitting it keeps the pre-split behaviour (every reachable screen listed).
 *
 * It is NOT an access control. Authorization is enforced per request by the API regardless of host.
 */
export default function AppLayout({ children, app }: { children: React.ReactNode; app?: AppName }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [closure, setClosure] = useState<ClosureNotice['closure']>(null);
  const [ready, setReady] = useState(false);
  /** Why `me` could not be loaded, when the reason is NOT "you are signed out". See below. */
  const [meError, setMeError] = useState<string | null>(null);
  // Below 720px the sidebar becomes a slide-over drawer (CSS drives the breakpoint; this
  // only tracks open/closed, so desktop is unaffected).
  const [navOpen, setNavOpen] = useState(false);
  // Campus lens (owner with >1 campus only). Fetched here so it persists across every screen.
  const [lensCampuses, setLensCampuses] = useState<Campus[]>([]);
  const [lensCampusId, setLensCampusId] = useState<string | null>(null);
  const [approvalsPending, setApprovalsPending] = useState(0);

  // The two-step sign-in reminder strip, dismissed per viewer for 7 days. A convenience only: storage may be
  // blocked, in which case the strip simply shows (the Security badge carries the reminder either way).
  const MFA_DISMISS_KEY = 'sw.mfaStrip.dismissedUntil';
  const [mfaDismissed, setMfaDismissed] = useState(false);
  useEffect(() => {
    try { setMfaDismissed(Number(window.localStorage.getItem(MFA_DISMISS_KEY) ?? 0) > Date.now()); } catch { /* storage blocked */ }
  }, []);
  const dismissMfa = () => {
    setMfaDismissed(true);
    try { window.localStorage.setItem(MFA_DISMISS_KEY, String(Date.now() + 7 * 86400000)); } catch { /* storage blocked */ }
  };

  // Close on navigation — otherwise the drawer covers the page you just opened.
  useEffect(() => { setNavOpen(false); }, [pathname]);

  // A setup change by the Ops Admin is only a proposal until the owner approves it. The API client announces that for
  // every write; saying it once here means no screen reports "Saved" about something that has not happened yet.
  const [proposalSent, setProposalSent] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const onProposal = () => {
      setProposalSent(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setProposalSent(false), 12000);
    };
    window.addEventListener(PROPOSAL_EVENT, onProposal);
    return () => { window.removeEventListener(PROPOSAL_EVENT, onProposal); window.clearTimeout(timer); };
  }, []);

  // A sidebar click gives feedback at once: the route may take seconds to compile or load, and with no sign
  // that the click landed people click again. Cleared when the route changes, or after 10s if it never does.
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  useEffect(() => { setPendingHref(null); }, [pathname]);
  useEffect(() => {
    if (!pendingHref) return;
    const t = window.setTimeout(() => setPendingHref(null), 10000);
    return () => window.clearTimeout(t);
  }, [pendingHref]);
  const navigating = (href: string) => { if (href !== pathname) setPendingHref(href); };

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  useEffect(() => {
    api.me()
      .then((m) => { setMe(m); setMeError(null); })
      .catch((e) => {
        // 401 is the ordinary case: not signed in, so go and sign in.
        if (e instanceof ApiError && e.status === 401) { router.replace('/login'); return; }
        // ⚠️ **Everything else used to be swallowed here, and the app rendered a WHITE PAGE.**
        // `ready` flipped true, `me` stayed null, and `if (!me) return null` below returned an
        // empty document — no message, no retry, no route out. Any API outage, proxy failure or
        // dropped connection blanked the whole product for every user with no explanation, and
        // nothing logged it. A failure path that renders nothing is indistinguishable from a
        // crash, and it is the reason "the dashboard is white" was impossible to diagnose from
        // the screen.
        setMeError(e instanceof ApiError ? `The server responded with ${e.status}.` : 'The server could not be reached.');
      })
      .finally(() => setReady(true));
    // Fails silently: a closure notice is worth showing, never worth blocking the app for.
    api.staff.closureNotice().then((r) => setClosure(r.closure)).catch(() => {});
  }, [router]);

  // The lens only exists for an owner (a campus-bound user has exactly one campus and no choice).
  // Fetched once, and a previously-chosen branch is restored only if it still exists.
  useEffect(() => {
    if (!isSchoolWideAdmin(me?.roles)) return;
    api.campuses.list().then((cs) => {
      setLensCampuses(cs);
      try {
        const saved = window.localStorage.getItem(CAMPUS_LENS_KEY);
        if (saved && cs.some((c) => c.id === saved)) setLensCampusId(saved);
      } catch { /* localStorage may be unavailable; the lens just starts at All */ }
    }).catch(() => {});
  }, [me]);

  useEffect(() => {
    if (!me || !hasAnyRole(me.roles, ['OWNER_ADMIN', 'ACCOUNTANT'])) return;
    api.approvals.pendingCount().then((r) => setApprovalsPending(r.pending)).catch(() => {});
  }, [me]);

  if (!ready) return <main className="container"><p className="muted">Loading…</p></main>;
  if (!me) {
    // Reached when `me` failed for a reason other than 401 — the 401 path has already navigated
    // away, so this is always a real fault worth naming rather than a signed-out user.
    return (
      <main className="container">
        <div className="card stack" style={{ maxWidth: 520, margin: '48px auto' }}>
          <h1 style={{ margin: 0 }}>Can’t reach the server</h1>
          <p className="muted" style={{ margin: 0 }}>
            {meError ?? 'The server could not be reached.'} Your work is safe — nothing was saved or lost.
          </p>
          <div className="row" style={{ justifyContent: 'flex-start', gap: 8 }}>
            <button onClick={() => window.location.reload()}>Try again</button>
            <Link className="ghost" href="/login" style={{ textDecoration: 'none' }}>Sign in</Link>
          </div>
        </div>
      </main>
    );
  }

  // Show only the screens this role can use, grouped into sidebar categories;
  // gate the routed page centrally.
  // Curated order is the default since the Owner Dashboard Redesign (Phase 1, 2026-09-27): daily-use
  // groups first, configure-once groups (School structure, Administration) collapsed. It was the
  // B2 pilot behind ?ff=ownerHomeV2; the flag is retired.
  const nav = groupedNav(me.roles, me.admissionsMode, true, me.campusAdminSeesFees)
    .map((g) => ({ ...g, items: g.items.filter((i) => servesRoute(app, i.href, me.admissionsMode)) }))
    .filter((g) => g.items.length > 0);
  /**
   * Exactly ONE active item (Owner UX Phase 2). `pathname.startsWith(href)` lit up `/staff` on
   * `/staff-attendance` and `/students` beside anything that merely began with those letters, so the sidebar
   * could claim two places at once. The active item is the LONGEST href that matches on a segment boundary.
   */
  const activeHref = nav.flatMap((g) => g.items.map((i) => i.href))
    .filter((h) => pathname === h || pathname.startsWith(`${h}/`))
    .sort((a, b) => b.length - a.length)[0] ?? null;
  const current = navItemFor(pathname);
  const authorized = !current || (hasAnyRole(me.roles, current.roles) && !(isFeeRoute(current.href) && feesHiddenFromMe(me.roles, me.campusAdminSeesFees)));
  const needsMfa = !me.mfaEnabled && me.roles.some((r) => (MFA_REQUIRED_ROLES as readonly string[]).includes(r));
  /**
   * TEACHER only (Teacher Mobile Home Plan 7.1). `has-tabbar` lets CSS swap the drawer for the
   * tab bar at the phone breakpoint without this component knowing what that breakpoint is.
   *
   * **It now decides the sidebar too** (Teacher App Shell Plan, T0): a teacher gets the same four
   * destinations at every width — as a bottom bar under 720px, as a short sidebar above it. It
   * used to swap only the phone half, so a teacher on a laptop got the administrator's eight-link
   * menu **with no `/home` in it at all**, and could not navigate back to the screen they land on.
   *
   * ⚠️ **`usesPersonalShell`, not `usesTeacherShell`, since Phase 3** — plain staff (the office
   * assistant, the driver) get this shell too. They had no home at all, and could not be given one
   * on the admin sidebar, where `/home` is `hidden` and so renders nowhere: they would have landed
   * on a screen with no link back to it. The variable keeps its name because the CSS hook
   * (`has-tabbar`) and the components are the teacher shell's; the audience is simply wider now.
   */
  const teacherShell = usesPersonalShell(me.roles);

  // The lens: a school-wide admin (owner or ops deputy) chooses; everyone else is fixed to their own
  // campus (null for a single-campus school = "all", the same one campus). Shown only on a real choice.
  const schoolWide = isSchoolWideAdmin(me.roles);
  const canChooseCampus = schoolWide && lensCampuses.length > 1;
  const activeCampusId = schoolWide ? lensCampusId : (me.campusId ?? null);
  const setLens = (id: string | null) => {
    if (!canChooseCampus) return;
    setLensCampusId(id);
    try {
      if (id) window.localStorage.setItem(CAMPUS_LENS_KEY, id);
      else window.localStorage.removeItem(CAMPUS_LENS_KEY);
    } catch { /* non-fatal */ }
  };

  return (
    <MeContext.Provider value={me}>
      <CampusLensContext.Provider value={{ campusId: activeCampusId, campuses: lensCampuses, canChoose: canChooseCampus, setCampus: setLens }}>
      <div className={`shell${teacherShell ? ' has-tabbar' : ''}`}>
        {navOpen && (
          <button className="nav-overlay" aria-label="Close menu" onClick={() => setNavOpen(false)} />
        )}
        <aside className={`sidebar${navOpen ? ' open' : ''}${teacherShell ? ' teacher' : ''}`} id="app-nav">
          <div className="brand"><Icon name="school" size={19} /> {panelLabel(me.roles)}</div>
          {/*
            * **The brand names the PANEL; these name the PERSON** (operator, 2026-09-06).
            * A teacher who also runs admissions and HR was branded only "Teacher" — every other
            * hat she wears was invisible on every screen. Sitting in the shell's sidebar, this is
            * on the *entire* dashboard rather than on one profile page you have to go looking for.
            * Rendered above the shell switch, so the teacher panel and the admin panel both get it.
            */}
          {/* Only the hats the brand does NOT already name — an owner saw "Owner" twice, stacked (Phase 2). */}
          {roleLabels(me.roles).filter((l) => l !== panelLabel(me.roles)).length > 0 && (
            <div className="role-chips">
              {roleLabels(me.roles).filter((l) => l !== panelLabel(me.roles)).map((label) => (
                <span key={label} className="role-chip">{label}</span>
              ))}
            </div>
          )}
          {teacherShell ? (
            <TeacherSidebarNav roles={me.roles} admissionsMode={me.admissionsMode} />
          ) : (
            <>
              {/*
                * Phase 2: an Admission Controller and an HR Manager have NO `/dashboard` — it is
                * `@Roles('OWNER_ADMIN','CAMPUS_ADMIN','ACCOUNTANT')` on the API — and `/home` is
                * `hidden` in NAV, so without this entry they would land on a screen with no link
                * back to it. Shown only to people who have no dashboard of their own, so an owner
                * or accountant is never handed a second, competing front door.
                */}
              {needsHomeLink(me.roles) && servesRoute(app, '/home') && (
                <div className="nav-group">
                  <Link href="/home" className={pathname === '/home' ? 'active' : ''} aria-current={pathname === '/home' ? 'page' : undefined}>
                    <span className="nav-icon"><Icon name="home" size={18} /></span>
                    Home
                  </Link>
                </div>
              )}
              {nav.map(({ group, items }) => {
                const links = items.map((n) => (
                  <Link key={n.href} href={n.href} onClick={() => navigating(n.href)}
                    className={(pendingHref ?? activeHref) === n.href ? 'active' : ''} aria-current={n.href === activeHref ? 'page' : undefined}
                    aria-busy={pendingHref === n.href || undefined}>
                    <span className="nav-icon"><Icon name={n.icon} size={18} /></span>
                    {n.label}
                    {n.href === '/approvals' && approvalsPending > 0 && (
                      <span className="badge warn" style={{ marginLeft: 'auto', fontSize: 11 }}>{approvalsPending}</span>
                    )}
                  </Link>
                ));
                // Configure-once groups collapse to cut the wall of links. They open automatically
                // when the current page lives inside them, so you always see where you are.
                if (COLLAPSIBLE_GROUPS.includes(group)) {
                  const activeInGroup = items.some((n) => n.href === activeHref);
                  return (
                    <details key={group} className="nav-group nav-group--collapsible" open={activeInGroup || undefined}>
                      <summary className="group-label">{group}</summary>
                      {links}
                    </details>
                  );
                }
                return (
                  <div key={group} className="nav-group">
                    <div className="group-label">{group}</div>
                    {links}
                  </div>
                );
              })}
            </>
          )}
        </aside>
        <div className="content">
          {pendingHref && (
            <>
              <style>{'@keyframes sw-nav-progress{from{transform:scaleX(0)}to{transform:scaleX(.92)}}'}</style>
              <div role="progressbar" aria-label="Loading page"
                style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 3, background: 'var(--brand, #2563eb)', zIndex: 100, transformOrigin: 'left', animation: 'sw-nav-progress 8s cubic-bezier(.1,.6,.2,1) forwards' }} />
            </>
          )}
          <div className="topbar">
            <button
              className="nav-toggle"
              aria-label="Open menu"
              aria-expanded={navOpen}
              aria-controls="app-nav"
              onClick={() => setNavOpen(true)}
            >
              <Icon name="menu" size={20} />
            </button>
            {canChooseCampus && (
              <label className="campus-lens" title="Which campus you are viewing">
                <Icon name="campuses" size={15} />
                <select aria-label="Campus" value={activeCampusId ?? ''} onChange={(e) => setLens(e.target.value || null)}>
                  <option value="">All campuses</option>
                  {lensCampuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}
            <CampusBadge />
            {/* The PERSON, as colleagues say it: "Muhammad Ali · Owner". The email is a login, not a name —
                kept in the tooltip for the rare "which account am I in?" (Phase 2). */}
            <div className="who topbar-desktop" title={me.email}>
              {/* No name on record (an owner has no staff profile) → the role alone, never the login email. */}
              {me.name?.trim() ? <><strong>{me.name.trim()}</strong> · {roleLabels(me.roles).join(' · ')}</> : <strong>{roleLabels(me.roles).join(' · ')}</strong>}
            </div>
            <div className="row" style={{ gap: 8 }}>
              {/* Beside Security, not on a dashboard — see the note on the closure banner below.
                  Renders nothing at all when there is nothing to say. */}
              <NotificationBell />
              {/* Hidden in the phone shell: identity, Security and Sign out all live under the
                  Me tab there, and repeating them costs ~50px of an 812px screen. The bell stays —
                  it is the one thing in this bar that is time-sensitive. */}
              <Link className="ghost small topbar-desktop security-link" href="/security" style={{ textDecoration: 'none' }}
                aria-label={needsMfa ? 'Security — two-step sign-in not set up' : 'Security'}>
                <Icon name="lock" size={15} /> Security
                {needsMfa && <span className="badge-dot" aria-hidden />}
              </Link>
              <button className="ghost small topbar-desktop" onClick={async () => { await api.logout().catch(() => {}); router.replace('/login'); }}>
                Sign out
              </button>
            </div>
          </div>
          {/*
            * The closure notice lives HERE, in the shell, and not on a dashboard — because
            * teachers do not have one. `/dashboard` is owner/campus-admin/accountant only; a
            * teacher lands on /attendance, staff on /my-attendance, a student on /me. A banner
            * hung on a dashboard would miss exactly the people who need to know the gate is
            * locked. The shell wraps every page for every role, so one place reaches all of them.
            *
            * Shown only for today or tomorrow (the API decides). A closure three weeks out
            * belongs on the calendar; a banner that is always there stops being read.
            */}
          {proposalSent && (
            <div className="toast ok" role="status">
              <Icon name="inbox" size={17} /> <strong>Sent to the owner for approval.</strong>{' '}
              This change takes effect once the owner approves it — you can follow it on{' '}
              <Link href="/approvals">Approvals</Link>.
            </div>
          )}
          {closure && (
            <div className="toast warn" role="status">
              <Icon name="alert" size={17} /> <strong>School {closure.when === 'TODAY' ? 'is closed today' : 'is closed tomorrow'} — {closure.name}.</strong>{' '}
              No classes, and no attendance is taken.
            </div>
          )}
          {/* ⚠️ Until 2026-09-16 this said "required" while nothing enforced it. It is enforced now
              (MfaEnrolledGuard), so the banner names what is actually locked — a warning that states
              a real consequence is read; one that could be ignored forever teaches people to ignore
              red. Routine work is deliberately NOT in the list, because it is not locked. */}
          {/* Not on /dashboard: there it is a row in "Needs your attention", with its own button —
              one reminder in the place the owner acts, not the same sentence twice on one screen. */}
          {/* Phase 2: a SLIM strip, dismissible for 7 days — the full paragraph on every page was the
              loudest thing on screen and pushed the page's own content down. The badge on Security keeps
              the reminder alive while the strip is dismissed. */}
          {needsMfa && !mfaDismissed && pathname !== '/security' && pathname !== '/dashboard' && (
            <div className="mfa-strip" role="status">
              <Icon name="lock" size={15} />
              <span><strong>Turn on two-step sign-in</strong> to unlock refunds, waivers, salary approval and ID numbers.</span>
              <Link href="/security">Set it up</Link>
              <button type="button" className="mfa-strip-close" aria-label="Dismiss for 7 days" onClick={dismissMfa}>×</button>
            </div>
          )}
          {authorized ? children : (
            <div className="card stack">
              <h1>Not authorized</h1>
              <p className="muted">Your role ({roleLabels(me.roles).join(', ')}) doesn’t have access to this screen.</p>
            </div>
          )}
        </div>
        {/* Outside `.content` so it is fixed to the viewport rather than to a scrolling column. */}
        {teacherShell && <TeacherTabs roles={me.roles} admissionsMode={me.admissionsMode} />}
      </div>
      </CampusLensContext.Provider>
    </MeContext.Provider>
  );
}
