import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import Redis from 'ioredis';
import { Public, REDIS, SkipRateLimit } from '@common';
import { PrismaService } from '@database';

type CheckState = 'ok' | 'down';

/**
 * Liveness/readiness (blueprint §19 public list, §31). Host-exempt (no tenant),
 * reveals nothing internal.
 *  - `live`  — the process is up (never touches dependencies; use for restart-on-crash).
 *  - `ready` — the instance can actually serve: the HARD dependencies (Postgres + Redis)
 *    are reachable. Returns **503** when any is down so an orchestrator/proxy stops routing
 *    to a half-up instance (the previous version returned 200 with a degraded body, so the
 *    healthcheck never failed). S3 is intentionally NOT gated on — it's a soft dependency
 *    (only uploads/PDFs need it); its outage must not pull the whole node out of rotation.
 */
@SkipRateLimit()
@Controller('health')
export class HealthController {
  // Each dependency check is bounded — the shared ioredis client uses
  // maxRetriesPerRequest:null (commands queue forever), so a ping to a down Redis would
  // otherwise hang the probe indefinitely; a DB query can stall on pool_timeout too.
  private static readonly CHECK_TIMEOUT_MS = 2_000;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Public()
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready(
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: 'ok' | 'degraded'; checks: Record<string, CheckState> }> {
    const [db, redis] = await Promise.all([
      this.check(() => this.prisma.$queryRaw`SELECT 1`),
      this.check(() => this.redis.ping()),
    ]);
    const checks: Record<string, CheckState> = { db, redis };
    const healthy = db === 'ok' && redis === 'ok';

    // Set the status via passthrough Res (not by throwing) so the structured {checks} body
    // survives — a thrown HttpException gets reformatted by the global exception filter.
    // 503 → the compose/Traefik healthcheck (statusCode === 200) correctly marks unhealthy.
    res.status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: healthy ? 'ok' : 'degraded', checks };
  }

  private async check(fn: () => Promise<unknown>): Promise<CheckState> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), HealthController.CHECK_TIMEOUT_MS);
        }),
      ]);
      return 'ok';
    } catch {
      return 'down';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
