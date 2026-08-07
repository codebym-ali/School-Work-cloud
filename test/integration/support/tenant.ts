/**
 * Everything this file actually needs from a client: raw SQL.
 *
 * Typed structurally rather than as `PlatformPrismaService` so the **Playwright** teardown can
 * reuse it with a bare `PrismaClient` — it runs outside Nest and cannot construct a Nest service.
 * The alternative was a second copy of the FK-graph walk, and a second copy is exactly how the
 * hand-maintained table lists described below rotted apart in the first place.
 */
export type RawSqlClient = {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};

/**
 * Delete a test tenant and everything under it.
 *
 * Replaces the hand-maintained `const tables = [...]` list each spec used to carry. Those
 * lists rotted: several omitted `smsTemplate` (provisioning seeds templates per school), so
 * the final `school` delete hit a RESTRICT foreign key, and the `.catch(() => undefined)`
 * around it swallowed the failure — leaving the tenant and its rows behind for ever. The
 * database had accumulated 251 dead schools that way, and every suite run added more.
 *
 * This derives the order from the live foreign-key graph instead, so a table added tomorrow
 * is handled without editing 21 specs. It also FAILS LOUDLY if the school survives, because a
 * silent cleanup failure is what created the mess in the first place.
 */
export async function destroyTenant(platform: RawSqlClient, schoolId: string): Promise<void> {
  const tables = await tenantTablesChildrenFirst(platform);
  for (const t of tables) {
    // Quoted identifier; `t` comes from information_schema, never from user input.
    await platform.$executeRawUnsafe(`DELETE FROM "${t}" WHERE school_id = $1::uuid`, schoolId);
  }
  await platform.$executeRawUnsafe('DELETE FROM "schools" WHERE id = $1::uuid', schoolId);

  const [{ count }] = await platform.$queryRawUnsafe<{ count: bigint }[]>(
    'SELECT count(*)::bigint AS count FROM schools WHERE id = $1::uuid',
    schoolId,
  );
  if (Number(count) !== 0) {
    throw new Error(
      `destroyTenant: school ${schoolId} survived cleanup — something references it that the FK graph did not cover.`,
    );
  }
}

/** Cache: the FK graph is identical for every spec in a run. */
let cached: string[] | null = null;

/**
 * Every table carrying `school_id`, ordered so children come before their parents.
 * Kahn's algorithm over the FK edges; self-references and cycles are tolerated by
 * appending whatever is left (Postgres will still accept those deletes in any order
 * once the rest is gone).
 */
async function tenantTablesChildrenFirst(platform: RawSqlClient): Promise<string[]> {
  if (cached) return cached;

  const rows = await platform.$queryRawUnsafe<{ table_name: string }[]>(`
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

  const edges = await platform.$queryRawUnsafe<{ child: string; parent: string }[]>(`
    SELECT DISTINCT
      con.conrelid::regclass::text  AS child,
      con.confrelid::regclass::text AS parent
    FROM pg_constraint con
    WHERE con.contype = 'f'
  `);

  // parent -> children it must wait for
  const dependents = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const t of tenant) { dependents.set(t, new Set()); indegree.set(t, 0); }

  for (const { child, parent } of edges) {
    if (!tenant.has(child) || !tenant.has(parent) || child === parent) continue;
    if (dependents.get(parent)!.has(child)) continue;
    dependents.get(parent)!.add(child);
    indegree.set(child, (indegree.get(child) ?? 0) + 1);
  }

  // Leaves (nothing depends on them) go first.
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

  cached = order.reverse(); // children before parents
  return cached;
}
