import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { validate as isUuid } from 'uuid';
import { CLS_KEYS, TenantViolationError } from '@common';
import { PrismaService } from './prisma.service';
import { tenantExtension } from './tenant.extension';

/** A tenant-bound client: model delegates usable by services. */
export type TenantTx = Prisma.TransactionClient;

/**
 * The tenant-safe database entrypoint every feature service uses (blueprint §21.4).
 *
 * `withTenant(fn)` opens ONE interactive transaction, sets the RLS session variable
 * `app.current_school_id` transaction-locally (parameterized — §21.2, never
 * string-interpolated), stashes the tx on CLS, and runs `fn`. Because set_config
 * and the queries share the transaction/connection, RLS is enforced for the whole
 * unit of work. On top of RLS, the client is extended with the tenant scope
 * extension (§20) — app-layer defence-in-depth.
 *
 * Services read `this.tenantPrisma.client` which resolves to the request's tx.
 */
@Injectable()
export class TenantPrismaService {
  // Type inferred from the extension application so `$transaction`/delegates stay typed.
  private readonly xprisma: ReturnType<TenantPrismaService['buildClient']>;

  // The payment path deliberately serializes on the per-school receipt counter
  // (`SELECT … FOR UPDATE` + `schools.next_receipt_no++`) to keep receiptNo gap-free
  // (§25.5). Under a fee-season burst the queue behind that row lock is deeper than
  // Prisma's default 5s tx timeout / 2s maxWait, so queued-but-correct transactions
  // were being aborted and surfaced as raw 500s. Give the tx a realistic budget so
  // contention degrades into slow-but-correct 201/422/409 instead of errors.
  private readonly txTimeoutMs = Number(process.env.DB_TX_TIMEOUT_MS ?? 20_000);
  private readonly txMaxWaitMs = Number(process.env.DB_TX_MAXWAIT_MS ?? 10_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {
    this.xprisma = this.buildClient();
  }

  private buildClient() {
    return this.prisma.$extends(tenantExtension(this.cls));
  }

  /** The tenant-bound client for the current request (the active tx if inside withTenant). */
  get client(): TenantTx {
    const tx = this.cls.get<TenantTx | undefined>(CLS_KEYS.tx);
    return (tx ?? this.xprisma) as unknown as TenantTx;
  }

  async withTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const schoolId = this.cls.get<string | undefined>(CLS_KEYS.schoolId);
    if (!schoolId || !isUuid(schoolId)) {
      throw new TenantViolationError('No valid tenant context for withTenant');
    }
    return this.xprisma.$transaction(
      async (tx) => {
        // Parameterized set_config; transaction-local (third arg = true).
        await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolId}, true)`;
        const prev = this.cls.get<TenantTx | undefined>(CLS_KEYS.tx);
        this.cls.set(CLS_KEYS.tx, tx);
        try {
          return await fn(tx as unknown as TenantTx);
        } finally {
          this.cls.set(CLS_KEYS.tx, prev);
        }
      },
      { timeout: this.txTimeoutMs, maxWait: this.txMaxWaitMs },
    );
  }

  /**
   * Run `fn` in a tenant transaction of its **own**, independent of the request's.
   *
   * ⚠️ **For writes that must survive a REJECTED request — and nothing else.**
   *
   * `TenantTransactionInterceptor` wraps each request in one transaction, so a handler that
   * records something *about* a failure and then throws loses the record: the rollback takes the
   * evidence with the rejection. That is not hypothetical — **§22.3 account lockout had never
   * fired in a running system** because `registerFailure()`'s write was rolled back by the very
   * exception it was counting (found 2026-08-12).
   *
   * A plain non-transactional client is NOT a substitute: outside a transaction there is no
   * `set_config('app.current_school_id')`, so RLS matches nothing and the write silently affects
   * **zero rows** — failing closed, and just as invisible. The isolation guarantee is kept by
   * opening a real tenant transaction on its own connection, GUC and all.
   *
   * ⚠️ **Never write a row here that the request transaction has already written.** The outer
   * transaction still holds that lock and will not release it until the handler returns — which is
   * waiting on this call. That is a self-deadlock, and it resolves only when the transaction budget
   * expires. Login's lock self-heal goes through this same helper for exactly that reason.
   */
  async outsideRequestTransaction<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    // `withTenant` always opens a fresh `$transaction`, which Prisma serves from a different
    // connection, and restores the previous CLS tx afterwards. So services called inside `fn`
    // (AuditService, for instance) resolve `client` to THIS transaction and commit with it.
    return this.withTenant(fn);
  }
}
