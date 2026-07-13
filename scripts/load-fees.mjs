/**
 * Fee-season load + concurrency-correctness driver (blueprint §25.5, §29; playbook's k6
 * profile realized as a zero-dependency Node script — repeatable locally and in CI).
 *
 * What it proves (correctness under concurrency — meaningful even on a laptop):
 *   1. STORM concurrent payments on DISTINCT invoices → every one succeeds and the
 *      per-school receiptNo sequence is UNIQUE + GAP-FREE (contiguous block).
 *   2. REPLAY concurrent submissions of the SAME Idempotency-Key + body → the charge
 *      executes exactly once (paidAmount reflects ONE payment; others replay/409).
 *   3. OVERPAY race: N different keys all paying the full remaining amount of ONE
 *      invoice → exactly one 201; every other request a clean business rejection
 *      (409 already-PAID or 422 OVERPAYMENT_USE_ADVANCE), never a 5xx; never over-collected.
 * Latency percentiles are reported but are only indicative on local hardware.
 *
 *   node --require ./apps/web/dev-dns.cjs scripts/load-fees.mjs
 * (The preload maps *.localhost → 127.0.0.1 for Node, and the API must be addressed by
 *  its tenant host — undici/fetch silently strips a manual `Host` header.)
 * Env: API (http://demo.localhost:3000) HOST (demo.localhost) EMAIL/PASSWORD (demo owner)
 *      STORM (300) REPLAY (40) OVERPAY (30)
 * NOTE: flush the dev rate-limit keys first (authenticated cap is 600/user/min):
 *      docker exec school-redis sh -c "redis-cli --scan --pattern 'rl:*' | xargs -r redis-cli del"
 */
const API = process.env.API ?? 'http://demo.localhost:3000';
const HOST = process.env.HOST ?? 'demo.localhost';
const EMAIL = process.env.EMAIL ?? 'owner@demo.pk';
const PASSWORD = process.env.PASSWORD ?? 'Owner!Secret12';
// 150 fits one section (capacity cap 200; default mode ADVISORY). The §25.5 design basis
// is 500 fleet-wide — override STORM for bigger runs; the invariants are N-independent.
const STORM = Number(process.env.STORM ?? 150);
const REPLAY = Number(process.env.REPLAY ?? 40);
const OVERPAY = Number(process.env.OVERPAY ?? 30);

const ts = Date.now();
let cookieHeader = '';
let csrf = '';
const lat = [];

async function req(method, path, body, extra = {}) {
  const t0 = performance.now();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Host: HOST,
      'Content-Type': 'application/json',
      Cookie: cookieHeader,
      ...(method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  lat.push(performance.now() - t0);
  let json = null;
  try { json = await res.json(); } catch { /* 204 etc. */ }
  return { status: res.status, body: json };
}

function pct(sorted, p) { return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]); }
function report(label, arr) {
  const s = [...arr].sort((a, b) => a - b);
  console.log(`  ${label}: n=${s.length} p50=${pct(s, 50)}ms p95=${pct(s, 95)}ms p99=${pct(s, 99)}ms max=${Math.round(s[s.length - 1])}ms`);
}
function assert(cond, msg) {
  if (!cond) { console.error(`  ❌ FAILED: ${msg}`); process.exitCode = 1; }
  else console.log(`  ✅ ${msg}`);
}
async function pool(items, worker, concurrency) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await worker(items[idx], idx); }
  }));
  return out;
}

