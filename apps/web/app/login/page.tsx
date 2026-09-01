'use client';

import { useEffect, useState } from 'react';
import { APP_URLS } from '@/lib/app-urls';

/**
 * The chooser — three doors, one neutral landing.
 *
 * ⚠️ **This page exists because `/login` cannot itself be a door.** It is the redirect target for
 * every 401 and every logout (`(app)/layout`, `me-more`, the root page) and for the per-campus
 * links (`/login?campus=<name>`). At the moment it is reached the visitor is **signed out**, so
 * nothing knows their role — and since O2 the doors are mutually exclusive, so whichever form sat
 * here would refuse somebody on every session expiry. The concrete case: a signed-out owner bounced
 * onto the staff form, refused, by a message that deliberately explains nothing.
 *
 * So `/login` names the options and lets the person pick. Everything that redirects here keeps
 * working, and no bookmark or campus link breaks.
 */
// Each door lives on its own app/origin now (Phase 4), so these are cross-origin links to the
// deployed sign-in pages (dev: the local ports). The chooser stays on the apex marketing app.
const DOORS = [
  {
    href: `${APP_URLS.staff}/login`,
    icon: '🏫',
    title: 'School staff',
    detail: 'Campus admins, teachers, accountants, admissions and office staff. Sign in with your email.',
    carriesCampus: true,
  },
  {
    href: `${APP_URLS.owner}/login`,
    icon: '🔑',
    title: 'School owner',
    detail: 'The owner of the school. Sign in with your email.',
    carriesCampus: false,
  },
  {
    href: `${APP_URLS.student}/login`,
    icon: '🎒',
    title: 'Student',
    detail: 'Sign in with your registration number and CNIC / B-Form.',
    carriesCampus: false,
  },
] as const;

export default function LoginChooserPage() {
  const [campus, setCampus] = useState<string | null>(null);

  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get('campus');
    if (c) setCampus(c);
  }, []);

  return (
    <main className="center">
      <div className="card stack" style={{ width: 420 }}>
        <div>
          <h1>Sign in</h1>
          <p className="sub">{campus ?? 'School Management'}</p>
        </div>

        {DOORS.map((d) => (
          <a
            key={d.href}
            /* The campus name brands the staff page only. An owner belongs to no campus
               (`restrictedCampusId()` returns null for them) and a student signs in with a
               registration number, so carrying it further would be meaningless. */
            href={d.carriesCampus && campus ? `${d.href}?campus=${encodeURIComponent(campus)}` : d.href}
            className="card"
            style={{ display: 'block', textDecoration: 'none', padding: '12px 14px' }}
          >
            <strong>{d.icon} {d.title} →</strong>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>{d.detail}</p>
          </a>
        ))}
      </div>
    </main>
  );
}
