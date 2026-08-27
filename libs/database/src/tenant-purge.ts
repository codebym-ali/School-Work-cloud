/**
 * Tenant hard-delete + export (SA7) — the hardest, most dangerous operation in the system.
 *
 * The purge order is derived from the LIVE foreign-key graph (Kahn's algorithm, children before
 * parents), NEVER a hand-maintained table list. A hand-maintained list rotted before and left 251
 * dead schools behind (a `.catch()` swallowed the RESTRICT failure). ONE copy of this walk exists:
 * the test teardown (`destroyTenant`) delegates here, so cleanup can never drift from the real purge.
 *
 * ⚠️ `purgeTenant` is IRREVERSIBLE. Callers MUST gate it behind SA-P5 (a retention window that has
 * elapsed + an explicit confirmation). It runs on a BYPASSRLS connection (cross-tenant) and FAILS
 * LOUDLY if the school survives — a silent cleanup failure is exactly what created the mess before.
 */
export type RawSqlClient = {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};

/** The FK graph is stable for the life of a process; compute the delete order once. */
let cachedOrder: string[] | null = null;

/** Every `school_id` table, ordered children-first (Kahn's algorithm over the live FK edges). */
async function tenantTablesChildrenFirst(client: RawSqlClient): Promise<string[]> {
  if (cachedOrder) return cachedOrder;

  const rows = await client.$queryRawUnsafe<{ table_name: string }[]>(`
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'school_id'
      AND t.table_type = 'BASE TABLE'
      AND c.table_name <> 'schools'
  `);
  const tenant = new Set(rows.map((r) => r.table_name));

  const edges = await client.$queryRawUnsafe<{ child: string; parent: string }[]>(`
    SELECT DISTINCT con.conrelid::regclass::text AS child, con.confrelid::regclass::text AS parent
    FROM pg_constraint con WHERE con.contype = 'f'
  `);

  const dependents = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const t of tenant) { dependents.set(t, new Set()); indegree.set(t, 0); }
  for (const { child, parent } of edges) {
    if (!tenant.has(child) || !tenant.has(parent) || child === parent) continue;
    if (dependents.get(parent)!.has(child)) continue;
    dependents.get(parent)!.add(child);
    indegree.set(child, (indegree.get(child) ?? 0) + 1);
  }

  const order: string[] = [];
  const queue = [...tenant].filter((t) => (indegree.get(t) ?? 0) === 0);
  while (queue.length) {
    const t = queue.shift()!;
    order.push(t);
    for (const child of dependents.get(t) ?? []) {
      const n = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, n);
      if (n === 0) queue.push(child);
    }
  }
  for (const t of tenant) if (!order.includes(t)) order.push(t); // cycle fallback

  cachedOrder = order.reverse(); // children before parents
  return cachedOrder;
}

/**
 * IRREVERSIBLE hard-delete of one tenant: every `school_id` table children-first, then the school
 * row. Throws if the school survives (the zero-orphan guarantee). Gate behind SA-P5 before calling.
 * Returns per-table deleted counts for the audit trail.
 */
export async function purgeTenant(client: RawSqlClient, schoolId: string): Promise<{ deleted: Record<string, number> }> {
  const tables = await tenantTablesChildrenFirst(client);
  const deleted: Record<string, number> = {};
  for (const t of tables) {
    // Quoted identifier; `t` comes from information_schema, never from user input.
    const n = await client.$executeRawUnsafe(`DELETE FROM "${t}" WHERE school_id = $1::uuid`, schoolId);
    if (n) deleted[t] = n;
  }
  await client.$executeRawUnsafe('DELETE FROM "schools" WHERE id = $1::uuid', schoolId);

  const [{ count }] = await client.$queryRawUnsafe<{ count: bigint }[]>(
    'SELECT count(*)::bigint AS count FROM schools WHERE id = $1::uuid',
    schoolId,
  );
  if (Number(count) !== 0) {
    throw new Error(
      `purgeTenant: school ${schoolId} survived cleanup — something references it that the FK graph did not cover.`,
    );
  }
  return { deleted };
}

/** Columns whose raw value must never leave in a data export handed to a school. */
const SENSITIVE = /(password|secret|_enc$|_hash$|cnic|bank_account)/i;
function redactRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = SENSITIVE.test(k) && v != null ? '[redacted]' : v;
  return out;
}

/**
 * A full data export of one tenant (SA7) — every `school_id` table's rows + the school row, with
 * sensitive columns (password / hash / encrypted / CNIC / bank) REDACTED so credentials never leave
 * in the handover. Returns JSON; the DR-runbook R2-streaming export is the large-scale version.
 */
export async function exportTenant(client: RawSqlClient, schoolId: string): Promise<{ generatedAt: string; rowCounts: Record<string, number>; tables: Record<string, unknown[]> }> {
  const tables = await tenantTablesChildrenFirst(client);
  const out: Record<string, unknown[]> = {};
  const rowCounts: Record<string, number> = {};
  for (const t of tables) {
    const rows = await client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "${t}" WHERE school_id = $1::uuid`, schoolId);
    if (rows.length) {
      out[t] = rows.map(redactRow);
      rowCounts[t] = rows.length;
    }
  }
  const school = await client.$queryRawUnsafe<Record<string, unknown>[]>('SELECT * FROM schools WHERE id = $1::uuid', schoolId);
  out['schools'] = school.map(redactRow);
  rowCounts['schools'] = school.length;
  return { generatedAt: new Date().toISOString(), rowCounts, tables: out };
}
