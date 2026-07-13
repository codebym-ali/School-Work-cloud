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

    // Reserve the key with INSERT … ON CONFLICT DO NOTHING. A plain create() that hits the
    // unique [schoolId, key] index raises P2002 — but in Postgres a unique violation ABORTS
    // the whole request transaction, so the recovery findFirst then runs against a poisoned
    // tx and surfaces as a raw 500 under concurrency. ON CONFLICT never raises; instead the
    // INSERT blocks on the index until the in-flight winner commits, after which the loser
    // reads the winner's stored response and replays it (exactly-once, no 500s).
    const reserved = await db.$executeRaw`
      INSERT INTO idempotency_keys (id, school_id, "key", request_hash)
      VALUES (gen_random_uuid(), ${schoolId}::uuid, ${key}, ${requestHash})
      ON CONFLICT (school_id, "key") DO NOTHING`;
    if (reserved === 0) {
      const row = await db.idempotencyKey.findFirst({ where: { key } });
      if (row) return this.replay<T>(row, requestHash);
      // Winner rolled back between our conflict and the read (rare): safe to retry, no charge.
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'A request with this Idempotency-Key is already in progress');
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
