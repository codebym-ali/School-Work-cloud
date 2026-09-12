import { execFileSync } from 'node:child_process';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { RateLimitService } from './rate-limit.service';

/**
 * Exercises the sliding-window Lua script against a real Redis (§29). Each test
 * uses a unique key so runs are isolated and repeatable.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6381';

/**
 * Is a real Redis actually there? Probed SYNCHRONOUSLY, because whether to skip must be decided at
 * collection time — `describe.skip` cannot be chosen from inside an async hook, and this project's
 * Jest runs CommonJS, so top-level await is unavailable. A short child process is the honest way to
 * get a synchronous answer; it costs ~100ms once per file.
 *
 * ⚠️ In CI this must NEVER skip. CI provides a `redis` service, so an unreachable one there is a
 * broken pipeline, not a missing convenience — skipping would turn a red build green and hide
 * exactly what these tests exist to check.
 *
 * Locally the alternative was worse than skipping: three tests each burning a 5-second connect
 * timeout and failing with a stack pointing at `afterAll`, which reads as a CODE defect and teaches
 * people to ignore `pnpm verify` output.
 */
function redisReachable(): boolean {
  const { host, port } = (() => {
    try {
      const u = new URL(REDIS_URL);
      return { host: u.hostname, port: Number(u.port || 6379) };
    } catch {
      return { host: '127.0.0.1', port: 6379 };
    }
  })();
  const probe = `const net=require('net');const s=net.connect(${port},${JSON.stringify(host)});` +
    `s.setTimeout(1500);s.on('connect',()=>{s.destroy();process.exit(0)});` +
    `s.on('error',()=>process.exit(1));s.on('timeout',()=>{s.destroy();process.exit(1)});`;
  try {
    execFileSync(process.execPath, ['-e', probe], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const available = redisReachable();
if (!available && process.env.CI === 'true') {
  throw new Error(`CI requires a real Redis at ${REDIS_URL}; the rate-limit suite must not be skipped there.`);
}
if (!available) {
  // eslint-disable-next-line no-console
  console.warn(`
  SKIPPED rate-limit suite: no Redis at ${REDIS_URL}. Start one with: docker compose up -d redis
`);
}
const describeWithRedis = available ? describe : describe.skip;

describeWithRedis('RateLimitService (sliding window)', () => {
  let redis: Redis;
  let service: RateLimitService;

  beforeAll(() => {
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    service = new RateLimitService(redis);
  });

  afterAll(async () => {
    await redis.quit();
  });

  const key = () => `test:rl:${randomUUID()}`;

  it('allows up to the limit then denies, decrementing remaining', async () => {
    const k = key();
    const r1 = await service.consume(k, 3, 60);
    const r2 = await service.consume(k, 3, 60);
    const r3 = await service.consume(k, 3, 60);
    const r4 = await service.consume(k, 3, 60);

    expect([r1.allowed, r2.allowed, r3.allowed]).toEqual([true, true, true]);
    expect([r1.remaining, r2.remaining, r3.remaining]).toEqual([2, 1, 0]);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(r4.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it('keeps separate counters per key', async () => {
    const a = key();
    const b = key();
    await service.consume(a, 1, 60);
    const denied = await service.consume(a, 1, 60);
    const other = await service.consume(b, 1, 60);
    expect(denied.allowed).toBe(false);
    expect(other.allowed).toBe(true);
  });

  it('frees a slot once the window slides past the oldest hit', async () => {
    const k = key();
    const first = await service.consume(k, 1, 1); // 1 req / 1s
    const blocked = await service.consume(k, 1, 1);
    expect(first.allowed).toBe(true);
    expect(blocked.allowed).toBe(false);

    await new Promise((r) => setTimeout(r, 1100));
    const afterWindow = await service.consume(k, 1, 1);
    expect(afterWindow.allowed).toBe(true);
  });
});
