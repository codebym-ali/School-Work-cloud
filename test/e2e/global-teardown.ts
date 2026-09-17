import { PrismaClient } from '@prisma/client';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_CAMPUS_NAME } from './helpers';
import { destroyTenant } from '../integration/support/tenant';

/**
 * Exactly what `admin.spec` provisions: `admin-` followed by a `Date.now()` stamp.
 *
 * Anchored and digits-only on purpose. A looser `admin%` would also match a real tenant called
 * `admin` or `administration`, and this deletes a school and everything under it — the blast
 * radius of a wrong match is the whole tenant.
 */
// `qa<stamp>` is the Owner Gaps QA world (test/e2e/qa/qa.setup.ts) — same anchored, digits-only shape.
// `QA_KEEP=1` leaves QA schools in place, to inspect a failed run by hand.
const PROVISIONED_BY_SUITE = process.env.QA_KEEP === '1' ? '^admin-[0-9]+$' : '^(admin-|qa)[0-9]+$';

/**
 * Retire what the suite enrolled, after every run.
 *
 * The suite creates a class + section + admitted student per run, all inside its own
 * `E2E Automation` campus (so the school's real campuses stay clean). That was accepted as
 * harmless accumulation — right up until the G3 work shipped, when the operator's dashboard
 * started reporting **71 registers not marked today**, 67 of them test classes. Debris stopped
 * being cosmetic the moment a real metric counted it.
 *
 * ⚠️ **"Withdrawn, not deleted" was only half right — revised 2026-08-12.** The reasoning below
 * still holds for the ENROLMENT, and withdrawal is still the first step. What it got wrong was
 * stopping there: a withdrawn child leaves every ACTIVE-based metric but stays on the Students
 * screen forever, and the rows reached **68**. The student records are now removed too, the way
 * the product itself removes them — see the second block in the body.
 *
 * Withdrawn first, for two reasons:
 *  - the API *correctly refuses* to delete a class that has students, and a test helper must not
 *    reach past a rule the product enforces on purpose;
 *  - every metric that was polluted — the unmarked-register count, `enrollmentCount`, the
 *    attendance coverage denominator — counts **ACTIVE** enrolments. Withdrawing is precisely the
 *    real-world statement "these students left", which is true: they were never real.
 *
 * The classes and sections stay, empty and inert — and that is now deliberate rather than merely
 * tolerated: the suite reuses **one stable class per spec** instead of minting one per run, so they
 * are the fixture, not litter. ⚠️ The old note ended "in a campus nobody looks at", which is the
 * sentence that let **185 fixture classes** accumulate against 3 real ones until Cover and
 * student-Move began listing every class in the school.
 *
 * Best-effort by design: a teardown that fails must not turn a green run red.
 */
export default async function globalTeardown(): Promise<void> {
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

  const prisma = new PrismaClient({
    datasourceUrl: process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  try {
    await destroyProvisionedTenants(prisma);

    const campuses = await prisma.campus.findMany({
      where: { name: E2E_CAMPUS_NAME },
      select: { id: true },
    });
    if (!campuses.length) return;

    const { count } = await prisma.studentEnrollment.updateMany({
      where: { campusId: { in: campuses.map((c) => c.id) }, status: 'ACTIVE' },
      data: { status: 'WITHDRAWN', endedAt: new Date() },
    });
    if (count > 0) {
      // eslint-disable-next-line no-console
      console.log(`\n[e2e teardown] withdrew ${count} test enrolment(s) from "${E2E_CAMPUS_NAME}".`);
    }

    // ── ...and then remove the child records themselves ────────────────────────
    // Withdrawing alone left every seeded `Student <ts>` sitting in the Students list forever: they
    // had left every ACTIVE-based metric but not the screen, and reached **68 rows**. This mirrors
    // `StudentsService.softDelete` — the same `deletedAt` + `isActive` write it performs, and the
    // same refusal to touch a student carrying **payment or certificate history**, which is a real
    // record rather than debris. Those few stay withdrawn, which is exactly what that rule is for.
    const removable = await prisma.student.findMany({
      where: {
        deletedAt: null,
        // ⚠️ Scoped by CAMPUS, not by name. A `fullName: 'Student %'` filter missed the CSV
        // import spec's `Imp One <ts>` / `Imp Two <ts>` siblings entirely — 22 of them had piled up
        // — and would miss whatever the next spec decides to call its children. Enrolment in the
        // suite's own campus is what actually makes a record fixture data.
        enrollments: { some: { campusId: { in: campuses.map((c) => c.id) } } },
        invoices: { none: { payments: { some: {} } } },
      },
      select: { id: true },
    });
    // `Student` has no back-relation to Document, so certificates are excluded with a second
    // query rather than a nested filter — the service checks the same two things this way.
    const withDocs = new Set(
      (await prisma.document.findMany({
        where: { studentId: { in: removable.map((r) => r.id) } },
        select: { studentId: true },
      })).map((d) => d.studentId),
    );
    const toRemove = removable.filter((r) => !withDocs.has(r.id));
    if (toRemove.length > 0) {
      await prisma.student.updateMany({
        where: { id: { in: toRemove.map((r) => r.id) } },
        data: { deletedAt: new Date(), isActive: false },
      });
      // eslint-disable-next-line no-console
      console.log(`[e2e teardown] removed ${toRemove.length} seeded student record(s).`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[e2e teardown] skipped: ${(err as Error).message}`);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Remove the tenants the suite provisioned through the vendor console.
 *
 * `admin.spec` provisions one `admin-<timestamp>` tenant on **every** full run and never removed
 * it, so the count grew with how often the suite was run rather than with how much was built —
 * 19 of them by the time this was written. The integration suite had the same leak and it was
 * fixed with `destroyTenant`; this is the Playwright half, and it reuses that same function
 * rather than reimplementing the delete order.
 *
 * Deletes **every** match, not just this run's, so one run drains the backlog instead of
 * resetting a counter that starts climbing again immediately.
 *
 * Best-effort like the rest of this file: a teardown failure must not turn a green run red.
 */
async function destroyProvisionedTenants(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<{ id: string; subdomain: string }[]>(
    'SELECT id, subdomain FROM schools WHERE subdomain ~ $1',
    PROVISIONED_BY_SUITE,
  );
  if (!rows.length) return;

  let removed = 0;
  for (const row of rows) {
    try {
      await destroyTenant(prisma, row.id);
      removed++;
    } catch (err) {
      // Named, not swallowed. A silent cleanup failure is what produced the backlog.
      // eslint-disable-next-line no-console
      console.warn(`[e2e teardown] could not remove tenant ${row.subdomain}: ${(err as Error).message}`);
    }
  }
  // eslint-disable-next-line no-console
  if (removed) console.log(`\n[e2e teardown] removed ${removed} suite-provisioned tenant(s).`);
}
