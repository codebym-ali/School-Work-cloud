'use client';

import { useEffect } from 'react';

/**
 * Redirect stub (Front-End Instance Separation Plan, Phase 2). The student portal moved to its own
 * app/origin (`student.<school>.schoolworks.com`; dev `localhost:3003`). This keeps every existing
 * `/student-login` link in this app (marketing footer, the login-door chooser, the admissions portal)
 * working by bouncing to the portal. Set `NEXT_PUBLIC_STUDENT_URL` per environment; Phase 4 replaces
 * these internal links with direct cross-origin ones once the deployment URLs are fixed.
 */
const STUDENT_PORTAL_URL = process.env.NEXT_PUBLIC_STUDENT_URL || 'http://localhost:3003';

export default function StudentLoginRedirect() {
  useEffect(() => {
    window.location.href = STUDENT_PORTAL_URL;
  }, []);
  return (
    <main className="center">
      <p className="muted">Taking you to the student portal…</p>
    </main>
  );
}
