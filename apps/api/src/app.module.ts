import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ClsMiddleware, ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import {
  AllExceptionsFilter,
  CommonModule,
  ConfigModule,
  ENV,
  MetricsMiddleware,
  MetricsModule,
  MfaEnrolledGuard,
  pinoConfig,
  RateLimitGuard,
  RateLimitModule,
  RedisModule,
  RolesGuard,
  TenantScopeGuard,
  UuidParamPipe,
  type Env,
} from '@common';
import { StorageModule } from '@common';
import { DatabaseModule, TenantTransactionInterceptor } from '@database';
import { MetricsController } from './metrics/metrics.controller';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { BreakGlassReadonlyGuard } from './modules/auth/guards/break-glass.guard';
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
import { NotificationsModule } from './modules/notifications/notifications.module';
import { BellScheduleModule } from './modules/bell-schedule/bell-schedule.module';
import { TimetableModule } from './modules/timetable/timetable.module';
import { CoverModule } from './modules/cover/cover.module';
import { FeesModule } from './modules/fees/fees.module';
import { ExamsModule } from './modules/exams/exams.module';
import { HrModule } from './modules/hr/hr.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { ReportsModule } from './modules/reports/reports.module';
import { StudentPortalModule } from './modules/portal/student-portal.module';
import { TeachingModule } from './modules/teaching/teaching.module';
import { ClassTestsModule } from './modules/class-tests/class-tests.module';
import { UsersModule } from './modules/users/users.module';
import { UploadsModule } from './modules/uploads/uploads.module';

/**
 * API composition root. Global pipeline order (blueprint §19, §22, §25):
 *   ClsMiddleware -> TenantResolutionMiddleware  (per-request context, pre-auth)
 *   CsrfGuard -> JwtAuthGuard -> TenantScopeGuard -> RolesGuard  (auth chain)
 *   TenantTransactionInterceptor  (one RLS-bound tx per request)
 *   AllExceptionsFilter  (the §25.1 error envelope)
 */
@Module({
  imports: [
    // Structured JSON logging (§31) — requestId/schoolId/userId + PII redaction.
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ENV],
      useFactory: (env: Env) => pinoConfig(env),
    }),
    ClsModule.forRoot({
      global: true,
      // mount: false — we apply ClsMiddleware explicitly (below) so it is guaranteed
      // to run BEFORE TenantResolutionMiddleware, which sets tenant context on CLS.
      middleware: { mount: false, generateId: true, idGenerator: () => randomUUID() },
    }),
    CommonModule,
    RedisModule,
    RateLimitModule,
    MetricsModule,
    StorageModule,
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
    NotificationsModule,
    BellScheduleModule,
    TimetableModule,
    CoverModule,
    FeesModule,
    ExamsModule,
    HrModule,
    DocumentsModule,
    ReportsModule,
    UploadsModule,
    StudentPortalModule,
    TeachingModule,
    ClassTestsModule,
    UsersModule,
  ],
  controllers: [HealthController, MetricsController],
  providers: [
    // Guard order matters — Nest runs global guards in registration order.
    // RateLimitGuard runs after JwtAuthGuard so req.user is set (authenticated
    // routes key per user; @Public routes key per IP) — blueprint §29.
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // SA5: block writes for a break-glass session (read-only, SA-P8) — after JwtAuthGuard so req.user is set.
    { provide: APP_GUARD, useClass: BreakGlassReadonlyGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: TenantScopeGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // After RolesGuard: a caller refused a role should hear "insufficient role", not be told to set up
    // two-factor for a route they could never use anyway.
    { provide: APP_GUARD, useClass: MfaEnrolledGuard },
    // ⚠️ Bound HERE and not in `main.ts`: every integration spec builds its app from AppModule
    // and re-declares only the ValidationPipe, so a pipe registered in the bootstrap file would
    // be absent from all 38 suites — present in production, untested everywhere.
    { provide: APP_PIPE, useClass: UuidParamPipe },
    { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // CLS context first (all routes); metrics records every response; then tenant resolution.
    consumer.apply(ClsMiddleware).forRoutes('*');
    consumer.apply(MetricsMiddleware).forRoutes('*');
    consumer
      .apply(TenantResolutionMiddleware)
      // Host-exempt (blueprint §19, §24, §31): health checks, HMAC webhooks, the vendor
      // console (cross-tenant; reserved `admin` host), and the metrics scrape.
      .exclude('health/(.*)', 'health', 'webhooks/(.*)', 'platform/(.*)', 'metrics')
      .forRoutes('*');
  }
}
