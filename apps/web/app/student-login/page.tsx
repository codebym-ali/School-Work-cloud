'use client';

import { useEffect } from 'react';

/**
 * Redirect stub (Front-End Instance Separation Plan, Phase 2). The parent portal moved to its own
 * app/origin (`parent.<school>.schoolworks.com`; dev `localhost:3003`). This keeps every existing
 * `/student-login` link in this app (marketing footer, the login-door chooser, the admissions portal)
 * working by bouncing to the portal. Set `NEXT_PUBLIC_PARENT_URL` per environment; Phase 4 replaces
 * these internal links with direct cross-origin ones once the deployment URLs are fixed.
 */
const PARENT_PORTAL_URL = process.env.NEXT_PUBLIC_PARENT_URL || 'http://localhost:3003';

export default function StudentLoginRedirect() {
  useEffect(() => {
    window.location.href = PARENT_PORTAL_URL;
  }, []);
  return (
    <main className="center">
      <p className="muted">Taking you to the parent portal…</p>
    </main>
  );
}
