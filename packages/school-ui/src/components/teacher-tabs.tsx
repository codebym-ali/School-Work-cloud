'use client';

import { Icon } from '@sw/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { tabsFor, teacherSidebarNav } from '@sw/roles';
import type { AdmissionsMode } from '@sw/roles';

/**
 * The teacher's navigation — **one list, two renderings** (Teacher App Shell Plan, T0).
 *
 * **Role decides the shell; width decides only the layout.** A teacher's device does not change
 * what a teacher's job is, so both renderings read the same `tabsFor()` list in the same order with
 * the same words: a teacher who learns this on their phone already knows it on a laptop.
 *
 * ⚠️ **This exists because the two used to disagree.** The phone had four destinations; the desktop
 * had the admin sidebar's eight in three groups, called things like "MY PORTAL", and **`/home` was
 * not among them** — it is `hidden: true` in `NAV` so the tab bar could own it, which stranded it
 * above 720px. A teacher landed on Home, clicked anything, and could only get back with the
 * browser's back button.
 *
 * **Bottom, not a hamburger, on a phone.** A drawer costs two taps and hides where you are; the
 * top-left corner is the hardest point to reach one-handed, and this is read walking between rooms.
 *
 * **Four stay four on the desktop.** The temptation is to hoist the secondary screens into the
 * sidebar because a laptop has room — resisted, because the phone's structure *is* the product's
 * structure, and spare pixels are a reason to make things bigger, not to invent a second
 * information architecture. Everything else stays behind **Me**, exactly as on the phone.
 */

/** `/home` must match exactly: a prefix match would light it up on every route. */
function isActive(pathname: string, href: string): boolean {
  return href === '/home' ? pathname === '/home' : pathname.startsWith(href);
}

interface Props {
  roles: string[];
  admissionsMode?: AdmissionsMode;
}

/** The phone bar. Fixed to the bottom of the viewport; CSS reveals it under 720px. */
export function TeacherTabs({ admissionsMode, roles }: Props) {
  const pathname = usePathname();

  return (
    <nav className="tabbar" aria-label="Main">
      {tabsFor(roles, admissionsMode).map((t) => {
        const active = isActive(pathname, t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`tab${active ? ' active' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            <span className="tab-icon"><Icon name={t.icon} size={22} /></span>
            <span className="tab-label">{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The teacher's desktop left panel — the FULL list of their screens, with **Profile pinned to the
 * bottom** (Teacher panel change, operator 2026-09-01).
 *
 * ⚠️ **This replaces the old four-item stub + "More".** The panel used to mirror the phone's four
 * tabs and hide everything else behind a "More" page; the operator asked for the complete list here
 * instead. So the body renders `teacherSidebarNav` (every screen the teacher may reach, a projection
 * of `NAV` — still not a hand-kept second list) and the footer pins a single **Profile** link, from
 * which the teacher sees their own details and reaches Security / Sign out.
 *
 * Still deliberately NOT the grouped admin nav ("ACADEMICS / ADMINISTRATION" is an admin's filing
 * system for a teacher's own things): one flat list, no group labels. The **phone** keeps its
 * four-item bottom bar (`TeacherTabs`) with "More" as the overflow — a phone bar cannot carry the
 * full list — so nothing a teacher can reach on a laptop becomes unreachable on a phone.
 */
export function TeacherSidebarNav({ admissionsMode, roles }: Props) {
  const pathname = usePathname();
  const profileActive = pathname.startsWith('/profile');

  return (
    <div className="teacher-nav">
      <div className="nav-group">
        {teacherSidebarNav(roles, admissionsMode).map((t) => {
          const active = isActive(pathname, t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={active ? 'active' : ''}
              aria-current={active ? 'page' : undefined}
            >
              <span className="nav-icon"><Icon name={t.icon} size={18} /></span>
              {t.label}
            </Link>
          );
        })}
      </div>

      <div className="nav-group teacher-profile">
        <Link
          href="/profile"
          className={profileActive ? 'active' : ''}
          aria-current={profileActive ? 'page' : undefined}
        >
          <span className="nav-icon"><Icon name="profile" size={18} /></span>
          Profile
        </Link>
      </div>
    </div>
  );
}
