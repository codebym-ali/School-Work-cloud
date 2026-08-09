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

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // Emit a self-contained server bundle (`.next/standalone/server.js`) so the Docker
  // runner stage ships only the traced deps — no full node_modules. See apps/web/Dockerfile.
  output: 'standalone',
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
