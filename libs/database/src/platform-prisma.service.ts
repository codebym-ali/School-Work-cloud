import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ENV, type Env } from '@common';

/**
 * Cross-tenant Prisma client — connects as `platform_admin` (BYPASSRLS, read-mostly).
 * Used ONLY by the vendor console, cross-tenant analytics jobs, and tenant-export
 * (blueprint §21.5). The request-path never receives this; keeping it a separate
 * provider makes accidental use in feature code a visible, reviewable import.
 */
@Injectable()
export class PlatformPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    super({ datasources: { db: { url: env.PLATFORM_DATABASE_URL } } });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
