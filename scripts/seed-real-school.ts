/**
 * Rebuild the database with ONE realistic school for hands-on testing.
 *
 * Replaces the accumulated dummy/E2E/QA data with a believable City Grammar School: an owner, the
 * full staff bench (campus admin, accountant, HR, admission officer, teachers), classes/sections/
 * subjects, ~30 students with guardians and enrolments, a fee head + per-class fee structures +
 * this month's invoices (some paid, some pending, some overdue), and ~2 weeks of student AND staff
 * attendance history — enough to exercise every screen with lifelike numbers.
 *
 * All login credentials are written to SEED-CREDENTIALS.md (gitignored) so future testing is a
 * copy-paste away.
 *
 *   npx ts-node scripts/seed-real-school.ts            # DRY RUN: build it all in a rolled-back
 *                                                      #   transaction to validate; writes creds file.
 *   npx ts-node scripts/seed-real-school.ts --commit   # DESTRUCTIVE: purge every existing school,
 *                                                      #   then create the school under `demo`.
 *
 * Safety: dry run writes nothing to the DB (one transaction, rolled back) and uses a throwaway
 * subdomain so it cannot collide with the live `demo`. --commit is the only mode that deletes.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { Role, StaffType } from '@prisma/client';
import * as argon2 from 'argon2';
import { purgeTenant } from '../libs/database/src/tenant-purge';

// ── env ──────────────────────────────────────────────────────────────────────
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
const HMAC_KEY = process.env.ENCRYPTION_MASTER_KEY;
if (!HMAC_KEY) throw new Error('ENCRYPTION_MASTER_KEY is required (for student CNIC login hashes)');

const COMMIT = process.argv.includes('--commit');
const SUBDOMAIN = COMMIT ? 'demo' : `seed-dryrun-${Date.now()}`;

// ── passwords (documented in SEED-CREDENTIALS.md) ──────────────────────────────
const OWNER_PASSWORD = 'Owner!Secret12';
const STAFF_PASSWORD = 'Staff!Secret12';

const hashCnic = (cnic: string) => createHmac('sha256', HMAC_KEY).update(cnic.replace(/\D/g, '')).digest('hex');

// ── believable Pakistani names ─────────────────────────────────────────────────
const MALE = ['Ahmed', 'Ali', 'Hassan', 'Bilal', 'Usman', 'Hamza', 'Saad', 'Zain', 'Umar', 'Ibrahim', 'Faizan', 'Talha', 'Danish', 'Rehan', 'Shahzaib'];
const FEMALE = ['Ayesha', 'Fatima', 'Zainab', 'Maryam', 'Hira', 'Sana', 'Iqra', 'Areeba', 'Noor', 'Amna', 'Rabia', 'Mahnoor', 'Eman', 'Laiba', 'Aliza'];
const LAST = ['Khan', 'Malik', 'Sheikh', 'Butt', 'Chaudhry', 'Qureshi', 'Ansari', 'Siddiqui', 'Baig', 'Raza', 'Farooq', 'Javed', 'Nawaz', 'Iqbal', 'Aslam'];
const pick = <T>(a: T[], i: number) => a[i % a.length];

interface Cred { role: string; who: string; email?: string; password?: string; note?: string }

async function main() {
  const db = new PrismaClient({ datasourceUrl: process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL });
  const ownerHash = await argon2.hash(OWNER_PASSWORD, { type: argon2.argon2id });
  const staffHash = await argon2.hash(STAFF_PASSWORD, { type: argon2.argon2id });

  try {
    if (COMMIT) {
      const schools = await db.school.findMany({ select: { id: true, subdomain: true } });
      for (const s of schools) {
        await purgeTenant(db, s.id);
        // eslint-disable-next-line no-console
        console.log(`  purged school ${s.subdomain}`);
      }
      const creds = await createAll(db, ownerHash, staffHash);
      writeCreds(creds);
      // eslint-disable-next-line no-console
      console.log(`\n✔ Committed. City Grammar School is live at ${SUBDOMAIN}.localhost. Credentials in SEED-CREDENTIALS.md`);
      return;
    }

    // DRY RUN: build everything in a transaction, then roll back.
    let creds: Cred[] = [];
    await db.$transaction(async (tx) => {
      creds = await createAll(tx as unknown as PrismaClient, ownerHash, staffHash);
      throw new ROLLBACK();
    }, { timeout: 120_000 }).catch((e) => { if (!(e instanceof ROLLBACK)) throw e; });
    writeCreds(creds);
    // eslint-disable-next-line no-console
    console.log('\n(dry run — nothing written; all inserts validated in a rolled-back transaction.');
    console.log(' SEED-CREDENTIALS.md written. Re-run with --commit to purge existing data and apply.)');
  } finally {
    await db.$disconnect();
  }
}

class ROLLBACK extends Error {}

async function createAll(db: PrismaClient, ownerHash: string, staffHash: string): Promise<Cred[]> {
  const creds: Cred[] = [];
  const school = await db.school.create({ data: { name: 'City Grammar School', subdomain: SUBDOMAIN } });
  const sid = school.id;
  const campus = await db.campus.create({ data: { schoolId: sid, name: 'Main Campus', address: 'Model Town, Lahore' } });
  const year = await db.academicYear.create({
    data: { schoolId: sid, name: '2026-27', startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'), isCurrent: true },
  });
  await db.term.create({ data: { schoolId: sid, academicYearId: year.id, name: 'Term 1', startDate: new Date('2026-04-01'), endDate: new Date('2026-09-30') } });

  const mkUser = async (email: string, roles: Role[], hash: string, campusId: string | null) =>
    db.user.create({ data: { schoolId: sid, email, roles, status: 'ACTIVE', passwordHash: hash, passwordChangedAt: new Date(), campusId } });

  // Owner (school-wide).
  const owner = await mkUser('owner@demo.pk', ['OWNER_ADMIN'], ownerHash, null);
  creds.push({ role: 'Owner (OWNER_ADMIN)', who: 'School owner', email: owner.email, password: OWNER_PASSWORD, note: 'owner door /login' });

  // Staff bench. StaffType + designation + employeeCode + campus binding.
  const staffSpecs: { email: string; roles: Role[]; type: StaffType; designation: string; campusBound: boolean; name: string }[] = [
    { email: 'admin@demo.pk', roles: ['CAMPUS_ADMIN'], type: 'ADMIN', designation: 'Campus Administrator', campusBound: true, name: 'Nadia Khan' },
    { email: 'accountant@demo.pk', roles: ['ACCOUNTANT'], type: 'ACCOUNTANT', designation: 'Accountant', campusBound: true, name: 'Imran Malik' },
    // HR_MANAGER is an ACCESS capability granted on top of a base identity — not a standalone role. A user
    // with only ['HR_MANAGER'] is invisible to user admin (not in MANAGEABLE_ROLES) and, campus-less, sees
    // zero staff. So HR is a campus-bound STAFF member WITH the HR_MANAGER capability. (QA 2026-09-24.)
    { email: 'hr@demo.pk', roles: ['STAFF', 'HR_MANAGER'], type: 'ADMIN', designation: 'HR Manager', campusBound: true, name: 'Sadia Sheikh' },
    { email: 'admissions@demo.pk', roles: ['ADMISSION_CONTROLLER'], type: 'ADMIN', designation: 'Admission Officer', campusBound: true, name: 'Bilal Qureshi' },
    // The owner's deputy — school-wide (no campus), a base STAFF identity with the OPERATIONS_ADMIN
    // capability, so the deputy entity is testable out of the box. (QA 2026-09-25.)
    { email: 'ops@demo.pk', roles: ['STAFF', 'OPERATIONS_ADMIN'], type: 'ADMIN', designation: 'Operations Admin', campusBound: false, name: 'Kamran Rashid' },
  ];
  const teacherNames = ['Ayesha Farooq', 'Usman Raza', 'Hira Ansari', 'Saad Baig', 'Maryam Javed'];
  teacherNames.forEach((name, i) =>
    staffSpecs.push({ email: `teacher${i + 1}@demo.pk`, roles: ['TEACHER'], type: 'TEACHER', designation: 'Teacher', campusBound: true, name }));

  const teachers: { staffId: string; userId: string }[] = [];
  let empSeq = 1;
  for (const s of staffSpecs) {
    const u = await mkUser(s.email, s.roles, staffHash, s.campusBound ? campus.id : null);
    const staff = await db.staffProfile.create({
      data: {
        schoolId: sid, userId: u.id, staffType: s.type, employeeCode: `EMP-${String(empSeq++).padStart(3, '0')}`,
        fullName: s.name, designation: s.designation, joinedAt: new Date('2024-04-01'),
      },
    });
    if (s.type === 'TEACHER') teachers.push({ staffId: staff.id, userId: u.id });
    creds.push({ role: s.roles.join(', '), who: s.name, email: s.email, password: STAFF_PASSWORD });
  }

  // Classes → sections → subjects.
  const SUBJECTS = ['Mathematics', 'English', 'Urdu', 'Islamiyat', 'Science', 'Computer'];
  const CLASSES = [
    { name: 'Grade 6', order: 6, tuition: 3500 },
    { name: 'Grade 7', order: 7, tuition: 4000 },
    { name: 'Grade 8', order: 8, tuition: 4500 },
  ];
  const feeHead = await db.feeHead.create({ data: { schoolId: sid, name: 'Tuition' } });

  const sections: { id: string; classId: string; className: string; label: string }[] = [];
  for (const c of CLASSES) {
    const klass = await db.class.create({ data: { schoolId: sid, campusId: campus.id, name: c.name, order: c.order } });
    for (const sub of SUBJECTS) {
      await db.subject.create({ data: { schoolId: sid, classId: klass.id, name: sub, periodsPerWeek: sub === 'Mathematics' || sub === 'English' ? 6 : 4 } });
    }
    await db.feeStructure.create({
      data: { schoolId: sid, campusId: campus.id, classId: klass.id, feeHeadId: feeHead.id, academicYearId: year.id, amount: c.tuition, frequency: 'MONTHLY', effectiveFrom: new Date('2026-04-01') },
    });
    for (const secName of ['A', 'B']) {
      const sec = await db.section.create({ data: { schoolId: sid, classId: klass.id, name: secName } });
      sections.push({ id: sec.id, classId: klass.id, className: c.name, label: `${c.name}-${secName}` });
    }
  }

  // Homeroom teachers: one teacher per section (cycling), as class-teacher (subjectId null).
  for (let i = 0; i < sections.length; i++) {
    const t = teachers[i % teachers.length];
    await db.teacherAssignment.create({ data: { schoolId: sid, staffId: t.staffId, academicYearId: year.id, sectionId: sections[i].id, subjectId: null } });
  }

  // Students + guardians + enrolments, then invoices + attendance.
  const now = new Date();
  const curMonth = now.getUTCMonth() + 1;
  const curYear = now.getUTCFullYear();
  const tuitionOf = (className: string) => CLASSES.find((c) => c.name === className)!.tuition;
  const markDays = recentWorkingDays(12);

  let grSeq = 1;
  let regSeq = 1;
  let receiptNo = 1;
  let idx = 0;
  const sampleStudentLogins: Cred[] = [];

  for (const sec of sections) {
    for (let r = 1; r <= 5; r++) {
      const male = idx % 2 === 0;
      const first = male ? pick(MALE, idx) : pick(FEMALE, idx);
      const last = pick(LAST, idx + 3);
      const fullName = `${first} ${last}`;
      const gr = `GR-${String(grSeq++).padStart(4, '0')}`;
      const regNo = `REG-2026-${String(regSeq++).padStart(4, '0')}`;
      const cnic = `35201${String(1000000 + idx).padStart(7, '0')}${male ? '1' : '2'}`; // 13-digit, realistic shape

      // A few students get a working student-portal login (registration no + CNIC).
      const givePortal = idx < 3;
      let studentUserId: string | null = null;
      if (givePortal) {
        const su = await db.user.create({ data: { schoolId: sid, email: `student${idx + 1}@demo.pk`, roles: ['STUDENT'], status: 'ACTIVE', campusId: campus.id } });
        studentUserId = su.id;
      }

      const student = await db.student.create({
        data: {
          schoolId: sid, grNumber: gr, registrationNo: regNo, fullName, gender: male ? 'MALE' : 'FEMALE',
          dateOfBirth: new Date(Date.UTC(2013 - Math.floor(idx / 6), (idx % 12), 5)),
          city: 'Lahore', addressLine: `House ${100 + idx}, Model Town`, nationality: 'Pakistani',
          status: 'ACTIVE', isActive: true, createdById: owner.id,
          ...(givePortal ? { userId: studentUserId, cnicHash: hashCnic(cnic) } : {}),
        },
      });

      const guardianName = `${pick(MALE, idx + 5)} ${last}`;
      // Most guardians have a VERIFIED phone so SMS/broadcast reaches real recipients and can be tested;
      // every 10th is left unverified on purpose, to exercise the withheld/unverified path (Obs-2).
      const phoneVerified = idx % 10 !== 0;
      const parent = await db.parentProfile.create({
        data: {
          schoolId: sid,
          fullName: guardianName,
          phone: `+92300${String(1000000 + idx).padStart(7, '0')}`,
          occupation: pick(['Businessman', 'Doctor', 'Engineer', 'Teacher', 'Shopkeeper'], idx),
          ...(phoneVerified ? { phoneVerifiedAt: new Date('2026-04-05') } : {}),
        },
      });
      await db.studentGuardian.create({ data: { schoolId: sid, studentId: student.id, parentId: parent.id, relation: 'FATHER', isPrimary: true } });

      const enrol = await db.studentEnrollment.create({
        data: { schoolId: sid, studentId: student.id, academicYearId: year.id, campusId: campus.id, classId: sec.classId, sectionId: sec.id, rollNumber: r, status: 'ACTIVE', startedAt: new Date('2026-04-01') },
      });

      // This month's tuition invoice: ~55% paid, ~15% partial, ~15% pending, ~15% overdue.
      const tuition = tuitionOf(sec.className);
      const dueDay = 10;
      const bucket = idx % 20;
      const overdue = bucket < 3;
      const dueDate = overdue ? new Date(Date.UTC(curYear, curMonth - 2, dueDay)) : new Date(Date.UTC(curYear, curMonth - 1, dueDay));
      const paidFull = bucket >= 3 && bucket < 14;
      const partial = bucket >= 14 && bucket < 17;
      const paidAmount = paidFull ? tuition : partial ? Math.round(tuition / 2) : 0;
      const status = paidFull ? 'PAID' : partial ? 'PARTIAL' : overdue ? 'OVERDUE' : 'PENDING';
      const invoice = await db.feeInvoice.create({
        data: {
          schoolId: sid, studentId: student.id, enrollmentId: enrol.id, totalAmount: tuition, paidAmount,
          dueDate, status, month: overdue ? (curMonth === 1 ? 12 : curMonth - 1) : curMonth, year: curYear,
        },
      });
      await db.feeInvoiceItem.create({ data: { schoolId: sid, invoiceId: invoice.id, type: 'FEE', feeHeadId: feeHead.id, description: `Tuition — ${sec.className}`, amount: tuition } });
      if (paidAmount > 0) {
        await db.feePayment.create({
          data: { schoolId: sid, invoiceId: invoice.id, receiptNo: receiptNo++, amountPaid: paidAmount, method: 'CASH', collectedById: owner.id, paidAt: new Date(Date.UTC(curYear, curMonth - 1, 5)) },
        });
      }

      // Attendance history: mostly present, some absent/late.
      for (const d of markDays) {
        const seed = (idx * 7 + d.getUTCDate()) % 20;
        const st = seed === 0 ? 'ABSENT' : seed === 1 ? 'LATE' : seed === 2 ? 'ON_LEAVE' : 'PRESENT';
        await db.attendanceRecord.create({ data: { schoolId: sid, enrollmentId: enrol.id, date: d, session: 'MORNING', status: st, markedById: owner.id } });
      }

      if (givePortal) sampleStudentLogins.push({ role: 'Student (portal)', who: fullName, note: `door /login (student) · Registration No ${regNo} · CNIC ${cnic}` });
      idx++;
    }
  }

  // Continue the register from where the seed left off, in the SAME format the app's generator produces
  // (prefixed + zero-padded), so the next LIVE admission is GR-0031 / REG-2026-0031 — never a bare number,
  // and never colliding with a seeded GR. (QA C, 2026-09-24.)
  await db.school.update({
    where: { id: sid },
    data: { grPrefix: 'GR-', nextGrNumber: grSeq, registrationPrefix: 'REG-2026-', nextRegistrationNo: regSeq },
  });

  // Staff attendance history for the teachers (present, occasional absence).
  for (const [ti, t] of teachers.entries()) {
    for (const d of markDays) {
      const seed = (ti * 5 + d.getUTCDate()) % 15;
      const st = seed === 0 ? 'ABSENT' : seed === 1 ? 'LATE' : 'PRESENT';
      await db.staffAttendance.create({ data: { schoolId: sid, staffId: t.staffId, date: d, session: 'MORNING', status: st, source: 'ADMIN', markedById: owner.id } });
    }
  }

  // Advance the school's gap-free receipt sequence past the receipts we hand-assigned above, or the
  // first real payment/reversal would reuse receiptNo 1 and hit the (schoolId, receiptNo) unique.
  await db.school.update({ where: { id: sid }, data: { nextReceiptNo: receiptNo } });

  creds.push(...sampleStudentLogins);
  return creds;
}

/** The last `n` working days (skip Sundays), oldest first, as UTC date-only. */
function recentWorkingDays(n: number): Date[] {
  const out: Date[] = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  while (out.length < n) {
    if (d.getUTCDay() !== 0) out.unshift(new Date(d));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

function writeCreds(creds: Cred[]) {
  const lines = [
    '# Seed credentials — City Grammar School (demo tenant)',
    '',
    `Host: **${(COMMIT ? 'demo' : 'demo')}.localhost** · owner-web :3005 · staff-web :3006 · student-web :3003`,
    '',
    '| Role | Name | Email / login | Password |',
    '|------|------|---------------|----------|',
    ...creds.map((c) => `| ${c.role} | ${c.who} | ${c.email ?? c.note ?? ''} | ${c.password ?? '(reg-no + CNIC)'} |`),
    '',
    '_Students sign in at the student door with Registration No + CNIC (no password). Staff and owner use email + password._',
    '',
    `_Generated ${new Date().toISOString()} by scripts/seed-real-school.ts_`,
  ];
  writeFileSync(join(process.cwd(), 'SEED-CREDENTIALS.md'), `${lines.join('\n')}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
