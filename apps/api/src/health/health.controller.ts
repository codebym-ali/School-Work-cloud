import { Controller, Get } from '@nestjs/common';
import { Public } from '@common';
import { PrismaService } from '@database';

/**
 * Liveness/readiness (blueprint §19 public list, §31). Host-exempt (no tenant),
 * reveal nothing internal. `ready` checks the DB is reachable.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready(): Promise<{ status: 'ok' | 'degraded' }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch {
      return { status: 'degraded' };
    }
  }
}
