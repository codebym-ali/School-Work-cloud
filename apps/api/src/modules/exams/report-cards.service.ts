import { HttpStatus, Injectable } from '@nestjs/common';
import { ExamStatus } from '@prisma/client';
import { AppError, ErrorCodes, PdfService, StorageService, TenantContext } from '@common';
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

  async listByStudent(studentId: string) {
    const enrollments = await this.db.studentEnrollment.findMany({ where: { studentId }, select: { id: true } });
    return this.db.reportCard.findMany({
      where: { enrollmentId: { in: enrollments.map((e) => e.id) } },
      orderBy: { generatedAt: 'desc' },
    });
  }
}
