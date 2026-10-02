import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AppError,
  attendancePercentFromStatuses,
  ErrorCodes,
  monthlyPerformance,
  StorageService,
  summarisePerformance,
  TenantContext,
} from '@common';
import { TenantPrismaService } from '@database';
import { gradeFor, subjectTermPercent, type ExamMark, type GradeBand } from '../exams/exam-grading';

const money = (n: number): number => Math.round(n * 100) / 100;

/**
 * Parent portal service (blueprint §5, §28, permission matrix §23 — STUDENT column).
 * Strictly read-only and self-scoped: every query resolves the `Student` linked to the
 * logged-in user (`Student.userId`), so the parent can only ever see their child's data.
 */
@Injectable()
export class ParentPortalService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly storage: StorageService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  /** Statuses that revoke portal access. SUSPENDED is deliberately absent — a suspended
   *  student keeps the portal (they still need to see the notice and their fees) and gets a
   *  banner instead; RESTRICTED is the opposite case, still attending but cut off here. */
  private static readonly PORTAL_BLOCKED = ['RESTRICTED', 'STRUCK_OFF', 'WITHDRAWN'] as const;

  /** The Student row for the active child (or the login child if none is selected).
   *  When `activeChildId` is provided (from the cookie), it is validated against the
   *  sibling graph — a parent can only view children linked via StudentGuardian. */
  private async self(activeChildId?: string | null) {
    const userId = this.ctx.user?.userId;
    if (!userId) throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Not authenticated');

    // Try student login first (Student.userId), then parent login (ParentProfile.userId → StudentGuardian → Student).
    const loginStudent = await this.db.student.findFirst({ where: { userId, deletedAt: null } });

    if (!loginStudent) {
      // Parent login path: resolve through ParentProfile → StudentGuardian → Student
      const parentProfile = await this.db.parentProfile.findFirst({ where: { userId } });
      if (!parentProfile) throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'No student or parent profile is linked to this account');

      const guardianLinks = await this.db.studentGuardian.findMany({
        where: { parentId: parentProfile.id },
        include: { student: true },
        orderBy: { isPrimary: 'desc' },
      });
      const children = guardianLinks.map((g) => g.student).filter((s) => s.deletedAt === null);
      if (children.length === 0) throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'No children linked to this parent');

      let student = children[0];
      if (activeChildId) {
        const target = children.find((c) => c.id === activeChildId);
        if (target) student = target;
      }

      if ((ParentPortalService.PORTAL_BLOCKED as readonly string[]).includes(student.status)) {
        throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Your portal access has been restricted. Please contact the school office.');
      }
      return student;
    }

    let student = loginStudent;
    if (activeChildId && activeChildId !== loginStudent.id) {
      const siblings = await this.findSiblings(loginStudent.id);
      const target = siblings.find((s) => s.id === activeChildId);
      if (!target) throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Not your child');
      const full = await this.db.student.findFirst({ where: { id: activeChildId, deletedAt: null } });
      if (!full) throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Not your child');
      student = full;
    }

    if ((ParentPortalService.PORTAL_BLOCKED as readonly string[]).includes(student.status)) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Your portal access has been restricted. Please contact the school office.');
    }
    return student;
  }

  /**
   * Discover all siblings via the StudentGuardian graph:
   * Student → StudentGuardian → ParentProfile → StudentGuardian → Student
   */
  private async findSiblings(studentId: string) {
    const guardianLinks = await this.db.studentGuardian.findMany({
      where: { studentId },
      select: { parentId: true },
    });
    if (!guardianLinks.length) return [];

    const parentIds = guardianLinks.map((g) => g.parentId);
    const allLinks = await this.db.studentGuardian.findMany({
      where: { parentId: { in: parentIds } },
      select: { studentId: true },
    });

    const uniqueStudentIds = [...new Set(allLinks.map((l) => l.studentId))];
    return this.db.student.findMany({
      where: {
        id: { in: uniqueStudentIds },
        deletedAt: null,
        status: { notIn: ['STRUCK_OFF', 'WITHDRAWN'] },
      },
      select: { id: true, fullName: true, grNumber: true, photoKey: true, status: true },
    });
  }

  /** All children the logged-in parent can see, with enrollment info and photo URLs. */
  async children() {
    const userId = this.ctx.user?.userId;
    if (!userId) throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Not authenticated');

    const allChildren = await this.resolveChildren(userId);
    const activeStudent = await this.self();

    const result = await Promise.all(
      allChildren.map(async (s) => {
        const enrollment = await this.db.studentEnrollment.findFirst({
          where: { studentId: s.id, status: 'ACTIVE' },
          include: { section: { include: { class: { select: { name: true } } } } },
          orderBy: { startedAt: 'desc' },
        });
        return {
          id: s.id,
          fullName: s.fullName,
          grNumber: s.grNumber,
          className: enrollment?.section.class.name ?? null,
          sectionName: enrollment?.section.name ?? null,
          photoUrl: s.photoKey ? await this.storage.presignGet(s.photoKey, 600) : null,
          status: s.status,
          isCurrent: s.id === activeStudent.id,
        };
      }),
    );

    return result;
  }

  /** Resolve all children for a user — either via Student.userId (student login) or ParentProfile → StudentGuardian (parent login). */
  private async resolveChildren(userId: string) {
    // Student login: find siblings via guardian graph
    const loginStudent = await this.db.student.findFirst({ where: { userId, deletedAt: null } });
    if (loginStudent) return this.findSiblings(loginStudent.id);

    // Parent login: find children via ParentProfile
    const parentProfile = await this.db.parentProfile.findFirst({ where: { userId } });
    if (!parentProfile) return [];

    const guardianLinks = await this.db.studentGuardian.findMany({
      where: { parentId: parentProfile.id },
      include: { student: { select: { id: true, fullName: true, grNumber: true, photoKey: true, status: true, deletedAt: true } } },
      orderBy: { isPrimary: 'desc' },
    });
    return guardianLinks.map((g) => g.student).filter((s) => s.deletedAt === null);
  }

  /** Validate and switch to a sibling. Returns the updated children list. */
  async switchChild(studentId: string) {
    const loginStudent = await this.self();
    if (studentId === loginStudent.id) return this.children();

    const siblings = await this.findSiblings(loginStudent.id);
    if (!siblings.find((s) => s.id === studentId)) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Not your child');
    }

    return this.children();
  }

  /** Presigned URL for the active child's photo. */
  async photo(activeChildId?: string | null) {
    const student = await this.self(activeChildId);
    if (!student.photoKey) {
      throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'No photo on file');
    }
    return { url: await this.storage.presignGet(student.photoKey, 600), expiresInSeconds: 600 };
  }

  private enrollmentIds(studentId: string): Promise<Array<{ id: string }>> {
    return this.db.studentEnrollment.findMany({ where: { studentId }, select: { id: true } });
  }

  /**
   * "What changed for me" — the student's own notification list.
   *
   * ⚠️ **A SEPARATE implementation from the staff `/notifications`, and that is the design.** The
   * staff service resolves the caller's STAFF PROFILE and carries a hand-copied `NEEDS` map whose
   * own comment warns that "getting one wrong hands a teacher the whole school's figures". A
   * student is not a role with fewer items — they are a different audience entirely, and putting
   * them through that service would leave a child one mistaken gate away from the school's
   * finances. Here, `self()` makes cross-student access structurally impossible.
   *
   * ⚠️ **Derived, never stored** — the same rule as the staff bell. Each item is computed from the
   * record it describes, so when the cause disappears the notice does too, with nothing to clean up.
   *
   * ⚠️ **Fees are deliberately absent.** A child is not the person who pays, and "Rs 12,000
   * overdue" in front of a fourteen-year-old is pressure applied to the wrong human. The invoice is
   * on their Fees page if they look; it is not pushed at them.
   */
  async notifications(activeChildId?: string | null) {
    const student = await this.self(activeChildId);
    const today = startOfUtcDay(new Date());
    const tomorrow = new Date(today.getTime() + 86_400_000);

    const enrollment = await this.db.studentEnrollment.findFirst({
      where: { studentId: student.id, status: 'ACTIVE' },
      select: { id: true, campusId: true },
    });

    // `knownAt` — see the note on the staff service's NotificationItem: a closure's `at` is the
    // day being described, which is in the FUTURE for "shut tomorrow", and newness has to be
    // judged on when the school declared it or the badge can never be cleared.
    const items: { id: string; kind: string; severity: 'info' | 'warn'; at: string; knownAt?: string; text: string; href: string }[] = [];

    // ── The school is shut ────────────────────────────────────────────────────
    // ⚠️ Campus-scoped: `campusId: null` is the whole school, and a closure at one campus must not
    // tell a child at the other one to stay home.
    const closures = await this.db.holiday.findMany({
      where: {
        date: { in: [today, tomorrow] },
        ...(enrollment?.campusId ? { OR: [{ campusId: null }, { campusId: enrollment.campusId }] } : {}),
      },
      orderBy: { date: 'asc' },
    });
    for (const c of closures) {
      const when = c.date.getTime() === today.getTime() ? 'today' : 'tomorrow';
      items.push({
        id: `closed:${c.id}`, kind: 'SCHOOL_CLOSED', severity: 'info',
        at: c.date.toISOString(), knownAt: c.createdAt.toISOString(),
        text: `School is closed ${when} — ${c.name}.`, href: '/',
      });
    }

    // ── You were marked absent ────────────────────────────────────────────────
    // ⚠️ Recent only. This exists so a WRONG mark gets challenged while the register can still be
    // corrected; a month-old absence is history, and listing it just makes the bell noisy.
    if (enrollment) {
      const since = new Date(today.getTime() - 7 * 86_400_000);
      const absences = await this.db.attendanceRecord.findMany({
        where: { enrollmentId: enrollment.id, status: 'ABSENT', date: { gte: since } },
        orderBy: { date: 'desc' },
        take: 5,
      });
      for (const a of absences) {
        items.push({
          id: `absent:${a.id}`, kind: 'MARKED_ABSENT', severity: 'warn',
          at: a.date.toISOString(),
          text: `You were marked absent on ${dayMonth(a.date)}. Tell the office if that is wrong.`,
          href: '/attendance',
        });
      }
    }

    // ── Your leave was decided ────────────────────────────────────────────────
    const leaves = await this.db.studentLeave.findMany({
      where: { studentId: student.id, status: { in: ['APPROVED', 'REJECTED'] }, decidedAt: { gte: new Date(today.getTime() - 14 * 86_400_000) } },
      orderBy: { decidedAt: 'desc' },
      take: 5,
    });
    for (const l of leaves) {
      items.push({
        id: `leave:${l.id}:${l.status}`, kind: 'LEAVE_DECIDED',
        severity: l.status === 'APPROVED' ? 'info' : 'warn',
        at: (l.decidedAt ?? new Date()).toISOString(),
        text: `Your leave request was ${l.status.toLowerCase()}.`,
        href: '/attendance',
      });
    }

    const seenAt = (await this.db.user.findFirst({
      where: { id: this.ctx.user!.userId }, select: { notificationsSeenAt: true },
    }))?.notificationsSeenAt;

    items.sort((a, b) => (a.at < b.at ? 1 : -1));
    // Everything counts as new until they have looked — the same rule as the staff bell, so the
    // number on the badge and the list behind it can never disagree.
    const withNew = items.map(({ knownAt, ...i }) => ({
      ...i,
      isNew: seenAt ? new Date(knownAt ?? i.at) > seenAt : true,
    }));
    return { items: withNew, unread: withNew.filter((i) => i.isNew).length };
  }

  /** "I have looked." Records the visit against the caller and nobody else — no id is accepted. */
  async markNotificationsSeen() {
    await this.self();
    await this.db.user.update({
      where: { id: this.ctx.user!.userId },
      data: { notificationsSeenAt: new Date() },
    });
    return { ok: true };
  }

  async overview(activeChildId?: string | null) {
    const student = await this.self(activeChildId);
    const [enrollment, guardians, invoices, enrolls] = await Promise.all([
      this.db.studentEnrollment.findFirst({
        where: { studentId: student.id, status: 'ACTIVE' },
        include: { section: { include: { class: { select: { name: true } } } }, academicYear: { select: { name: true } }, campus: { select: { name: true } } },
        orderBy: { startedAt: 'desc' },
      }),
      this.db.studentGuardian.findMany({
        where: { studentId: student.id },
        include: { parent: { select: { fullName: true, phone: true, email: true, occupation: true } } },
        orderBy: { isPrimary: 'desc' },
      }),
      // A voucher the owner has not approved has not been issued — the family must not see or owe it.
      this.db.feeInvoice.findMany({ where: { studentId: student.id, status: { not: 'PENDING_APPROVAL' } }, select: { totalAmount: true, paidAmount: true } }),
      this.enrollmentIds(student.id),
    ]);

    const outstandingFees = money(invoices.reduce((s, i) => s + (Number(i.totalAmount) - Number(i.paidAmount)), 0));

    const records = await this.db.attendanceRecord.findMany({
      where: { enrollmentId: { in: enrolls.map((e) => e.id) } },
      select: { status: true },
    });
    const attendancePercent = attendancePercentFromStatuses(records.map((r) => r.status));

    const reportCards = await this.db.reportCard.count({ where: { enrollmentId: { in: enrolls.map((e) => e.id) } } });

    return {
      student: {
        id: student.id,
        fullName: student.fullName,
        grNumber: student.grNumber,
        gender: student.gender,
        dateOfBirth: student.dateOfBirth,
        religion: student.religion,
        bloodGroup: student.bloodGroup,
        medicalNotes: student.medicalNotes,
        addressLine: student.addressLine,
        city: student.city,
        photoUrl: student.photoKey ? await this.storage.presignGet(student.photoKey, 600) : null,
        status: student.status,
        statusReason: student.statusReason,
        statusEndsOn: student.statusEndsOn,
      },
      enrollment: enrollment
        ? {
            className: enrollment.section.class.name,
            sectionName: enrollment.section.name,
            rollNumber: enrollment.rollNumber,
            year: enrollment.academicYear.name,
            campusName: enrollment.campus.name,
            admissionDate: enrollment.startedAt,
          }
        : null,
      guardians: guardians.map((g) => ({
        name: g.parent.fullName,
        phone: g.parent.phone,
        email: g.parent.email,
        occupation: g.parent.occupation,
        relation: g.relation,
        isPrimary: g.isPrimary,
      })),
      attendancePercent,
      outstandingFees,
      reportCards,
    };
  }

  async attendance(activeChildId?: string | null) {
    const student = await this.self(activeChildId);
    const enrolls = await this.enrollmentIds(student.id);
    return this.db.attendanceRecord.findMany({
      where: { enrollmentId: { in: enrolls.map((e) => e.id) } },
      orderBy: [{ date: 'desc' }],
      take: 60,
      select: { date: true, session: true, status: true },
    });
  }

  /**
   * Attendance with the counts already worked out — "how many days was I absent?" is the
   * question, and making a student tally 60 rows to answer it is not an answer.
   */
  async attendanceSummary(days = 30, activeChildId?: string | null) {
    const student = await this.self(activeChildId);
    const enrolls = await this.enrollmentIds(student.id);
    const from = new Date(Date.now() - days * 86400000);

    const records = await this.db.attendanceRecord.findMany({
      where: { enrollmentId: { in: enrolls.map((e) => e.id) }, date: { gte: from } },
      orderBy: [{ date: 'desc' }],
      select: { date: true, session: true, status: true },
    });

    const counts = { PRESENT: 0, ABSENT: 0, LATE: 0, HALF_DAY: 0, ON_LEAVE: 0 } as Record<string, number>;
    for (const r of records) counts[r.status] = (counts[r.status] ?? 0) + 1;

    return {
      days,
      // Same helper the teacher, parent SMS and staff views use — one child must never have
      // two different attendance percentages depending on which screen you open.
      percent: attendancePercentFromStatuses(records.map((r) => r.status)),
      counts,
      records,
    };
  }

  /**
   * Class-test performance, per subject — the operator asked for "each subject a tab, each test's
   * marks, and a monthly report".
   *
   * Deliberately NO class average and NO rank. A child seeing "24th of 30" is a pressure device,
   * not feedback; their own month-on-month trend is what they can act on. Comparison stays on the
   * staff side. (Operator agreed; see Key Decisions.)
   */
  async testPerformance(activeChildId?: string | null) {
    const student = await this.self(activeChildId);
    const enrolls = await this.enrollmentIds(student.id);
    const enrollmentIds = enrolls.map((e) => e.id);

    const scores = await this.db.classTestScore.findMany({
      where: { enrollmentId: { in: enrollmentIds } },
      include: {
        classTest: {
          select: { id: true, name: true, testDate: true, totalMarks: true, subjectId: true, subject: { select: { name: true } } },
        },
      },
      orderBy: { classTest: { testDate: 'desc' } },
    });

    const bySubject = new Map<string, { subjectId: string; subjectName: string; rows: typeof scores }>();
    for (const s of scores) {
      const key = s.classTest.subjectId;
      const bucket = bySubject.get(key);
      if (bucket) bucket.rows.push(s);
      else bySubject.set(key, { subjectId: key, subjectName: s.classTest.subject?.name ?? '—', rows: [s] });
    }

    const subjects = [...bySubject.values()].map(({ subjectId, subjectName, rows }) => {
      const shaped = rows.map((r) => ({
        marksObtained: r.marksObtained == null ? null : Number(r.marksObtained),
        totalMarks: Number(r.classTest.totalMarks),
        isAbsent: r.isAbsent,
        testDate: r.classTest.testDate,
      }));
      return {
        subjectId,
        subjectName,
        summary: summarisePerformance(shaped),
        monthly: monthlyPerformance(shaped),
        tests: rows.map((r) => ({
          id: r.classTest.id,
          name: r.classTest.name,
          testDate: r.classTest.testDate,
          totalMarks: Number(r.classTest.totalMarks),
          marksObtained: r.marksObtained == null ? null : Number(r.marksObtained),
          isAbsent: r.isAbsent,
        })),
      };
    });
    subjects.sort((a, b) => a.subjectName.localeCompare(b.subjectName));

    const all = scores.map((r) => ({
      marksObtained: r.marksObtained == null ? null : Number(r.marksObtained),
      totalMarks: Number(r.classTest.totalMarks),
      isAbsent: r.isAbsent,
      testDate: r.classTest.testDate,
    }));

    return { overall: summarisePerformance(all), monthly: monthlyPerformance(all), subjects };
  }

  /**
   * ⚠️ **A podium finish is the only rank a student is shown** (operator, 2026-09-30): first, second or third
   * in the section. Everyone else sees no rank at all — "17th of 20" is a pressure device, not feedback, while
   * "you finished in the top three" is recognition. The stored rank is untouched and staff still see it.
   */
  private static podium(rank: number | null): 1 | 2 | 3 | null {
    return rank === 1 || rank === 2 || rank === 3 ? rank : null;
  }

  async results(activeChildId?: string | null) {
    const student = await this.self(activeChildId);
    const enrolls = await this.enrollmentIds(student.id);
    const cards = await this.db.reportCard.findMany({
      where: { enrollmentId: { in: enrolls.map((e) => e.id) } },
      orderBy: { generatedAt: 'desc' },
    });
    // Resolve term names in one query (ReportCard carries termId only).
    const terms = await this.db.term.findMany({ where: { id: { in: [...new Set(cards.map((c) => c.termId))] } }, select: { id: true, name: true } });
    const termName = new Map(terms.map((t) => [t.id, t.name]));
    return cards.map((c) => ({
      termId: c.termId,
      term: termName.get(c.termId) ?? '—',
      overallPercent: Number(c.overallPercent),
      grade: c.gradeLabel,
      sectionRank: ParentPortalService.podium(c.sectionRank),
      hasFile: c.documentId !== null,
    }));
  }

  /**
   * One term, in full: every subject's marks, total, percentage and grade, plus the exam-by-exam breakdown.
   *
   * ⚠️ **Self-only and published-only.** The term is looked up through the caller's OWN report card, so another
   * student's term or an id made up by the client is a 404; and only PUBLISHED exams are read, so a student can
   * never see marks a teacher is still entering. **No class average** (same rule as the rest of the portal), and
   * the rank is the podium-only one above.
   *
   * The arithmetic is the report card's own (`subjectTermPercent`, `gradeFor`), so the subject figures here add up
   * to the overall percentage printed on the card — nothing is recomputed differently for the screen.
   */
  async termResult(termId: string, activeChildId?: string | null) {
    const student = await this.self(activeChildId);
    const enrolls = await this.enrollmentIds(student.id);
    const card = await this.db.reportCard.findFirst({ where: { termId, enrollmentId: { in: enrolls.map((e) => e.id) } } });
    if (!card) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'No result for this term');

    const [term, enrollment] = await Promise.all([
      this.db.term.findFirst({ where: { id: termId } }),
      this.db.studentEnrollment.findFirst({ where: { id: card.enrollmentId }, select: { classId: true } }),
    ]);
    if (!term || !enrollment) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'No result for this term');

    const [exams, subjects, scaleRows] = await Promise.all([
      this.db.examDefinition.findMany({ where: { termId, classId: enrollment.classId, status: 'PUBLISHED' }, orderBy: { examDate: 'asc' } }),
      this.db.subject.findMany({ where: { classId: enrollment.classId }, orderBy: { name: 'asc' } }),
      this.db.gradeScale.findMany({ where: { academicYearId: term.academicYearId } }),
    ]);
    const results = await this.db.examResult.findMany({
      where: { enrollmentId: card.enrollmentId, examId: { in: exams.map((e) => e.id) } },
    });
    const scale: GradeBand[] = scaleRows.map((b) => ({ label: b.label, minPercent: Number(b.minPercent), maxPercent: Number(b.maxPercent), gradePoint: Number(b.gradePoint) }));
    const gradeOf = (percent: number | null) => (percent === null ? null : gradeFor(scale, percent)?.label ?? null);
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const pct = (got: number, of: number) => (of > 0 ? round2((got / of) * 100) : null);
    const resultFor = (examId: string, subjectId: string) => results.find((r) => r.examId === examId && r.subjectId === subjectId);

    const subjectRows = subjects.map((s) => {
      const marks: ExamMark[] = exams.map((e) => {
        const r = resultFor(e.id, s.id);
        return {
          weightagePercent: Number(e.weightagePercent),
          marksObtained: r?.marksObtained != null ? Number(r.marksObtained) : null,
          totalMarks: r ? Number(r.totalMarks) : 0,
          isAbsent: r?.isAbsent ?? true,
        };
      });
      const taken = marks.filter((m) => m.totalMarks > 0);
      const percent = taken.length ? subjectTermPercent(marks) : null;
      return {
        subject: s.name,
        marksObtained: taken.length ? round2(taken.reduce((n, m) => n + (m.isAbsent ? 0 : m.marksObtained ?? 0), 0)) : null,
        totalMarks: taken.reduce((n, m) => n + m.totalMarks, 0),
        percent,
        grade: gradeOf(percent),
        absent: taken.length > 0 && taken.every((m) => m.isAbsent),
      };
    }).filter((s) => s.totalMarks > 0);

    const totalObtained = round2(subjectRows.reduce((n, s) => n + (s.marksObtained ?? 0), 0));
    const totalMarks = subjectRows.reduce((n, s) => n + s.totalMarks, 0);

    return {
      termId,
      term: term.name,
      overallPercent: Number(card.overallPercent),
      grade: card.gradeLabel,
      rank: ParentPortalService.podium(card.sectionRank),
      totalObtained,
      totalMarks,
      hasFile: card.documentId !== null,
      subjects: subjectRows,
      exams: exams.map((e) => {
        const rows = subjects.map((s) => {
          const r = resultFor(e.id, s.id);
          if (!r) return null;
          const got = r.isAbsent || r.marksObtained == null ? null : Number(r.marksObtained);
          const p = got === null ? null : pct(got, Number(r.totalMarks));
          return { subject: s.name, marksObtained: got, totalMarks: Number(r.totalMarks), percent: p, grade: gradeOf(p), isAbsent: r.isAbsent };
        }).filter((x): x is NonNullable<typeof x> => x !== null);
        const obtained = round2(rows.reduce((n, x) => n + (x.marksObtained ?? 0), 0));
        const total = rows.reduce((n, x) => n + x.totalMarks, 0);
        return {
          id: e.id, name: e.name, examType: e.examType, weightagePercent: Number(e.weightagePercent), examDate: e.examDate,
          obtained, total, percent: pct(obtained, total), subjects: rows,
        };
      }),
      // The school's own grade bands, so "D" is explained rather than left as a letter.
      gradeScale: [...scale].sort((a, b) => b.minPercent - a.minPercent).map((b) => ({ label: b.label, minPercent: b.minPercent, maxPercent: b.maxPercent })),
    };
  }

  /** A short-lived link to the student's OWN report-card PDF — same self-lookup as `termResult`. */
  async termResultFile(termId: string, activeChildId?: string | null): Promise<{ url: string; expiresInSeconds: number }> {
    const student = await this.self(activeChildId);
    const enrolls = await this.enrollmentIds(student.id);
    const card = await this.db.reportCard.findFirst({ where: { termId, enrollmentId: { in: enrolls.map((e) => e.id) } } });
    const doc = card?.documentId ? await this.db.document.findFirst({ where: { id: card.documentId }, select: { fileKey: true } }) : null;
    if (!doc) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'No report card file for this term');
    const expiresInSeconds = 600;
    return { url: await this.storage.presignGet(doc.fileKey, expiresInSeconds), expiresInSeconds };
  }

  async fees(activeChildId?: string | null) {
    const student = await this.self(activeChildId);
    const invoices = await this.db.feeInvoice.findMany({
      where: { studentId: student.id, status: { not: 'PENDING_APPROVAL' } }, // held vouchers are not the family's yet
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      select: {
        id: true, month: true, year: true, totalAmount: true, paidAmount: true, status: true, dueDate: true,
        // The receipts, alongside the bill they belong to. "You owe 900" without "and here is
        // what you have already paid, receipt #41" is half an answer, and the half that starts
        // the phone call to the office.
        payments: {
          orderBy: { paidAt: 'desc' },
          select: {
            id: true, receiptNo: true, amountPaid: true, method: true, paidAt: true,
            reversal: { select: { id: true } },
          },
        },
      },
    });
    return invoices.map((i) => ({
      id: i.id,
      month: i.month,
      year: i.year,
      total: Number(i.totalAmount),
      paid: Number(i.paidAmount),
      remaining: money(Number(i.totalAmount) - Number(i.paidAmount)),
      status: i.status,
      dueDate: i.dueDate,
      payments: i.payments.map((p) => ({
        id: p.id,
        receiptNo: p.receiptNo,
        amount: Number(p.amountPaid),
        method: p.method,
        paidAt: p.paidAt,
        // Shown, not hidden: a family that was handed a receipt needs to know it was reversed,
        // and a payment that silently vanishes from the list is how a dispute starts.
        reversed: p.reversal !== null,
      })),
    }));
  }
}

/** Midnight UTC, matching how `@db.Date` columns compare. */
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const dayMonth = (d: Date): string =>
  new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
