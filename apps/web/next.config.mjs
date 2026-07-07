/**
 * In production the frontend and API are served from the same tenant domain
 * (Traefik routes `/api` to the API, `/` to Next), so the browser calls `/api/v1/*`
 * same-origin. In dev we proxy `/api/*` to the API — the destination host carries the
 * tenant subdomain so the API's TenantResolutionMiddleware resolves the right school.
 *
 *   NEXT_API_ORIGIN=http://demo.localhost:4000  (default; matches `pnpm db:seed`)
 *   (API runs on :4000 in dev to coexist with the user's Goex project on :3000)
 */
const API_ORIGIN = process.env.NEXT_API_ORIGIN || 'http://demo.localhost:4000';

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` }];
  },
};
