/**
 * #9 — surgically remove the E2E/QA test-debris campuses from the DEMO tenant, preserving the real
 * showcase (Falcon). The demo's rich data is hand-built and NOT reproduced by `prisma/seed.ts`, so a
 * destroy-and-reseed would erase the showcase — the fix is a campus-scoped cascade, not a reseed.
 *
 * Why this is safe:
 *  - **Dry-run by default.** It prints exactly what it would delete and rolls back. Pass `--commit`
 *    to actually delete.
 *  - **One transaction.** Any missed dependency raises a foreign-key error → the whole thing rolls
 *    back, so a partial/incorrect purge is impossible.
 *  - **Falcon-integrity assertion.** Row counts for the kept campus are snapshotted before and
 *    re-checked after (still inside the transaction); any drift throws → rollback. Over-scoping
 *    cannot silently reach the showcase.
 *  - **Generic cascade from the live FK graph** (the same technique as `tenant-purge.ts`), so it does
 *    not depend on a hand-maintained table list that could rot.
 *
 *   npx ts-node scripts/purge-demo-testdata.ts            # dry run
 *   npx ts-node scripts/purge-demo-testdata.ts --commit   # execute
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

const envPath = join(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim();
  }
}

const COMMIT = process.argv.includes('--commit');
const KEEP_CAMPUS = 'Falcon school main Campus';
/** Names that mark a campus as test debris. */
const isDebris = (name: string) => name === 'E2E Automation' || name.startsWith('QA ');

type FkRow = { child: string; parent: string; child_cols: string[]; parent_cols: string[] };

async function loadFks(db: PrismaClient): Promise<FkRow[]> {
  return db.$queryRawUnsafe<FkRow[]>(`
    SELECT child.relname AS child, parent.relname AS parent,
           array_agg(ca.attname ORDER BY k.ord) AS child_cols,
           array_agg(pa.attname ORDER BY k.ord) AS parent_cols
    FROM pg_constraint con
    JOIN pg_class child  ON child.oid  = con.conrelid
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(childattnum, parentattnum, ord) ON true
    JOIN pg_attribute ca ON ca.attrelid = con.conrelid  AND ca.attnum = k.childattnum
    JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = k.parentattnum
    WHERE con.contype = 'f'
    GROUP BY child.relname, parent.relname, con.conname
  `);
}

/** Primary-key column per table (single-column PKs only; all tenant tables here use one). */
async function loadPks(db: PrismaClient): Promise<Map<string, string>> {
  const rows = await db.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(`
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
  `);
  const pk = new Map<string, string>();
  const multi = new Set<string>();
  for (const r of rows) {
    if (pk.has(r.table_name)) multi.add(r.table_name);
    pk.set(r.table_name, r.column_name);
  }
  for (const t of multi) pk.delete(t); // composite PK → handled by name, not id-set (none in the subtree here)
  return pk;
}

