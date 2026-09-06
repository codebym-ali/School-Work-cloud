'use client';

import { Icon } from '@sw/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@sw/api-client';
import { useMe } from '@sw/session';
import { groupedNav } from '@sw/roles';

/**
 * The "More" tab (Teacher Mobile Home Plan M0; renamed from "Me" in Teacher App Shell Plan T1,
 * because for a teacher who also keeps the books it holds Dashboard, Fees and Reports).
 *
 * The tab bar holds four things; this is where the rest lives. Leaves, payslips, exams, the school
 * calendar and my own attendance are visited monthly, not hourly, so they do not deserve a
 * permanent slot at thumb height — but they must still be *findable*, which on a phone means one
 * obvious list rather than a hamburger nobody opens.
 *
 * **Built from `groupedNav`, the same function the sidebar uses.** Writing the list out by hand
 * here would make it a second nav, and a second nav is how a screen quietly disappears for a role
 * that is still allowed to use it — the failure that removed CSV import, `/my-attendance` and
 * `/my-leaves` in turn. Anything already in the tab bar is filtered out so it is not offered twice.
 */
const IN_TAB_BAR = ['/home', '/attendance', '/my-timetable', '/me-more'];

export default function MePage() {
  const me = useMe();
  const router = useRouter();
  const groups = groupedNav(me?.roles, me?.admissionsMode)
    .map((g) => ({ ...g, items: g.items.filter((i) => !IN_TAB_BAR.includes(i.href)) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="stack">
      <div>
        <h1 style={{ marginBottom: 2 }}>More</h1>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{me?.email}</p>
      </div>

      {groups.map(({ group, items }) => (
        <div key={group} className="card">
          <div className="section-title">{group}</div>
          <ul className="day-rail">
            {items.map((n) => (
              <li key={n.href} style={{ gridTemplateColumns: '26px 1fr', alignItems: 'center' }}>
                <Icon name={n.icon} size={18} />
                <Link href={n.href} style={{ color: 'inherit', textDecoration: 'none', minHeight: 44, display: 'flex', alignItems: 'center' }}>
                  <span className="what">{n.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}

      <div className="card">
        <div className="section-title">Account</div>
        <ul className="day-rail">
          {/* Profile is pinned to the desktop panel's footer; on the phone the panel is this list,
              so it lives here in Account alongside Security. */}
          <li style={{ gridTemplateColumns: '26px 1fr', alignItems: 'center' }}>
            <Icon name="profile" size={18} />
            <Link href="/profile" style={{ color: 'inherit', textDecoration: 'none', minHeight: 44, display: 'flex', alignItems: 'center' }}>
              <span className="what">Profile</span>
            </Link>
          </li>
          <li style={{ gridTemplateColumns: '26px 1fr', alignItems: 'center' }}>
            <span aria-hidden="true" style={{ fontSize: 17 }}>🔒</span>
            <Link href="/security" style={{ color: 'inherit', textDecoration: 'none', minHeight: 44, display: 'flex', alignItems: 'center' }}>
              <span className="what">Security</span>
            </Link>
          </li>
        </ul>
        <button
          className="ghost"
          style={{ width: '100%', minHeight: 48, marginTop: 8 }}
          onClick={async () => { await api.logout().catch(() => {}); router.replace('/login'); }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
