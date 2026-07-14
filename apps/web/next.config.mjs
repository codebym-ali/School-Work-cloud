/**
 * In production the frontend and API are served from the same tenant domain
 * (Traefik routes `/api` to the API, `/` to Next), so the browser calls `/api/v1/*`
 * same-origin. In dev we proxy `/api/*` to the API — the destination host carries the
 * tenant subdomain so the API's TenantResolutionMiddleware resolves the right school.
 *
 *   NEXT_API_ORIGIN=http://demo.localhost:3000  (default; matches API_PORT + `pnpm db:seed`)
 *
 * The destination host carries the tenant subdomain (`demo`) so the API resolves the
 * right school. `pnpm dev` runs through `dev.mjs`, which preloads `dev-dns.cjs` to map
 * `*.localhost` → 127.0.0.1 (Node, unlike browsers, won't resolve it otherwise).
 */
const API_ORIGIN = process.env.NEXT_API_ORIGIN || 'http://demo.localhost:3000';

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // Emit a self-contained server bundle (`.next/standalone/server.js`) so the Docker
  // runner stage ships only the traced deps — no full node_modules. See apps/web/Dockerfile.
  output: 'standalone',
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` }];
  },
};
