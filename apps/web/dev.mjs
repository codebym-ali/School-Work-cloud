/**
 * Dev launcher for the frontend. Starts `next dev` with:
 *   - NEXT_API_ORIGIN defaulted to the tenant host on the API port (demo.localhost:4000)
 *   - a preloaded DNS shim (dev-dns.cjs) so Node resolves *.localhost for the /api proxy
 * Cross-platform (no cross-env / no hosts edit). Prod builds don't use this.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const shim = join(here, 'dev-dns.cjs').replace(/\\/g, '/');

const env = { ...process.env };
if (!env.NEXT_API_ORIGIN) env.NEXT_API_ORIGIN = 'http://demo.localhost:4000';
env.NODE_OPTIONS = `${env.NODE_OPTIONS ? env.NODE_OPTIONS + ' ' : ''}--require "${shim}"`;

const child = spawn('next', ['dev', '-p', '3001'], { stdio: 'inherit', shell: true, env });
child.on('exit', (code) => process.exit(code ?? 0));
