import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { RateLimitService } from './rate-limit.service';

/**
 * Exercises the sliding-window Lua script against a real Redis (§29). Each test
 * uses a unique key so runs are isolated and repeatable.
 */
describe('RateLimitService (sliding window)', () => {
  let redis: Redis;
  let service: RateLimitService;

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6381', { maxRetriesPerRequest: null });
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
