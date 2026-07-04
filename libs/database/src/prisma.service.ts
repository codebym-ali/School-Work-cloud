import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ENV, type Env } from '@common';

/**
 * The request-path Prisma client. Connects as `app_user` (NOBYPASSRLS), so every
 * query it runs is subject to Row-Level Security (blueprint §21.5). Tenant scoping
 * is applied on top via the client extension + withTenant wrapper (TenantPrismaService).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    super({ datasources: { db: { url: env.DATABASE_URL } } });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
