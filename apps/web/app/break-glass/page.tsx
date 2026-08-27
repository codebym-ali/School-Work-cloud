'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

/**
 * Break-glass entry (SA5). The destination of the vendor console's "Enter" link, on the school's own
 * host. Reads the one-time token from the URL *fragment* (never the query — kept out of server logs
 * and the Referer header), sets the read-only session cookie via /auth/break-glass-enter, then lands
 * on the school's dashboard. The session is confined to this one school (SA-P8) and can only read.
 */
export default function BreakGlassPage() {
  const router = useRouter();
  const [msg, setMsg] = useState('Entering support session…');

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token') ?? '';
    if (!token) {
      setMsg('This link is missing its token. Ask for a fresh one from the vendor console.');
      return;
    }
    api
      .breakGlassEnter(token)
      .then(() => router.replace('/dashboard'))
      .catch((e) => setMsg(e instanceof ApiError ? e.message : 'That link is invalid or has expired.'));
  }, [router]);

  return (
    <main className="container" style={{ maxWidth: 440, margin: '10vh auto' }}>
      <div className="card stack">
        <h1 style={{ margin: 0, fontSize: 20 }}>Support access</h1>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{msg}</p>
      </div>
    </main>
  );
}