// ── Login ──────────────────────────────────────────────────────────────────────
const login = await fetch(`${API}/api/v1/auth/login`, {
  method: 'POST',
  headers: { Host: HOST, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (login.status !== 200) { console.error(`login failed: ${login.status}`); process.exit(1); }
const setCookies = login.headers.getSetCookie();
cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ');
csrf = (setCookies.find((c) => c.startsWith('csrf=')) ?? '').split(';')[0].slice(5);
console.log(`logged in as ${EMAIL}`);

// ── Setup: dedicated class/section/students → one invoice each ────────────────
console.log(`\n[setup] class + section + ${STORM + 2} students + invoice batch`);
const campusId = (await req('GET', '/api/v1/campuses')).body[0].id;
const year = (await req('GET', '/api/v1/academic-years')).body.find((y) => y.isCurrent);
const klass = (await req('POST', '/api/v1/classes', { campusId, name: `LoadCls${ts}`, order: 90 })).body;
const section = (await req('POST', '/api/v1/sections', { classId: klass.id, name: 'L', capacity: 200 })).body;
if (!section?.id) { console.error(`section create failed: ${JSON.stringify(section)}`); process.exit(1); }
const head = (await req('POST', '/api/v1/fee-heads', { name: `LoadTuition${ts}` })).body;
await req('POST', '/api/v1/fee-structures', { campusId, classId: klass.id, feeHeadId: head.id, academicYearId: year.id, amount: 1000, frequency: 'MONTHLY' });

const students = await pool(Array.from({ length: STORM + 2 }, (_, i) => i), async (i) => {
  const r = await req('POST', '/api/v1/students', {
    fullName: `Load Student ${ts}-${i}`, gender: 'MALE', dateOfBirth: '2015-05-10',
    classId: klass.id, sectionId: section.id,
    guardian: { mode: 'CREATE', fullName: `Load G${i}`, phone: `034${String(ts + i).slice(-8)}`, relation: 'FATHER' },
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`student ${i} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.studentId;
}, 10);
const batch = await req('POST', '/api/v1/fees/invoice-batches', { classId: klass.id, month: 7, year: 2026 });
console.log(`  batch generated: ${batch.body.generated}`);

// Collect our invoices (page through, match by our student ids).
const mine = new Set(students);
const invoiceOf = new Map();
for (let page = 1; invoiceOf.size < students.length && page < 60; page++) {
  const res = await req('GET', `/api/v1/fees/invoices?month=7&year=2026&pageSize=100&page=${page}`);
  for (const inv of res.body.data) if (mine.has(inv.studentId)) invoiceOf.set(inv.studentId, inv.id);
  if (res.body.data.length === 0) break;
}
const invoices = [...invoiceOf.values()];
assert(invoices.length === students.length, `setup: ${students.length} invoices found for our students`);
const [replayInvoice, overpayInvoice, ...stormInvoices] = invoices;

// ── Phase 1: concurrent payments on distinct invoices (gap-free receipts) ─────
console.log(`\n[phase 1] ${stormInvoices.length} concurrent payments on DISTINCT invoices`);
lat.length = 0;
const t1 = performance.now();
const p1 = await Promise.all(stormInvoices.map((id) =>
  req('POST', `/api/v1/fees/invoices/${id}/payments`, { amountPaid: 1000, method: 'CASH' }, { 'Idempotency-Key': crypto.randomUUID() })));
const wall1 = Math.round(performance.now() - t1);
const ok1 = p1.filter((r) => r.status === 201);
report('latency', lat);
console.log(`  wall time: ${wall1}ms → ${Math.round(stormInvoices.length / (wall1 / 1000))} payments/s`);
assert(ok1.length === stormInvoices.length, `all ${stormInvoices.length} payments succeeded (got ${ok1.length}; statuses: ${[...new Set(p1.map((r) => r.status))]})`);
const receipts = ok1.map((r) => r.body.receiptNo);
const uniq = new Set(receipts);
const min = Math.min(...receipts), max = Math.max(...receipts);
assert(uniq.size === receipts.length, `receipt numbers are UNIQUE (${uniq.size}/${receipts.length})`);
assert(max - min + 1 === receipts.length, `receipt numbers are GAP-FREE (${min}..${max} = ${max - min + 1} for ${receipts.length} payments)`);

// ── Phase 2: same Idempotency-Key fired concurrently → exactly one charge ─────
console.log(`\n[phase 2] ${REPLAY} concurrent submissions, SAME key + body, one invoice`);
const oneKey = crypto.randomUUID();
const p2 = await Promise.all(Array.from({ length: REPLAY }, () =>
  req('POST', `/api/v1/fees/invoices/${replayInvoice}/payments`, { amountPaid: 500, method: 'CASH' }, { 'Idempotency-Key': oneKey })));
const s2 = p2.map((r) => r.status);
const inv2 = (await req('GET', `/api/v1/fees/invoices/${replayInvoice}`)).body;
console.log(`  statuses: ${JSON.stringify([...new Set(s2)])} | invoice paidAmount=${inv2.paidAmount} status=${inv2.status}`);
assert(s2.some((s) => s === 200 || s === 201), 'at least one submission was accepted');
assert(s2.every((s) => s === 200 || s === 201 || s === 409), 'others replayed (200/201) or 409 in-progress — never a second charge');
assert(Number(inv2.paidAmount) === 500, `charged exactly ONCE (paidAmount=500, not ${REPLAY * 500})`);

// ── Phase 3: overpay race — different keys, full amount each ──────────────────
console.log(`\n[phase 3] ${OVERPAY} concurrent FULL payments, DIFFERENT keys, one invoice`);
const p3 = await Promise.all(Array.from({ length: OVERPAY }, () =>
  req('POST', `/api/v1/fees/invoices/${overpayInvoice}/payments`, { amountPaid: 1000, method: 'CASH' }, { 'Idempotency-Key': crypto.randomUUID() })));
const wins = p3.filter((r) => r.status === 201);
// The winner zeroes the invoice (→ PAID), so losers correctly get 409 already-PAID; a loser
// that raced in while the invoice was still PARTIAL gets 422 OVERPAYMENT_USE_ADVANCE. Both are
// clean rejections — the invariant is that NONE double-charge and NONE 5xx under contention.
const rejected = p3.filter((r) => r.status === 409 || (r.status === 422 && r.body?.error?.code === 'OVERPAYMENT_USE_ADVANCE'));
const errored = p3.filter((r) => r.status >= 500);
const inv3 = (await req('GET', `/api/v1/fees/invoices/${overpayInvoice}`)).body;
console.log(`  201=${wins.length} rejected(409/422)=${rejected.length} 5xx=${errored.length} | invoice paidAmount=${inv3.paidAmount} status=${inv3.status}`);
assert(wins.length === 1, `exactly ONE payment won the race (got ${wins.length})`);
assert(errored.length === 0, `no request 5xx'd under contention (got ${errored.length})`);
assert(rejected.length === OVERPAY - 1, `the other ${OVERPAY - 1} got a clean 409/422 rejection (got ${rejected.length})`);
assert(Number(inv3.paidAmount) === 1000, `never over-collected (paidAmount=1000)`);

// ── Integrity: server-side invariant check across everything we just did ──────
const integ = await req('GET', '/api/v1/fees/integrity-check');
assert(integ.body.ok === true, `fee-integrity-check clean after the storm (mismatches: ${integ.body.mismatches?.length ?? '?'})`);

console.log(process.exitCode ? '\nRESULT: FAILED' : '\nRESULT: ALL INVARIANTS HELD');
