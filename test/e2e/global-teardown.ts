import { PrismaClient } from '@prisma/client';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_CAMPUS_NAME } from './helpers';

/**
 * Retire what the suite enrolled, after every run.
 *
 * The suite creates a class + section + admitted student per run, all inside its own
 * `E2E Automation` campus (so the school's real campuses stay clean). That was accepted as
 * harmless accumulation — right up until the G3 work shipped, when the operator's dashboard
 * started reporting **71 registers not marked today**, 67 of them test classes. Debris stopped
 * being cosmetic the moment a real metric counted it.
 *
 * **Withdrawn, not deleted**, for two reasons:
 *  - the API *correctly refuses* to delete a class that has students, and a test helper must not
 *    reach past a rule the product enforces on purpose;
 *  - every metric that was polluted — the unmarked-register count, `enrollmentCount`, the
 *    attendance coverage denominator — counts **ACTIVE** enrolments. Withdrawing is precisely the
 *    real-world statement "these students left", which is true: they were never real.
 *
 * The classes and sections stay, empty and inert, in a campus nobody looks at. Deleting them
 * would need the enrolments gone first, and destroying student rows to tidy a dev database is a
 * bigger hammer than the problem.
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
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[e2e teardown] skipped: ${(err as Error).message}`);
  } finally {
    await prisma.$disconnect();
  }
}
