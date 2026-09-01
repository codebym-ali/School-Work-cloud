'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { EmailPasswordSignIn } from '@school/components/email-password-signin';

/**
 * The staff door — campus admins, teachers, accountants, admission officers, HR and general staff.
 * The school owner has their own (`/owner-login`); students have theirs (`/student-login`).
 *
 * ⚠️ **This used to live at `/login`, and moving it is why `/login` still exists.** That path is the
 * redirect target for every 401 and every logout, and nothing knows the visitor's role at that
 * point — they are signed out. Leaving the staff form there would bounce a signed-out OWNER onto a
 * door that refuses them, on every session expiry. `/login` is now a chooser instead.
 *
 * No demo prefill here: the account that used to be filled in was `owner@demo.pk`, an `OWNER_ADMIN`
 * and therefore the one credential this door refuses. It lives on `/owner-login` now.
 */
export default function StaffLoginPage() {
  const [campus, setCampus] = useState<string | null>(null);

  // A per-campus login link (?campus=<name>) just brands this page; auth is the same for
  // the whole school — the user is scoped to their campus after they sign in.
  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get('campus');
    if (c) setCampus(c);
  }, []);

  return (
    <EmailPasswordSignIn
      title="Sign in"
      subtitle={campus ?? 'School Management'}
      signIn={api.login}
      footer={
        <p className="muted" style={{ margin: 0, fontSize: 13, textAlign: 'center' }}>
          Not staff? <Link href="/login">See the other sign-in options →</Link>
        </p>
      }
    />
  );
}
