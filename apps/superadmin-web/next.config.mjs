/**
 * SuperAdmin (vendor) console — a standalone Next app (Front-End Instance Separation Plan, Phase 1),
 * served on its OWN origin (prod: the reserved `superadmin`/`admin` subdomain). This is the first cut
 * of the per-audience split: the console ships zero tenant code and its session cookies are isolated
 * to this origin.
 *
 * Every call it makes is `/api/v1/platform/*`, which the API's TenantResolutionMiddleware EXCLUDES
 * from tenant resolution (app.module `.exclude('platform/(.*)')`). So — unlike `apps/web`, which must
 * follow the browser's tenant subdomain — this proxy targets a single fixed origin with no tenant and
 * no `*.localhost` DNS. `NEXT_API_ORIGIN` overrides it (CI / remote API).
 */
const API_ORIGIN = process.env.NEXT_API_ORIGIN || 'http://127.0.0.1:4000';

// See apps/web/next.config.mjs: standalone tracing uses symlinks, which Windows blocks without
// Developer Mode — so skip it there (the Linux container still gets it). Set NEXT_STANDALONE=1 to force.
const STANDALONE = process.env.NEXT_STANDALONE === '1' || process.platform !== 'win32';

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // Shared react-free libs live in top-level packages/* (Phase 0) — outside this app's dir.
  experimental: { externalDir: true },
  ...(STANDALONE ? { output: 'standalone' } : {}),
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` }];
  },
};
