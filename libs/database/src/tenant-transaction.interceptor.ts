import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { from, lastValueFrom, Observable } from 'rxjs';
import { CLS_KEYS } from '@common';
import { TenantPrismaService } from './tenant-prisma.service';

/**
 * Opens exactly one tenant-bound transaction per request (blueprint §21.4) so that
 * set_config('app.current_school_id') and every query the handler runs share a
 * connection — the precondition for RLS to apply. Requests without a resolved
 * tenant (health checks, webhooks — host-exempt, §19) pass straight through.
 *
 * Handlers/services must use `TenantPrismaService.client` (the CLS-bound tx), not
 * open their own transaction, so there is a single transaction per request.
 */
@Injectable()
export class TenantTransactionInterceptor implements NestInterceptor {
  constructor(
    private readonly cls: ClsService,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const schoolId = this.cls.get<string | undefined>(CLS_KEYS.schoolId);
    if (!schoolId) {
      return next.handle();
    }
    return from(this.tenantPrisma.withTenant(() => lastValueFrom(next.handle())));
  }
}
