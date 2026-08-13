'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { EmailPasswordSignIn } from '@/components/email-password-signin';

// Demo credentials are pre-filled ONLY in `next dev`; production builds ship empty fields.
// ⚠️ **Move this at O2.** `owner@demo.pk` is an OWNER_ADMIN, and O2 closes the staff door to
// owners — at which point this prefill hands every developer the one credential guaranteed to be
// refused here. It becomes a staff account, or it moves to `/owner-login`.
const IS_DEV = process.env.NODE_ENV === 'development';

/**
 * The staff door — campus admins, teachers, accountants, admission officers, HR and staff.
 * The school owner has their own (`/owner-login`); students have theirs (`/student-login`).
 */
export default function LoginPage() {
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
      prefill={IS_DEV ? { email: 'owner@demo.pk', password: 'Owner!Secret12' } : undefined}
      footer={
        <>
          {/* Every sign-in page names the others. The student portal was fully built and reachable
              only by typing its URL from memory — nothing in the app linked to it. */}
          <p className="muted" style={{ margin: 0, fontSize: 13, textAlign: 'center' }}>
            Student? <Link href="/student-login">Sign in with your registration number →</Link>
          </p>
          {/* ⚠️ The owner's door is LINKED, not hidden. Obscurity buys nothing here — the route
              ships in the JS bundle either way — and an owner who cannot find their own entrance
              telephones support on a Sunday. */}
          <p className="muted" style={{ margin: 0, fontSize: 13, textAlign: 'center' }}>
            School owner? <Link href="/owner-login">Sign in here →</Link>
          </p>
        </>
      }
    />
  );
}
