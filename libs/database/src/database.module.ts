import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { PlatformPrismaService } from './platform-prisma.service';
import { TenantPrismaService } from './tenant-prisma.service';
import { TenantTransactionInterceptor } from './tenant-transaction.interceptor';
import { AuditService } from './audit.service';
import { IdempotencyService } from './idempotency.service';

/**
 * Database providers shared by api + worker. Exposes:
 *  • TenantPrismaService — the tenant-safe entrypoint feature services use
 *  • PlatformPrismaService — BYPASSRLS, platform/vendor code only
 *  • TenantTransactionInterceptor — registered as APP_INTERCEPTOR by the api app
 */
@Global()
@Module({
  providers: [
    PrismaService,
    PlatformPrismaService,
    TenantPrismaService,
    TenantTransactionInterceptor,
    AuditService,
    IdempotencyService,
  ],
  exports: [
    PrismaService,
    PlatformPrismaService,
    TenantPrismaService,
    TenantTransactionInterceptor,
    AuditService,
    IdempotencyService,
  ],
})
export class DatabaseModule {}