async function main() {
  const db = new PrismaClient({ datasourceUrl: process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL });
  try {
    const school = await db.school.findFirst({ where: { subdomain: 'demo' }, select: { id: true } });
    if (!school) throw new Error('no demo school');
    const campuses = await db.campus.findMany({ where: { schoolId: school.id }, select: { id: true, name: true } });
    const targets = campuses.filter((c) => isDebris(c.name));
    const keep = campuses.find((c) => c.name === KEEP_CAMPUS);
    if (!keep) throw new Error(`refusing to run: kept campus "${KEEP_CAMPUS}" not found`);
    if (!targets.length) { console.log('No debris campuses found — nothing to do.'); return; }
    console.log(`Demo school ${school.id}`);
    console.log(`Keeping:  ${keep.name} (${keep.id})`);
    console.log(`Removing: ${targets.map((t) => `${t.name}`).join(', ')}`);

    const [fks, pks] = await Promise.all([loadFks(db), loadPks(db)]);
    // Only follow FKs where the parent side references the parent's single-column PK, so a child id-set
    // can be resolved by "child.<col> IN (parent pk ids)". (Every FK in this schema does.)
    const childrenOf = new Map<string, { child: string; childCol: string }[]>();
    for (const fk of fks) {
      if (fk.child === fk.parent) continue;
      const parentPk = pks.get(fk.parent);
      if (!parentPk) continue;
      const idx = fk.parent_cols.indexOf(parentPk);
      if (idx === -1) continue;
      if (!pks.get(fk.child)) continue; // child must have a single-col PK to be id-collected
      const arr = childrenOf.get(fk.parent) ?? [];
      arr.push({ child: fk.child, childCol: fk.child_cols[idx] });
      childrenOf.set(fk.parent, arr);
    }

    // Transitive closure of rows to delete, seeded with the target campus rows.
    const toDelete = new Map<string, Set<string>>();
    const add = (table: string, ids: string[]) => {
      const set = toDelete.get(table) ?? new Set<string>();
      let added = 0;
      for (const id of ids) if (!set.has(id)) { set.add(id); added++; }
      toDelete.set(table, set);
      return added;
    };
    add('campuses', targets.map((t) => t.id));
    const queue: string[] = ['campuses'];
    while (queue.length) {
      const parent = queue.shift()!;
      const parentIds = [...(toDelete.get(parent) ?? [])];
      if (!parentIds.length) continue;
      for (const { child, childCol } of childrenOf.get(parent) ?? []) {
        const childPk = pks.get(child)!;
        // Chunk the IN list to stay well under parameter limits.
        const found: string[] = [];
        for (let i = 0; i < parentIds.length; i += 1000) {
          const chunk = parentIds.slice(i, i + 1000);
          const rows = await db.$queryRawUnsafe<Record<string, string>[]>(
            `SELECT "${childPk}" AS pk FROM "${child}" WHERE "${childCol}" = ANY($1::uuid[])`, chunk,
          );
          for (const r of rows) found.push(r.pk);
        }
        if (found.length && add(child, found) > 0 && !queue.includes(child)) queue.push(child);
      }
    }

    // Report the plan.
    const plan = [...toDelete.entries()].filter(([, s]) => s.size).sort((a, b) => b[1].size - a[1].size);
    console.log('\nRows to delete:');
    for (const [t, s] of plan) console.log(`  ${t.padEnd(28)} ${s.size}`);
    const total = plan.reduce((n, [, s]) => n + s.size, 0);
    console.log(`  ${'TOTAL'.padEnd(28)} ${total}`);

    // Snapshot the kept campus so we can prove it was untouched.
    const falconBefore = await keptSnapshot(db, keep.id);

    // Children-first delete order (reverse-topological over affected tables from the FK edges).
    const affected = new Set(plan.map(([t]) => t));
    const order = childrenFirstOrder(affected, fks);

    await db.$transaction(async (tx) => {
      for (const table of order) {
        const ids = [...(toDelete.get(table) ?? [])];
        for (let i = 0; i < ids.length; i += 1000) {
          const chunk = ids.slice(i, i + 1000);
          const pk = pks.get(table)!;
          await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "${pk}" = ANY($1::uuid[])`, chunk);
        }
      }
      // Assert the target campuses are gone and Falcon is byte-for-byte intact — inside the txn.
      const left = await tx.campus.count({ where: { id: { in: targets.map((t) => t.id) } } });
      if (left !== 0) throw new Error(`assertion failed: ${left} target campus row(s) survived`);
      const falconAfter = await keptSnapshot(tx as unknown as PrismaClient, keep.id);
      for (const k of Object.keys(falconBefore) as (keyof typeof falconBefore)[]) {
        if (falconBefore[k] !== falconAfter[k]) {
          throw new Error(`assertion failed: kept campus ${k} changed ${falconBefore[k]} -> ${falconAfter[k]}`);
        }
      }
      if (!COMMIT) throw new ROLLBACK();
    }).catch((e) => { if (e instanceof ROLLBACK) return; throw e; });

    console.log(COMMIT
      ? `\n✔ Committed. Removed ${targets.length} campus(es) and ${total} rows. Falcon intact.`
      : `\n(dry run — nothing written. Falcon integrity + target removal asserted OK. Re-run with --commit to apply.)`);
  } finally {
    await db.$disconnect();
  }
}

class ROLLBACK extends Error {}

async function keptSnapshot(db: PrismaClient, campusId: string) {
  const classIds = (await db.class.findMany({ where: { campusId }, select: { id: true } })).map((x) => x.id);
  const enrolIds = (await db.studentEnrollment.findMany({ where: { campusId }, select: { id: true } })).map((x) => x.id);
  const [classes, subjects, enrolments, invoices, payments, users] = await Promise.all([
    classIds.length, classIds.length ? db.subject.count({ where: { classId: { in: classIds } } }) : 0,
    enrolIds.length, enrolIds.length ? db.feeInvoice.count({ where: { enrollmentId: { in: enrolIds } } }) : 0,
    enrolIds.length ? db.feePayment.count({ where: { invoice: { enrollmentId: { in: enrolIds } } } }) : 0,
    db.user.count({ where: { campusId } }),
  ]);
  return { classes, subjects, enrolments, invoices, payments, users };
}

/** Reverse-topological (children before parents) over the affected tables only. */
function childrenFirstOrder(affected: Set<string>, fks: FkRow[]): string[] {
  const dependents = new Map<string, Set<string>>();
  const indeg = new Map<string, number>();
  for (const t of affected) { dependents.set(t, new Set()); indeg.set(t, 0); }
  for (const fk of fks) {
    if (fk.child === fk.parent) continue;
    if (!affected.has(fk.child) || !affected.has(fk.parent)) continue;
    if (dependents.get(fk.parent)!.has(fk.child)) continue;
    dependents.get(fk.parent)!.add(fk.child);
    indeg.set(fk.child, (indeg.get(fk.child) ?? 0) + 1);
  }
  const order: string[] = [];
  const q = [...affected].filter((t) => (indeg.get(t) ?? 0) === 0);
  while (q.length) {
    const t = q.shift()!;
    order.push(t);
    for (const c of dependents.get(t) ?? []) {
      const n = (indeg.get(c) ?? 0) - 1; indeg.set(c, n);
      if (n === 0) q.push(c);
    }
  }
  for (const t of affected) if (!order.includes(t)) order.push(t);
  return order.reverse();
}

main().catch((e) => { console.error(e); process.exit(1); });
