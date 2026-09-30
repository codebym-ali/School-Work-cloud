import { HttpStatus, Injectable } from '@nestjs/common';
import { ExamStatus } from '@prisma/client';
import { AppError, ErrorCodes, isAdminRole, PdfService, restrictedCampusId, StorageService, TenantContext } from '@common';
import { TenantPrismaService } from '@database';
import { SmsProducer } from '../comms/sms/sms-producer.service';
import { denseRankByValue, gradeFor, overallPercent, subjectTermPercent, type ExamMark, type GradeBand } from './exam-grading';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Report cards (blueprint §11, §26.4). Generates per-term computed results
 * (subject term percents → overall → grade → section dense-rank), writes ReportCard
 * + Document rows, and enqueues result-ready SMS. Requires the term's class exams to
 * be PUBLISHED and their weightages to sum to 100.
 *
 * NOTE: the actual PDF render + R2 upload is deferred (needs the upload pipeline,
 * §22.6); Document.fileKey is a placeholder key. The computed data is fully available
 * via the read endpoints, which is what the parent view consumes.
 */
@Injectable()
export class ReportCardsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly sms: SmsProducer,
    private readonly storage: StorageService,
    private readonly pdf: PdfService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  async generate(termId: string): Promise<{ generated: number }> {
    const term = await this.db.term.findFirst({ where: { id: termId } });
    if (!term) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Term not found');
    const scale: GradeBand[] = (await this.db.gradeScale.findMany({ where: { academicYearId: term.academicYearId } })).map((b) => ({
      label: b.label, minPercent: Number(b.minPercent), maxPercent: Number(b.maxPercent), gradePoint: Number(b.gradePoint),
    }));

    const exams = await this.db.examDefinition.findMany({ where: { termId } });
    if (exams.length === 0) throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'No exams in this term');

    // Group exams by class; each class's weightages must sum to 100 and all be PUBLISHED.
    const byClass = new Map<string, typeof exams>();
    for (const e of exams) byClass.set(e.classId, [...(byClass.get(e.classId) ?? []), e]);

    let generated = 0;
    for (const [classId, classExams] of byClass) {
      const sum = round2(classExams.reduce((s, e) => s + Number(e.weightagePercent), 0));
      if (sum !== 100) {
        throw new AppError(ErrorCodes.WEIGHTAGE_SUM_INVALID, HttpStatus.UNPROCESSABLE_ENTITY, `Class weightages sum to ${sum}, not 100`);
      }
      if (classExams.some((e) => e.status !== ExamStatus.PUBLISHED)) {
        throw new AppError(ErrorCodes.INVALID_STATE_TRANSITION, HttpStatus.CONFLICT, 'All class exams must be PUBLISHED before generation');
      }
      generated += await this.generateForClass(term.id, term.name, classId, term.academicYearId, classExams, scale);
    }
    return { generated };
  }

  private async generateForClass(
    termId: string,
    termName: string,
    classId: string,
    academicYearId: string,
    classExams: Array<{ id: string; weightagePercent: unknown }>,
    scale: GradeBand[],
  ): Promise<number> {
    const subjects = await this.db.subject.findMany({ where: { classId } });
    const klass = await this.db.class.findFirst({ where: { id: classId } });
    const schoolName = (await this.db.school.findFirst({ where: { id: this.sid } }))?.name ?? 'School';
    const examWeight = new Map(classExams.map((e) => [e.id, Number(e.weightagePercent)]));
    const examIds = classExams.map((e) => e.id);
    const enrollments = await this.db.studentEnrollment.findMany({ where: { classId, academicYearId, status: 'ACTIVE' } });
    const students = new Map(
      (await this.db.student.findMany({ where: { id: { in: enrollments.map((e) => e.studentId) } } })).map((s) => [s.id, s]),
    );
    const results = await this.db.examResult.findMany({ where: { examId: { in: examIds }, enrollmentId: { in: enrollments.map((e) => e.id) } } });

    // enrollmentId -> { overall, hasMark, subjects[] }
    const computed = new Map<string, { overall: number; hasMark: boolean; subjects: Array<{ name: string; percent: number }> }>();
    for (const enr of enrollments) {
      const subjectRows: Array<{ name: string; percent: number }> = [];
      let hasMark = false;
      for (const subj of subjects) {
        const marks: ExamMark[] = examIds.map((examId) => {
          const r = results.find((x) => x.enrollmentId === enr.id && x.subjectId === subj.id && x.examId === examId);
          if (r && !r.isAbsent) hasMark = true;
          return {
            weightagePercent: examWeight.get(examId) ?? 0,
            marksObtained: r?.marksObtained != null ? Number(r.marksObtained) : null,
            totalMarks: r ? Number(r.totalMarks) : 0,
            isAbsent: r?.isAbsent ?? true,
          };
        });
        subjectRows.push({ name: subj.name, percent: subjectTermPercent(marks) });
      }
      computed.set(enr.id, { overall: overallPercent(subjectRows.map((s) => s.percent)), hasMark, subjects: subjectRows });
    }

    // Dense rank per section (students absent from all exams are unranked).
    const bySection = new Map<string, string[]>();
    for (const enr of enrollments) bySection.set(enr.sectionId, [...(bySection.get(enr.sectionId) ?? []), enr.id]);
    const rankOf = new Map<string, number | null>();
    for (const [, ids] of bySection) {
      const ranked = ids.filter((id) => computed.get(id)!.hasMark);
      const ranks = denseRankByValue(ranked.map((id) => computed.get(id)!.overall));
      for (const id of ids) {
        rankOf.set(id, computed.get(id)!.hasMark ? (ranks.get(computed.get(id)!.overall) ?? null) : null);
      }
    }

    let count = 0;
    for (const enr of enrollments) {
      const c = computed.get(enr.id)!;
      const grade = gradeFor(scale, c.overall)?.label ?? '-';
      const student = students.get(enr.studentId);

      // Render the report-card PDF and upload it to storage.
      const buffer = await this.pdf.reportCard({
        schoolName,
        studentName: student?.fullName ?? '',
        grNumber: student?.grNumber ?? '',
        className: klass?.name ?? '',
        termName,
        overallPercent: c.overall,
        gradeLabel: grade,
        sectionRank: rankOf.get(enr.id) ?? null,
        subjects: c.subjects,
      });
      const fileKey = `report-cards/${this.sid}/${termId}/${enr.id}.pdf`;
      await this.storage.putObject(fileKey, buffer, 'application/pdf');

      const doc = await this.db.document.create({
        data: { schoolId: this.sid, studentId: enr.studentId, type: 'REPORT_CARD', fileKey, issuedById: this.ctx.user!.userId },
      });
      const existing = await this.db.reportCard.findFirst({ where: { termId, enrollmentId: enr.id } });
      const data = { overallPercent: c.overall, gradeLabel: grade, sectionRank: rankOf.get(enr.id) ?? null, documentId: doc.id };
      if (existing) {
        await this.db.reportCard.update({ where: { id: existing.id }, data });
      } else {
        await this.db.reportCard.create({ data: { schoolId: this.sid, termId, enrollmentId: enr.id, ...data } });
      }
      await this.sms.enqueueResultReady({ type: 'RESULT_READY', schoolId: this.sid, studentId: enr.studentId, term: termName });
      count++;
    }
    return count;
  }

  listByTerm(termId: string) {
    return this.db.reportCard.findMany({ where: { termId }, orderBy: { sectionRank: 'asc' } });
  }

  /**
   * Every exam mark a student has, grouped term → exam → subject, with the term's report card beside it.
   *
   * A report card alone answers "how did the term go" but not "where was it lost": the office asked for the
   * marks behind it. Only term exams (`ExamDefinition`) — the teacher's own class tests live on
   * `/reports/performance/students/:id` and are deliberately a separate list. Unpublished exams are
   * included with their status so an admin can see marks entry in progress; the status is shown, never hidden.
   */
  async termResultsByStudent(studentId: string) {
    const enrollments = await this.viewableEnrollments(studentId);
    const ids = enrollments.map((e) => e.id);
    const [results, cards] = await Promise.all([
      this.db.examResult.findMany({
        where: { enrollmentId: { in: ids } },
        include: {
          subject: { select: { name: true } },
          exam: { include: { term: { select: { id: true, name: true, startDate: true, academicYearId: true } } } },
        },
      }),
      this.db.reportCard.findMany({ where: { enrollmentId: { in: ids } } }),
    ]);

    // How the whole class did, so a mark has something to be read against: mean marks and mean total per
    // (exam, subject) across every student who sat it. Absent rows carry null marks and drop out of the mean.
    const examIds = [...new Set(results.map((r) => r.examId))];
    const classMeans = examIds.length
      ? await this.db.examResult.groupBy({
          by: ['examId', 'subjectId'],
          where: { examId: { in: examIds }, isAbsent: false },
          _avg: { marksObtained: true, totalMarks: true },
        })
      : [];
    const mean = new Map(classMeans.map((m) => [`${m.examId}:${m.subjectId}`, { marks: Number(m._avg.marksObtained ?? 0), total: Number(m._avg.totalMarks ?? 0) }]));
    const yearIds = [...new Set(results.map((r) => r.exam.term.academicYearId))];
    const scaleRows = yearIds.length ? await this.db.gradeScale.findMany({ where: { academicYearId: { in: yearIds } } }) : [];
    const scaleFor = (yearId: string): GradeBand[] => scaleRows.filter((b) => b.academicYearId === yearId)
      .map((b) => ({ label: b.label, minPercent: Number(b.minPercent), maxPercent: Number(b.maxPercent), gradePoint: Number(b.gradePoint) }));

    type ExamOut = {
      id: string; name: string; examType: string; weightagePercent: number; examDate: Date; status: string;
      obtained: number; total: number; percent: number | null; classAveragePercent: number | null;
      subjects: Array<{ subjectId: string; subject: string; marksObtained: number | null; totalMarks: number; isAbsent: boolean; grade: string | null; classAveragePercent: number | null }>;
    };
    const terms = new Map<string, { termId: string; term: string; startDate: Date; exams: Map<string, ExamOut> }>();
    for (const r of results) {
      const t = r.exam.term;
      const term = terms.get(t.id) ?? { termId: t.id, term: t.name, startDate: t.startDate, exams: new Map<string, ExamOut>() };
      terms.set(t.id, term);
      const exam = term.exams.get(r.examId) ?? {
        id: r.examId, name: r.exam.name, examType: r.exam.examType, weightagePercent: Number(r.exam.weightagePercent),
        examDate: r.exam.examDate, status: r.exam.status, obtained: 0, total: 0, percent: null, classAveragePercent: null, subjects: [],
      };
      term.exams.set(r.examId, exam);
      const total = Number(r.totalMarks);
      const obtained = r.marksObtained == null ? null : Number(r.marksObtained);
      const m = mean.get(`${r.examId}:${r.subjectId}`);
      exam.subjects.push({
        subjectId: r.subjectId, subject: r.subject.name, marksObtained: obtained, totalMarks: total, isAbsent: r.isAbsent,
        grade: !r.isAbsent && obtained !== null && total > 0 ? gradeFor(scaleFor(t.academicYearId), (obtained / total) * 100)?.label ?? null : null,
        classAveragePercent: m && m.total > 0 ? round2((m.marks / m.total) * 100) : null,
      });
      if (!r.isAbsent && obtained !== null) { exam.obtained += obtained; exam.total += total; }
    }

    const cardByTerm = new Map(cards.map((c) => [c.termId, c]));
    return [...terms.values()]
      .sort((a, b) => b.startDate.getTime() - a.startDate.getTime())
      .map((t) => {
        const card = cardByTerm.get(t.termId);
        return {
          termId: t.termId,
          term: t.term,
          reportCard: card
            ? { overallPercent: Number(card.overallPercent), grade: card.gradeLabel, sectionRank: card.sectionRank, hasFile: card.documentId !== null }
            : null,
          exams: [...t.exams.values()]
            .sort((a, b) => a.examDate.getTime() - b.examDate.getTime())
            .map((e) => {
              let m = 0;
              let tot = 0;
              for (const s of e.subjects) {
                const x = mean.get(`${e.id}:${s.subjectId}`);
                if (x) { m += x.marks; tot += x.total; }
              }
              return {
                ...e,
                percent: e.total > 0 ? round2((e.obtained / e.total) * 100) : null,
                classAveragePercent: tot > 0 ? round2((m / tot) * 100) : null,
                subjects: e.subjects.sort((a, b) => a.subject.localeCompare(b.subject)),
              };
            }),
        };
      });
  }

  /** A short-lived link to one term's report-card PDF, behind the same gate as the list. */
  async reportCardFileUrl(studentId: string, termId: string): Promise<{ url: string; expiresInSeconds: number }> {
    const enrollments = await this.viewableEnrollments(studentId);
    const card = await this.db.reportCard.findFirst({ where: { termId, enrollmentId: { in: enrollments.map((e) => e.id) } } });
    const doc = card?.documentId ? await this.db.document.findFirst({ where: { id: card.documentId }, select: { fileKey: true } }) : null;
    if (!doc) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'No report card file for this term');
    const expiresInSeconds = 600;
    return { url: await this.storage.presignGet(doc.fileKey, expiresInSeconds), expiresInSeconds };
  }

  async listByStudent(studentId: string) {
    const enrollments = await this.viewableEnrollments(studentId);
    return this.db.reportCard.findMany({
      where: { enrollmentId: { in: enrollments.map((e) => e.id) } },
      orderBy: { generatedAt: 'desc' },
    });
  }

  private async viewableEnrollments(studentId: string) {
    const user = this.ctx.user;
    const enrollments = await this.db.studentEnrollment.findMany({
      where: { studentId },
      select: { id: true, status: true, campusId: true },
    });

    // Two independent §22.8/P1.7 gates, applied in order:
    //  1. Campus scope — a campus-bound admin may only read a student ACTIVE in their campus
    //     (mirrors StudentsService.getOne, so the two surfaces agree). OWNER_ADMIN is school-wide.
    //  2. Everyone else is denied. This route carries NO @Roles, so any authenticated caller
    //     reaches it and the check below is the only protection. It used to allow a guardian
    //     of the student (the parent portal, removed 2026-07-28); with parents gone the lookup
    //     could never succeed, so it is now an outright deny — same outcome, honestly stated.
    //     A student reads their own results via /portal/results, not this admin surface.
    const restricted = restrictedCampusId(user);
    if (restricted !== null && isAdminRole(user)) {
      if (!enrollments.some((e) => e.status === 'ACTIVE' && e.campusId === restricted)) {
        throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Student belongs to another campus');
      }
    } else if (!isAdminRole(user)) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Not permitted to view this student');
    }

    return enrollments;
  }
}
