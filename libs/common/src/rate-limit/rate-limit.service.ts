import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { REDIS } from '../redis/redis.module';

export interface RateLimitResult {
  allowed: boolean;
  /** Requests still permitted in the current window (0 when denied). */
  remaining: number;
  /** Seconds until the window frees a slot — the `Retry-After` value (≥1). */
  retryAfterSec: number;
}

/**
 * Sliding-window rate limiter over a Redis sorted set (blueprint §29).
 *
 * Each hit is a member scored by its timestamp. The Lua script runs atomically:
 * trim entries older than the window, count what remains, and either reject
 * (returning when the oldest entry expires) or admit (recording the new hit and
 * refreshing the key TTL). Atomicity closes the check-then-set race a naive
 * INCR/EXPIRE pair would leave open under concurrency (§25.5 concurrency basis).
 */
@Injectable()
export class RateLimitService {
  // KEYS[1]=zset  ARGV: now(ms), windowMs, limit, member
  // returns { allowed(1/0), remaining, resetMs }
  private static readonly SCRIPT = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local window = tonumber(ARGV[2])
    local limit = tonumber(ARGV[3])
    local member = ARGV[4]
    redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
    local count = redis.call('ZCARD', key)
    if count >= limit then
      local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
      local resetMs = window
      if oldest[2] then resetMs = (tonumber(oldest[2]) + window) - now end
      if resetMs < 1 then resetMs = 1 end
      return {0, 0, resetMs}
    end
    redis.call('ZADD', key, now, member)
    redis.call('PEXPIRE', key, window)
    return {1, limit - count - 1, window}
  `;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Record a hit against `key` and report whether it is within `limit` per `windowSec`. */
  async consume(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowMs = windowSec * 1000;
    const member = `${now}-${randomUUID()}`;
    const [allowed, remaining, resetMs] = (await this.redis.eval(
      RateLimitService.SCRIPT,
      1,
      key,
      String(now),
      String(windowMs),
      String(limit),
      member,
    )) as [number, number, number];
    return {
      allowed: allowed === 1,
      remaining,
      retryAfterSec: Math.max(1, Math.ceil(resetMs / 1000)),
    };
  }
}
