'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@sw/api-client';
import { landingPath } from '@sw/roles';

/**
 * The Staff app's front door.
 *
 * ⚠️ **This route did not exist, and the bare origin 404'd.** staff-web is mounted entirely under
 * the `(app)` group plus `/login`, so nothing answered `/` — meaning
 * `staff.<school>.schoolworks.com` returned "This page could not be found" in production, and an
 * installed PWA (whose `start_url` is `/`) would have opened straight onto that 404. It was invisible
 * because every link in the product is deep: you only meet it by typing the domain, which is exactly
 * what someone does with a new app.
 *
 * It resolves to the person rather than to a fixed screen, because this one app serves ops, campus
 * admins, accountants, HR, admission officers, teachers and staff — and they do not share a landing
 * page. `landingPath` is the same rule the sign-in form uses, so the front door and the door after
 * login can never disagree.
 *
 * Signed out is not an error here: `api.me()` 401s and we send them to the staff door.
 */
export default function StaffRoot() {
  const router = useRouter();

  useEffect(() => {
    api.me()
      .then((me) => router.replace(landingPath(me.roles)))
      .catch(() => router.replace('/login'));
  }, [router]);

  // Deliberately quiet: this is a redirect, and anything louder would flash on every cold start of
  // the installed app.
  return (
    <main className="container">
      <p className="muted">Loading…</p>
    </main>
  );
}
