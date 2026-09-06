'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@sw/api-client';
import { landingPath } from '@sw/roles';

/**
 * The Owner app's front door.
 *
 * ⚠️ **This route did not exist, and the bare origin 404'd** — the same gap found in `staff-web`
 * while restoring PWA installability. owner-web is mounted entirely under the `(app)` group plus
 * `/login`, so nothing answered `/`, and `owner.<school>.schoolworks.com` returned "This page could
 * not be found" in production. It stayed invisible because every link in the product is deep: you
 * only meet the bare origin by typing the domain, which is exactly what an owner does when someone
 * tells them "your school is at owner.greenwood.schoolworks.com".
 *
 * It resolves to the person rather than to a fixed screen. In practice that is `/dashboard` for an
 * owner, but this app also serves the Ops deputy and anyone else who signs in at the owner door, and
 * `landingPath` is the same rule the sign-in form uses — so the front door and the door after login
 * cannot disagree about where you belong.
 *
 * Signed out is not an error here: `api.me()` 401s and we send them to the owner door.
 */
export default function OwnerRoot() {
  const router = useRouter();

  useEffect(() => {
    api.me()
      .then((me) => router.replace(landingPath(me.roles)))
      .catch(() => router.replace('/login'));
  }, [router]);

  // Deliberately quiet: this is a redirect, and anything louder would flash on every cold start.
  return (
    <main className="container">
      <p className="muted">Loading…</p>
    </main>
  );
}
