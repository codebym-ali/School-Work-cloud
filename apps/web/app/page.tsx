'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { landingPath } from '@/lib/roles';

/**
 * Root entry point. Sends each signed-in user to the landing screen their role can actually
 * open (owners/campus admins → /dashboard, a teacher → /attendance, a parent → /parent, …).
 * A fixed redirect to /dashboard dead-ended every non-admin on the "Not authorized" screen.
 * Not signed in → /login.
 */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    api.me()
      .then((me) => router.replace(landingPath(me.roles)))
      .catch((e) => router.replace(e instanceof ApiError && e.status === 401 ? '/login' : '/dashboard'));
  }, [router]);

  return <main className="container"><p className="muted">Loading…</p></main>;
}
