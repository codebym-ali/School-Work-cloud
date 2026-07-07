import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ClsMiddleware, ClsModule } from 'nestjs-cls';
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
import { PlatformModule } from './modules/platform/platform.module';
import { SetupModule } from './modules/setup/setup.module';
import { StudentsModule } from './modules/students/students.module';
import { AdmissionsModule } from './modules/admissions/admissions.module';
import { EnrollmentModule } from './modules/enrollment/enrollment.module';
import { CommsModule } from './modules/comms/comms.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { LeavesModule } from './modules/leaves/leaves.module';
import { FeesModule } from './modules/fees/fees.module';

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
      // mount: false — we apply ClsMiddleware explicitly (below) so it is guaranteed
      // to run BEFORE TenantResolutionMiddleware, which sets tenant context on CLS.
      middleware: { mount: false, generateId: true, idGenerator: () => randomUUID() },
    }),
    CommonModule,
    RedisModule,
    DatabaseModule,
    AuthModule,
    PlatformModule,
    SetupModule,
    StudentsModule,
    AdmissionsModule,
    EnrollmentModule,
    CommsModule,
    AttendanceModule,
    LeavesModule,
    FeesModule,
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
    // CLS context first (all routes), then tenant resolution (all but health).
    consumer.apply(ClsMiddleware).forRoutes('*');
    consumer
      .apply(TenantResolutionMiddleware)
      // Host-exempt (blueprint §19): health checks and HMAC-authenticated webhooks.
      .exclude('health/(.*)', 'health', 'webhooks/(.*)')
      .forRoutes('*');
  }
}
