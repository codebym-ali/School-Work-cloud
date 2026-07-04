import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import {
  AllExceptionsFilter,
  CommonModule,
  RedisModule,
  RolesGuard,
  TenantScopeGuard,
} from '@common';
import { DatabaseModule, TenantTransactionInterceptor } from '@database';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { CsrfGuard } from './modules/auth/guards/csrf.guard';
import { HealthController } from './health/health.controller';
import { TenantResolutionMiddleware } from './tenant/tenant-resolution.middleware';

/**
 * API composition root. Global pipeline order (blueprint §19, §22, §25):
 *   ClsMiddleware -> TenantResolutionMiddleware  (per-request context, pre-auth)
 *   CsrfGuard -> JwtAuthGuard -> TenantScopeGuard -> RolesGuard  (auth chain)
 *   TenantTransactionInterceptor  (one RLS-bound tx per request)
 *   AllExceptionsFilter  (the §25.1 error envelope)
 */
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true, generateId: true, idGenerator: () => randomUUID() },
    }),
    CommonModule,
    RedisModule,
    DatabaseModule,
    AuthModule,
  ],
  controllers: [HealthController],
  providers: [
    // Guard order matters — Nest runs global guards in registration order.
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: TenantScopeGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Tenant resolution runs on every route except the host-exempt health checks.
    consumer
      .apply(TenantResolutionMiddleware)
      .exclude('health/(.*)', 'health')
      .forRoutes('*');
  }
}
