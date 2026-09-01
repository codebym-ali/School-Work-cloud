'use client';

import { api } from '@sw/api-client';
import { EmailPasswordSignIn } from '@school/components/email-password-signin';

// Demo credentials pre-filled ONLY in `next dev` (production ships empty fields).
const IS_DEV = process.env.NODE_ENV === 'development';

/**
 * The school owner's door (Owner Login Plan, O1) — on the Owner app's own origin. `api.ownerLogin`
 * hits `/auth/owner-login`, which refuses non-owners byte-identically to a wrong password.
 * `EmailPasswordSignIn` performs the post-login redirect to the owner's landing route.
 */
export default function OwnerLoginPage() {
  return (
    <EmailPasswordSignIn
      title="🔑 School owner"
      subtitle="Sign in to manage your school."
      signIn={api.ownerLogin}
      prefill={IS_DEV ? { email: 'owner@demo.pk', password: 'Owner!Secret12' } : undefined}
    />
  );
}
