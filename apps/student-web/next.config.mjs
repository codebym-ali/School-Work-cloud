/**
 * In production the frontend and API are served from the same tenant domain
 * (Traefik routes `/api` to the API, `/` to Next), so the browser calls `/api/v1/*`
 * same-origin. In dev we proxy `/api/*` to the API — and the destination host has to carry the
 * tenant subdomain, because the API's TenantResolutionMiddleware resolves the school from it.
 *
 * **The proxy follows the browser's own subdomain (fixed 2026-08-09).** It used to be pinned to a
 * single origin, `demo.localhost:4000`, decided once at server start:
 *
 *     const API_ORIGIN = process.env.NEXT_API_ORIGIN || 'http://demo.localhost:4000';
 *
 * so whatever subdomain you typed, every API call reached the **demo** school. Opening
 * `falcon.localhost:3001` and signing in as one of Falcon's teachers returned *"Invalid
 * credentials"* — the password was fine, it was being checked against a school that had never
 * heard of them. Nothing in the error hinted at that, and the only way to work on a second tenant
 * was to start a second Next server with `NEXT_API_ORIGIN` set. It cost me two separate
 * debugging sessions in one day, which is the argument for fixing it rather than documenting it.
 *
 * Now: `demo.localhost:3001` → `demo`, `falcon.localhost:3001` → `falcon`. Same as production.
 *
 * `NEXT_API_ORIGIN` still wins when set, and deliberately so — CI, the e2e suite and anyone
 * pointing the UI at a remote API all rely on pinning it, and a "smart" default that overrode an
 * explicit setting would be worse than the bug this replaces.
 *
 * `pnpm dev` runs through `dev.mjs`, which preloads `dev-dns.cjs` to map `*.localhost` →
 * 127.0.0.1 (Node, unlike browsers, will not resolve it otherwise).
 */
const EXPLICIT_ORIGIN = process.env.NEXT_API_ORIGIN;
const API_PORT = process.env.API_PORT || '4000';
/** Used when the browser is on bare `localhost` — there is no subdomain to resolve a tenant from,
 *  and the seeded demo school is the one a bare host is almost always meant to reach. */
const FALLBACK_ORIGIN = `http://demo.localhost:${API_PORT}`;

/**
 * Standalone output is what the Docker runner stage ships (`.next/standalone/server.js`, only the
 * traced deps, no full node_modules — see apps/web/Dockerfile), so it must stay on for any build
 * that produces the image.
 *
 * ⚠️ **It cannot run on Windows without extra privileges.** Tracing copies dependencies by
 * creating SYMLINKS, and Windows only permits that for an administrator or with Developer Mode
 * enabled — so `next build` on a normal Windows account dies with `EPERM: operation not permitted,
 * symlink` *after* compiling, type-checking and generating every page successfully. The build was
 * therefore unusable locally while being perfectly fine in CI and Docker, which both run Linux.
 *
 * Skipped on win32 rather than solved, because there is nothing to solve: the standalone bundle is
 * consumed **only** by the Linux container image, so a Windows developer producing one has no use
 * for it. Set `NEXT_STANDALONE=1` to force it anyway (Developer Mode on, or an elevated shell).
 */
const STANDALONE = process.env.NEXT_STANDALONE === '1' || process.platform !== 'win32';

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // Shared UI/lib live in top-level `packages/*` (Front-End Instance Separation Plan, Phase 0),
  // which sit OUTSIDE this app's directory — externalDir lets Next compile them as source.
  experimental: { externalDir: true },
  ...(STANDALONE ? { output: 'standalone' } : {}),
  async rewrites() {
    if (EXPLICIT_ORIGIN) {
      return [{ source: '/api/:path*', destination: `${EXPLICIT_ORIGIN}/api/:path*` }];
    }
    return [
      {
        // `has` matches the request's Host header, which carries the dev port — hence the optional
        // `:3001`. The named group is interpolated into the destination host below.
        source: '/api/:path*',
        has: [{ type: 'host', value: '(?<tenant>[^.]+)\\.localhost(?::\\d+)?' }],
        destination: `http://:tenant.localhost:${API_PORT}/api/:path*`,
      },
      // Bare `localhost`, an IP, or anything without a subdomain.
      { source: '/api/:path*', destination: `${FALLBACK_ORIGIN}/api/:path*` },
    ];
  },
};
