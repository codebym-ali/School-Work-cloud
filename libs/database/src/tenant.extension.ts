/* eslint-disable @typescript-eslint/no-explicit-any */
import { Prisma } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import { CLS_KEYS, TenantViolationError } from '@common';

/**
 * Application-layer tenant scoping (blueprint §20) — the FIRST of the three
 * isolation layers (extension → RLS → CI). It reads schoolId from CLS and:
 *   • create / createMany   -> inject schoolId into data; reject a mismatching one
 *   • upsert                 -> inject schoolId into the create arm + where
 *   • find many / count / aggregate / groupBy / updateMany / deleteMany -> merge schoolId into where
 *   • findUnique/update/delete (by unique key) -> left to RLS, which filters the row
 *     out at the DB (returns null / "not found") — RLS is the authoritative backstop.
 *
 * Missing schoolId on a tenant model => throw (fail-closed). `School` is exempt
 * (tenant resolution reads it pre-context; it holds no child data).
 */
const NON_TENANT_MODELS = new Set<string>(['School']);

const WHERE_MERGE_OPS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
]);

export function tenantExtension(cls: ClsService) {
  return Prisma.defineExtension({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || NON_TENANT_MODELS.has(model)) {
            return query(args);
          }

          const schoolId: string | undefined = cls.get(CLS_KEYS.schoolId);
          if (!schoolId) {
            throw new TenantViolationError(
              `No tenant context for ${model}.${operation} (fail-closed)`,
            );
          }

          const a: any = args ?? {};

          if (operation === 'create') {
            a.data = assertOrInject(a.data, schoolId, model, operation);
          } else if (operation === 'createMany') {
            if (Array.isArray(a.data)) {
              a.data = a.data.map((d: any) => assertOrInject(d, schoolId, model, operation));
            } else if (a.data) {
              a.data = assertOrInject(a.data, schoolId, model, operation);
            }
          } else if (operation === 'upsert') {
            a.create = assertOrInject(a.create, schoolId, model, operation);
            a.where = { ...(a.where ?? {}), schoolId };
          } else if (WHERE_MERGE_OPS.has(operation)) {
            a.where = { ...(a.where ?? {}), schoolId };
          }
          // findUnique/findUniqueOrThrow/update/delete: RLS enforces scoping.

          return query(a);
        },
      },
    },
  });
}

function assertOrInject(data: any, schoolId: string, model: string, operation: string): any {
  if (data && typeof data === 'object' && 'schoolId' in data && data.schoolId !== schoolId) {
    throw new TenantViolationError(
      `Cross-tenant write blocked on ${model}.${operation}: schoolId does not match tenant context`,
    );
  }
  return { ...data, schoolId };
}
