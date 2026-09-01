/**
 * Dev launcher for the Owner app (Front-End Instance Separation Plan, Phase 3b). Tenant-scoped like
 * apps/web (the owner signs in per-school), so the API proxy carries a tenant host: pin NEXT_API_ORIGIN
 * to the demo school and preload the *.localhost DNS shim.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const shim = join(here, 'dev-dns.cjs').replace(/\\/g, '/');
const env = { ...process.env };
if (!env.NEXT_API_ORIGIN) env.NEXT_API_ORIGIN = 'http://demo.localhost:4000';
env.NODE_OPTIONS = `${env.NODE_OPTIONS ? env.NODE_OPTIONS + ' ' : ''}--require "${shim}"`;

const child = spawn('next', ['dev', '-p', '3005'], { stdio: 'inherit', shell: true, env });
child.on('exit', (code) => process.exit(code ?? 0));
