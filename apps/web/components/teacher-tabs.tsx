'use client';

import { Icon } from '@/components/icon';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { tabsFor } from '@/lib/roles';
import type { AdmissionsMode } from '@/lib/roles';

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
 * The same destinations as a sidebar, for a teacher on anything wider than a phone.
 *
 * Deliberately NOT the grouped admin nav: a teacher is not an administrator with a smaller menu,
 * and "ACADEMICS / ADMINISTRATION / MY PORTAL" is an admin's filing system for a teacher's own
 * things. Four items need no grouping.
 */
export function TeacherSidebarNav({ admissionsMode, roles }: Props) {
  const pathname = usePathname();

  return (
    <div className="nav-group">
      {tabsFor(roles, admissionsMode).map((t) => {
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
  );
}
