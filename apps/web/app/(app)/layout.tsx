'use client';

import { Icon } from '@/components/icon';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, ApiError, type ClosureNotice, type Me } from '@/lib/api';
import { MeContext } from '@/lib/me-context';
import { CampusLensContext, CAMPUS_LENS_KEY } from '@/lib/campus-lens';
import type { Campus } from '@/lib/api';
import { NotificationBell } from '@/components/notification-bell';
import { groupedNav, hasAnyRole, isSchoolWideAdmin, navItemFor, panelLabel, usesTeacherShell, MFA_REQUIRED_ROLES } from '@/lib/roles';
import { TeacherSidebarNav, TeacherTabs } from '@/components/teacher-tabs';

export default function AppLayout({ children }: { children: React.ReactNode }) {
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

  // Close on navigation — otherwise the drawer covers the page you just opened.
  useEffect(() => { setNavOpen(false); }, [pathname]);

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
  const nav = groupedNav(me.roles, me.admissionsMode);
  const current = navItemFor(pathname);
  const authorized = !current || hasAnyRole(me.roles, current.roles);
  const needsMfa = !me.mfaEnabled && me.roles.some((r) => (MFA_REQUIRED_ROLES as readonly string[]).includes(r));
  /**
   * TEACHER only (Teacher Mobile Home Plan 7.1). `has-tabbar` lets CSS swap the drawer for the
   * tab bar at the phone breakpoint without this component knowing what that breakpoint is.
   *
   * **It now decides the sidebar too** (Teacher App Shell Plan, T0): a teacher gets the same four
   * destinations at every width — as a bottom bar under 720px, as a short sidebar above it. It
   * used to swap only the phone half, so a teacher on a laptop got the administrator's eight-link
   * menu **with no `/home` in it at all**, and could not navigate back to the screen they land on.
   */
  const teacherShell = usesTeacherShell(me.roles);

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
        <aside className={`sidebar${navOpen ? ' open' : ''}`} id="app-nav">
          <div className="brand"><Icon name="school" size={19} /> {panelLabel(me.roles)}</div>
          {teacherShell ? (
            <TeacherSidebarNav roles={me.roles} admissionsMode={me.admissionsMode} />
          ) : (
            nav.map(({ group, items }) => (
              <div key={group} className="nav-group">
                <div className="group-label">{group}</div>
                {items.map((n) => (
                  <Link key={n.href} href={n.href} className={pathname.startsWith(n.href) ? 'active' : ''}>
                    <span className="nav-icon"><Icon name={n.icon} size={18} /></span>
                    {n.label}
                  </Link>
                ))}
              </div>
            ))
          )}
        </aside>
        <div className="content">
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
            <div className="who topbar-desktop">{me.email} · {me.roles.join(', ')}</div>
            <div className="row" style={{ gap: 8 }}>
              {/* Beside Security, not on a dashboard — see the note on the closure banner below.
                  Renders nothing at all when there is nothing to say. */}
              <NotificationBell />
              {/* Hidden in the phone shell: identity, Security and Sign out all live under the
                  Me tab there, and repeating them costs ~50px of an 812px screen. The bell stays —
                  it is the one thing in this bar that is time-sensitive. */}
              <Link className="ghost small topbar-desktop" href="/security" style={{ textDecoration: 'none' }}><Icon name="lock" size={15} /> Security</Link>
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
          {closure && (
            <div className="toast warn" role="status">
              <Icon name="alert" size={17} /> <strong>School {closure.when === 'TODAY' ? 'is closed today' : 'is closed tomorrow'} — {closure.name}.</strong>{' '}
              No classes, and no attendance is taken.
            </div>
          )}
          {needsMfa && pathname !== '/security' && (
            <div className="toast err">
              Two-factor authentication is required for your role and isn&apos;t set up yet.{' '}
              <Link href="/security" style={{ fontWeight: 600 }}>Set it up →</Link>
            </div>
          )}
          {authorized ? children : (
            <div className="card stack">
              <h1>Not authorized</h1>
              <p className="muted">Your role ({me.roles.join(', ')}) doesn’t have access to this screen.</p>
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
