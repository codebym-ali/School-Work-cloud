'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { tabsFor } from '@/lib/roles';
import type { AdmissionsMode } from '@/lib/roles';

/**
 * The teacher's bottom tab bar (Teacher Mobile Home Plan, M0).
 *
 * **Bottom, not a hamburger.** A drawer costs two taps and hides where you are; the top-left
 * corner is the hardest point on a phone to reach one-handed, and this is read walking between
 * rooms. The sidebar still exists — it is what the same navigation looks like on a desktop.
 *
 * Only rendered for TEACHER (operator decision, plan §7.1), and only under the phone breakpoint;
 * CSS owns that half so there is one breakpoint in the codebase rather than one here and one in
 * `globals.css` disagreeing at 719px.
 */
export function TeacherTabs({ admissionsMode, roles }: { roles: string[]; admissionsMode?: AdmissionsMode }) {
  const pathname = usePathname();
  const tabs = tabsFor(roles, admissionsMode);

  return (
    <nav className="tabbar" aria-label="Main">
      {tabs.map((t) => {
        // `/home` must match exactly: a prefix match would light it up on every route.
        const active = t.href === '/home' ? pathname === '/home' : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`tab${active ? ' active' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            <span className="tab-icon" aria-hidden="true">{t.icon}</span>
            <span className="tab-label">{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
