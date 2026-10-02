/**
 * Dev launcher for the Parent portal. Pins NEXT_API_ORIGIN to the demo school's API and preloads the
 * *.localhost DNS shim so Node resolves it. Open http://parent.localhost:3003 in the browser.
 * Prod builds don't use this.
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
