import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AppError,
  ErrorCodes,
  monthlyPerformance,
  rangeStart,
  restrictedCampusId,
  summarisePerformance,
  TenantContext,
  type PerformanceRange,
  type ScoredTest,
} from '@common';
import { TenantPrismaService } from '@database';

/**
 * Performance reporting from class tests (§11 extension) — the owner's campus → class → student
 * drill-down.
 *
 * Shaped by one operational fact: a school with 6,000 students will never browse a list. Every
 * level therefore returns TENS of rows, not thousands — classes within a campus, students within
 * one class, subjects within one student — and each is sorted worst-first, because the job of a
 * report at scale is to surface the exception, not to enumerate the roll.
 *
 * All arithmetic goes through the shared `summarisePerformance`, so the figure a director sees
 * is the same one the student sees. (Attendance % previously diverged across three surfaces for
 * exactly the want of that.)
 */
@Injectable()
export class PerformanceService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }

  /**
   * One row per class in scope: how it is performing, and how that compares with the previous
   * equal-length window. The trend matters more than the absolute — "68%" is a fact, "68%, down
   * 7" is a reason to walk into a classroom.
   */
  async byClass(range: PerformanceRange, campusId?: string) {
    const { from, prevFrom } = this.window(range);
    const campus = this.campusFilter(campusId);

    const rows = await this.db.classTestScore.findMany({
      where: { classTest: { testDate: { gte: prevFrom }, section: { class: campus } } },
      select: {
        marksObtained: true,
        isAbsent: true,
        classTest: {
          select: {
            totalMarks: true, testDate: true,
            section: { select: { class: { select: { id: true, name: true, order: true } } } },
          },
        },
      },
    });

    interface ClassBucket { name: string; order: number; current: ScoredTest[]; previous: ScoredTest[] }
    const byClassId = new Map<string, ClassBucket>();
    for (const r of rows) {
      const k = r.classTest.section.class;
      const bucket: ClassBucket = byClassId.get(k.id) ?? { name: k.name, order: k.order, current: [], previous: [] };
      (r.classTest.testDate >= from ? bucket.current : bucket.previous).push(this.toScored(r));
      byClassId.set(k.id, bucket);
    }

    // Head-count comes from enrolments, not from who happened to sit a test — a class where
    // nobody was tested must still appear, or "we never assessed 8-B" stays invisible.
    const classes = await this.db.class.findMany({ where: campus, select: { id: true, name: true, order: true } });
    const strength = await this.db.studentEnrollment.groupBy({
      by: ['classId'],
      where: { status: 'ACTIVE', student: { deletedAt: null }, class: campus },
      _count: { _all: true },
    });
    const heads = new Map(strength.map((s) => [s.classId, s._count._all]));

    return classes
      .map((c) => {
        const b = byClassId.get(c.id);
        const current = summarisePerformance(b?.current ?? []);
        const previous = summarisePerformance(b?.previous ?? []);
        return {
          classId: c.id,
          className: c.name,
          order: c.order,
          students: heads.get(c.id) ?? 0,
          ...current,
          trend: current.percent != null && previous.percent != null ? current.percent - previous.percent : null,
        };
      })
      // Worst first, but classes with no tests sink to the bottom rather than masquerading as 0%.
      .sort((a, b) => (a.percent ?? 999) - (b.percent ?? 999));
  }

  /** One row per student in a class — the second level of the drill-down. */
  async byStudent(classId: string, range: PerformanceRange) {
    const { from, prevFrom } = this.window(range);
    const klass = await this.db.class.findFirst({
      where: { id: classId, ...this.campusFilter() },
      select: { id: true, name: true },
    });
    if (!klass) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Class not found');

    const rows = await this.db.classTestScore.findMany({
      where: { classTest: { testDate: { gte: prevFrom }, section: { classId } } },
      select: {
        marksObtained: true, isAbsent: true,
        enrollment: { select: { id: true, student: { select: { id: true, fullName: true, grNumber: true } } } },
        classTest: { select: { totalMarks: true, testDate: true, subject: { select: { id: true, name: true } } } },
      },
    });

    interface StudentBucket {
      name: string; grNumber: string; current: ScoredTest[]; previous: ScoredTest[];
      bySubject: Map<string, { name: string; rows: ScoredTest[] }>;
    }
    const byStudent = new Map<string, StudentBucket>();
    for (const r of rows) {
      const st = r.enrollment.student;
      const b: StudentBucket = byStudent.get(st.id)
        ?? { name: st.fullName, grNumber: st.grNumber, current: [], previous: [], bySubject: new Map() };
      const scored = this.toScored(r);
      if (r.classTest.testDate >= from) {
        b.current.push(scored);
        const sub = r.classTest.subject;
        const sb: { name: string; rows: ScoredTest[] } = b.bySubject.get(sub.id) ?? { name: sub.name, rows: [] };
        sb.rows.push(scored);
        b.bySubject.set(sub.id, sb);
      } else {
        b.previous.push(scored);
      }
      byStudent.set(st.id, b);
    }

    // Every ACTIVE student appears, tested or not — a child nobody assessed is a finding.
    const enrolled = await this.db.studentEnrollment.findMany({
      where: { classId, status: 'ACTIVE', student: { deletedAt: null } },
      select: { student: { select: { id: true, fullName: true, grNumber: true } } },
    });

    return {
      classId: klass.id,
      className: klass.name,
      students: enrolled
        .map(({ student }) => {
          const b = byStudent.get(student.id);
          const current = summarisePerformance(b?.current ?? []);
          const previous = summarisePerformance(b?.previous ?? []);
          // The weakest subject is what a director acts on — "68% overall" tells you nothing
          // about which lesson to sit in on.
          const subjects = [...(b?.bySubject.values() ?? [])]
            .map((s) => ({ name: s.name, ...summarisePerformance(s.rows) }))
            .filter((s) => s.percent != null)
            .sort((a, b2) => (a.percent ?? 0) - (b2.percent ?? 0));
          return {
            studentId: student.id,
            fullName: student.fullName,
            grNumber: student.grNumber,
            ...current,
            trend: current.percent != null && previous.percent != null ? current.percent - previous.percent : null,
            weakestSubject: subjects[0] ? { name: subjects[0].name, percent: subjects[0].percent } : null,
          };
        })
        .sort((a, b) => (a.percent ?? 999) - (b.percent ?? 999)),
    };
  }

  /** One student in full: per-subject, per-month, and every test — the third level. */
  async forStudent(studentId: string, range: PerformanceRange) {
    const { from } = this.window(range);
    const student = await this.db.student.findFirst({
      where: { id: studentId, deletedAt: null },
      select: {
        id: true, fullName: true, grNumber: true,
        enrollments: { where: { status: 'ACTIVE' }, select: { campusId: true, class: { select: { name: true } }, section: { select: { name: true } } }, take: 1 },
      },
    });
    if (!student) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Student not found');

    const restricted = restrictedCampusId(this.ctx.user);
    if (restricted !== null && !student.enrollments.some((e) => e.campusId === restricted)) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Student belongs to another campus');
    }

    const rows = await this.db.classTestScore.findMany({
      where: { enrollment: { studentId }, classTest: { testDate: { gte: from } } },
      select: {
        marksObtained: true, isAbsent: true,
        classTest: { select: { id: true, name: true, totalMarks: true, testDate: true, subject: { select: { id: true, name: true } } } },
      },
      orderBy: { classTest: { testDate: 'desc' } },
    });

    interface SubjectBucket { name: string; rows: ScoredTest[]; tests: unknown[] }
    const bySubject = new Map<string, SubjectBucket>();
    for (const r of rows) {
      const sub = r.classTest.subject;
      const b: SubjectBucket = bySubject.get(sub.id) ?? { name: sub.name, rows: [], tests: [] };
      b.rows.push(this.toScored(r));
      b.tests.push({
        id: r.classTest.id,
        name: r.classTest.name,
        testDate: r.classTest.testDate,
        totalMarks: Number(r.classTest.totalMarks),
        marksObtained: r.marksObtained == null ? null : Number(r.marksObtained),
        isAbsent: r.isAbsent,
      });
      bySubject.set(sub.id, b);
    }

    const all = rows.map((r) => this.toScored(r));
    const enrolment = student.enrollments[0];
    return {
      studentId: student.id,
      fullName: student.fullName,
      grNumber: student.grNumber,
      className: enrolment?.class?.name ?? null,
      sectionName: enrolment?.section?.name ?? null,
      overall: summarisePerformance(all),
      monthly: monthlyPerformance(all),
      subjects: [...bySubject.entries()]
        .map(([subjectId, s]) => ({ subjectId, subjectName: s.name, ...summarisePerformance(s.rows), tests: s.tests }))
        .sort((a, b) => (a.percent ?? 999) - (b.percent ?? 999)),
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  /** The selected window, plus the equal-length window before it, for the trend. */
  private window(range: PerformanceRange) {
    const from = rangeStart(range);
    const span = Date.now() - from.getTime();
    return { from, prevFrom: new Date(from.getTime() - span) };
  }

  /**
   * Campus scoping (§22.8, P1.7): a campus-bound admin's campus is FORCED, overriding any
   * client-supplied campusId, so the report can never spill another campus's results.
   */
  private campusFilter(clientCampusId?: string) {
    const restricted = restrictedCampusId(this.ctx.user);
    if (restricted !== null) return { campusId: restricted };
    return clientCampusId ? { campusId: clientCampusId } : {};
  }

  private toScored(r: { marksObtained: unknown; isAbsent: boolean; classTest: { totalMarks: unknown; testDate: Date } }): ScoredTest {
    return {
      marksObtained: r.marksObtained == null ? null : Number(r.marksObtained),
      totalMarks: Number(r.classTest.totalMarks),
      isAbsent: r.isAbsent,
      testDate: r.classTest.testDate,
    };
  }
}
