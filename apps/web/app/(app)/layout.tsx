'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, ApiError, type ClosureNotice, type Me } from '@/lib/api';
import { MeContext } from '@/lib/me-context';
import { NotificationBell } from '@/components/notification-bell';
import { groupedNav, hasAnyRole, navItemFor, panelLabel, usesTeacherShell, MFA_REQUIRED_ROLES } from '@/lib/roles';
import { TeacherSidebarNav, TeacherTabs } from '@/components/teacher-tabs';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [closure, setClosure] = useState<ClosureNotice['closure']>(null);
  const [ready, setReady] = useState(false);
  // Below 720px the sidebar becomes a slide-over drawer (CSS drives the breakpoint; this
  // only tracks open/closed, so desktop is unaffected).
  const [navOpen, setNavOpen] = useState(false);

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
      .then(setMe)
      .catch((e) => { if (e instanceof ApiError && e.status === 401) router.replace('/login'); })
      .finally(() => setReady(true));
    // Fails silently: a closure notice is worth showing, never worth blocking the app for.
    api.staff.closureNotice().then((r) => setClosure(r.closure)).catch(() => {});
  }, [router]);

  if (!ready) return <main className="container"><p className="muted">Loading…</p></main>;
  if (!me) return null;

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

  return (
    <MeContext.Provider value={me}>
      <div className={`shell${teacherShell ? ' has-tabbar' : ''}`}>
        {navOpen && (
          <button className="nav-overlay" aria-label="Close menu" onClick={() => setNavOpen(false)} />
        )}
        <aside className={`sidebar${navOpen ? ' open' : ''}`} id="app-nav">
          <div className="brand">🏫 {panelLabel(me.roles)}</div>
          {teacherShell ? (
            <TeacherSidebarNav roles={me.roles} admissionsMode={me.admissionsMode} />
          ) : (
            nav.map(({ group, items }) => (
              <div key={group} className="nav-group">
                <div className="group-label">{group}</div>
                {items.map((n) => (
                  <Link key={n.href} href={n.href} className={pathname.startsWith(n.href) ? 'active' : ''}>
                    <span className="nav-icon" aria-hidden="true">{n.icon}</span>
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
              ☰
            </button>
            <div className="who topbar-desktop">{me.email} · {me.roles.join(', ')}</div>
            <div className="row" style={{ gap: 8 }}>
              {/* Beside Security, not on a dashboard — see the note on the closure banner below.
                  Renders nothing at all when there is nothing to say. */}
              <NotificationBell />
              {/* Hidden in the phone shell: identity, Security and Sign out all live under the
                  Me tab there, and repeating them costs ~50px of an 812px screen. The bell stays —
                  it is the one thing in this bar that is time-sensitive. */}
              <Link className="ghost small topbar-desktop" href="/security" style={{ textDecoration: 'none' }}>🔒 Security</Link>
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
              🔴 <strong>School {closure.when === 'TODAY' ? 'is closed today' : 'is closed tomorrow'} — {closure.name}.</strong>{' '}
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
    </MeContext.Provider>
  );
}
