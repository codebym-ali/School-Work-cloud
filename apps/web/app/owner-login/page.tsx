'use client';

import Link from 'next/link';
import { api } from '@/lib/api';
import { EmailPasswordSignIn } from '@school/components/email-password-signin';

// Demo credentials pre-filled ONLY in `next dev` (production ships empty fields) — moved here from
// `/login` at O2, because the staff door now refuses this account.
const IS_DEV = process.env.NODE_ENV === 'development';

/**
 * The school owner's own entrance (Owner Login Plan, O1).
 *
 * ⚠️ **Nobody else can sign in here, and nobody else is told so.** The refusal is byte-identical to
 * a wrong password — same status, same message, same work done on the server — because a door that
 * says *"you are not the owner"* is a detector: anyone holding a staff credential could use it to
 * discover which address owns the school, which is the one fact worth knowing before an attack.
 *
 * ⚠️ **Which is exactly why the way out has to be on the page.** A teacher who bookmarked this URL
 * gets a failure that deliberately carries no hint, so the standing line below — *"Staff or
 * teacher? Sign in with your email"* — is the only thing that can redirect them, and it has to be
 * readable BEFORE they fail rather than after. That link is a security consequence, not decoration.
 *
 * No `?campus=` branding here (unlike `/login`): an owner belongs to no campus — `restrictedCampusId()`
 * returns `null` for them precisely because they are school-wide — so a campus name would be a lie.
 */
export default function OwnerLoginPage() {
  return (
    <EmailPasswordSignIn
      title="🔑 School owner"
      subtitle="Sign in to manage your school."
      signIn={api.ownerLogin}
      prefill={IS_DEV ? { email: 'owner@demo.pk', password: 'Owner!Secret12' } : undefined}
      footer={
        <p className="muted" style={{ margin: 0, fontSize: 13, textAlign: 'center' }}>
          Staff or teacher? <Link href="/staff-login">Sign in with your email →</Link>
        </p>
      }
    />
  );
}
