'use client';

import { useEffect, useState } from 'react';
import { api } from '@sw/api-client';
import { EmailPasswordSignIn } from '@school/components/email-password-signin';

/**
 * The staff door (Owner Login Plan) — on the Staff app's own origin. `api.login` hits `/auth/login`,
 * which refuses the owner byte-identically to a wrong password (owners use the Owner app). A
 * `?campus=<name>` query only brands the page; auth is school-wide and the user is campus-scoped
 * after sign-in. `EmailPasswordSignIn` performs the post-login redirect.
 */
export default function StaffLoginPage() {
  const [campus, setCampus] = useState<string | null>(null);
  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get('campus');
    if (c) setCampus(c);
  }, []);

  return (
    <EmailPasswordSignIn
      title="Sign in"
      subtitle={campus ?? 'School Management'}
      signIn={api.login}
    />
  );
}
