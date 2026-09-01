/**
 * Dev launcher for the Student portal (Front-End Instance Separation Plan, Phase 2). Same tenant-aware
 * setup as apps/web: the student signs in by registration-no + CNIC, which is PER-SCHOOL, so the API
 * proxy must carry a tenant host. Pins NEXT_API_ORIGIN to the demo school and preloads the *.localhost
 * DNS shim so Node resolves it. Prod builds don't use this.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const shim = join(here, 'dev-dns.cjs').replace(/\\/g, '/');

const env = { ...process.env };
if (!env.NEXT_API_ORIGIN) env.NEXT_API_ORIGIN = 'http://demo.localhost:4000';
env.NODE_OPTIONS = `${env.NODE_OPTIONS ? env.NODE_OPTIONS + ' ' : ''}--require "${shim}"`;

const child = spawn('next', ['dev', '-p', '3003'], { stdio: 'inherit', shell: true, env });
child.on('exit', (code) => process.exit(code ?? 0));
