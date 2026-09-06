'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Icon } from '@sw/ui';
import { api, type Campus } from '@sw/api-client';
import { useMe } from '@sw/session';
import { roleLabels, selfServiceNav } from '@sw/roles';

/**
 * The teacher's (and any user's) read-only **Profile** — reached from the panel footer / top bar
 * (Teacher panel change, operator 2026-09-01).
 *
 * ⚠️ **Read-only, and adds no new capability.** The operator asked only for a place to *see* the
 * details related to them; nothing here writes. It shows what the session already exposes
 * (`/auth/me`) plus the campus name (a read a teacher is allowed), and keeps the two existing
 * self-service actions — **Security** (password / two-factor) and **Sign out** — so nothing a
 * teacher could do before is lost now that "More" is gone from the desktop panel. Richer HR fields
 * (designation, employee code, join date) would need a small read-only self endpoint, which is
 * deliberately NOT added here.
 *
 * ⚠️ **It is also the home of her own records now** (operator, 2026-09-06): My Attendance, My
 * Timetable, My Leaves and My Payslips moved out of the left panel into **My records** below, so the
 * panel carries the school's work and this page carries the employee. The list is
 * `selfServiceNav()` — a projection of `NAV`'s `My Portal` group — so it can never disagree with
 * what she is allowed to open, and a screen added to that group appears here on its own.
 */
export default function ProfilePage() {
  const me = useMe();
  const router = useRouter();
  const [campus, setCampus] = useState<string | null>(null);
  const mine = selfServiceNav(me?.roles, me?.admissionsMode);

  useEffect(() => {
    if (!me?.campusId) return;
    let alive = true;
    api.campuses
      .list()
      .then((cs: Campus[]) => { if (alive) setCampus(cs.find((c) => c.id === me.campusId)?.name ?? null); })
      .catch(() => { /* campus name is a nicety — a UUID is never shown, the row just omits */ });
    return () => { alive = false; };
  }, [me?.campusId]);

  if (!me) return null;

  const rows: { label: string; value: string }[] = [
    { label: 'Email', value: me.email },
    // Every hat, not just the primary one — the same list the sidebar chips show.
    { label: roleLabels(me.roles).length > 1 ? 'Roles' : 'Role', value: roleLabels(me.roles).join(' · ') },
    ...(campus ? [{ label: 'Campus', value: campus }] : []),
    { label: 'Two-factor', value: me.mfaEnabled ? 'On' : 'Off' },
  ];

  return (
    <div className="stack">
      <div>
        <h1 style={{ marginBottom: 2 }}>Profile</h1>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>Your account details.</p>
      </div>

      <div className="card">
        <div className="section-title">Your details</div>
        <div style={{ display: 'grid', gap: 2 }}>
          {rows.map((r) => (
            <div
              key={r.label}
              style={{
                display: 'flex', justifyContent: 'space-between', gap: 16,
                alignItems: 'baseline', padding: '10px 0', minHeight: 24,
                borderBottom: '1px solid rgb(148 163 184 / .18)',
              }}
            >
              <span className="muted" style={{ fontSize: 13 }}>{r.label}</span>
              <strong style={{ textAlign: 'right', wordBreak: 'break-word' }}>{r.value}</strong>
            </div>
          ))}
        </div>
      </div>

      {/* Rendered only when she has any — an owner or accountant opening this page has no
          `My Portal` screens, and an empty card headed "My records" would read as a fault. */}
      {mine.length > 0 && (
        <div className="card">
          <div className="section-title">My records</div>
          <ul className="day-rail">
            {mine.map((n) => (
              <li key={n.href} style={{ gridTemplateColumns: '26px 1fr', alignItems: 'center' }}>
                <Icon name={n.icon} size={18} />
                <Link
                  href={n.href}
                  style={{ color: 'inherit', textDecoration: 'none', minHeight: 44, display: 'flex', alignItems: 'center' }}
                >
                  <span className="what">{n.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <div className="section-title">Account</div>
        <ul className="day-rail">
          <li style={{ gridTemplateColumns: '26px 1fr', alignItems: 'center' }}>
            <span aria-hidden="true" style={{ fontSize: 17 }}>🔒</span>
            <Link
              href="/security"
              style={{ color: 'inherit', textDecoration: 'none', minHeight: 44, display: 'flex', alignItems: 'center' }}
            >
              <span className="what">Security — password &amp; two-factor</span>
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
