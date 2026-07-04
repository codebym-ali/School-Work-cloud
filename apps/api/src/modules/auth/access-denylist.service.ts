import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '@common';

/**
 * Short-lived access-token denylist (blueprint §22.4). Access tokens are normally
 * not denylisted (15-min blast radius accepted), EXCEPT on account-disable and
 * role-downgrade, where the userId is denied for the access-token lifetime so the
 * stale token stops working immediately.
 */
@Injectable()
export class AccessDenylist {
  private static readonly PREFIX = 'denylist:user:';
  // Access-token TTL upper bound (15 min, §22.1) in seconds.
  private static readonly TTL_SECONDS = 15 * 60;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async deny(userId: string): Promise<void> {
    await this.redis.set(`${AccessDenylist.PREFIX}${userId}`, '1', 'EX', AccessDenylist.TTL_SECONDS);
  }

  async isDenied(userId: string): Promise<boolean> {
    return (await this.redis.exists(`${AccessDenylist.PREFIX}${userId}`)) === 1;
  }
}
