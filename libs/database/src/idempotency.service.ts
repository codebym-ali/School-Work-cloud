import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppError, ErrorCodes, TenantContext } from '@common';
import { TenantPrismaService } from './tenant-prisma.service';

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Idempotency-Key handling (blueprint §25.4). Reserve-then-run so concurrent
 * identical requests execute the body exactly once:
 *  - same key + same request hash + stored response  → replay it (idempotent)
 *  - same key + different request hash                → 409 IDEMPOTENCY_KEY_REUSED
 *  - same key, in-flight (reserved, no response yet)  → 409 (request in progress)
 * Runs inside the caller's tenant transaction; the `[schoolId, key]` unique index
 * is the concurrency backstop. Keys purge after 48h (job).
 */
@Injectable()
export class IdempotencyService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
  ) {}

  async run<T>(
    key: string,
    requestHash: string,
    fn: () => Promise<{ status: number; body: T }>,
  ): Promise<IdempotentResult<T>> {
    const db = this.tenantPrisma.client;
    const schoolId = this.ctx.requireSchoolId();

    const existing = await db.idempotencyKey.findFirst({ where: { key } });
    if (existing) return this.replay<T>(existing, requestHash);

    // Reserve the key first (unique [schoolId, key] guards concurrent duplicates).
    try {
      await db.idempotencyKey.create({ data: { schoolId, key, requestHash } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const row = await db.idempotencyKey.findFirst({ where: { key } });
        if (row) return this.replay<T>(row, requestHash);
      }
      throw e;
    }

    const result = await fn();
    await db.idempotencyKey.update({
      where: { schoolId_key: { schoolId, key } },
      data: { responseCode: result.status, responseBody: result.body as Prisma.InputJsonValue },
    });
    return { ...result, replayed: false };
  }

  private replay<T>(
    row: { requestHash: string; responseCode: number | null; responseBody: Prisma.JsonValue | null },
    requestHash: string,
  ): IdempotentResult<T> {
    if (row.requestHash !== requestHash) {
      throw new AppError(ErrorCodes.IDEMPOTENCY_KEY_REUSED, HttpStatus.CONFLICT, 'Idempotency-Key reused with a different request');
    }
    if (row.responseCode == null) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'A request with this Idempotency-Key is already in progress');
    }
    return { status: row.responseCode, body: row.responseBody as T, replayed: true };
  }
}
