import { HttpStatus, Injectable } from '@nestjs/common';
import { DocumentType, EnrollmentStatus, FeeInvoiceStatus } from '@prisma/client';
import { AppError, assertCampusAccess, assertOwnerOverride, AuditActions, ErrorCodes, PdfService, StorageService, TenantContext } from '@common';
import { AuditService, TenantPrismaService } from '@database';
import { InvoicingService } from '../fees/invoicing.service';

export interface IssueCertInput {
  studentId: string;
  type: 'LEAVING_CERT' | 'CHARACTER_CERT' | 'FEE_CLEARANCE';
  overrideFeeClearance?: boolean;
  reason?: string;
}

export interface WithdrawInput {
  reason: string;
  overrideFeeClearance?: boolean;
  leavingDate?: string;
}

/** Invoice statuses that still carry an unpaid balance. */
const OWING = [FeeInvoiceStatus.PENDING, FeeInvoiceStatus.PARTIAL, FeeInvoiceStatus.OVERDUE];

/**
 * The first day an invoice's billing period covers. A monthly invoice bills its month; an annual one
 * (`month` null) is treated as starting with its year's first month, so it always counts as begun.
 */
function periodStart(inv: { month: number | null; year: number }): Date {
  return new Date(Date.UTC(inv.year, (inv.month ?? 1) - 1, 1));
}

/**
 * Documents & certificates (blueprint §15). LEAVING_CERT is blocked while unpaid
 * invoices exist (OWNER_ADMIN override + reason). Withdrawal: check fees → FEE_CLEARANCE
 * → LEAVING_CERT → close enrollment WITHDRAWN → deactivate the student portal account.
 *
 * NOTE: PDF render + R2 upload + pre-signed URLs are deferred (upload pipeline §22.6);
 * `fileKey` is a placeholder and `/url` returns it with a note.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly pdf: PdfService,
    private readonly invoicing: InvoicingService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  async issueCertificate(input: IssueCertInput) {
    assertOwnerOverride(this.ctx.user, input.overrideFeeClearance, 'fee clearance for a certificate');
    await this.scopedStudent(input.studentId);
    const cleared = await this.feeCleared(input.studentId);

    // ⚠️ A FEE CLEARANCE certificate states "has cleared all outstanding fee dues". No override makes that
    // true, so none is honoured — until 2026-09-16 this type was issued with no fee check at all.
    if (input.type === 'FEE_CLEARANCE' && !cleared) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'This student still owes fees, so a fee clearance certificate cannot be issued');
    }
    // A LEAVING certificate may be released while fees are owed, by the owner, with a reason.
    if (input.type === 'LEAVING_CERT' && !input.overrideFeeClearance && !cleared) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Unpaid invoices exist; clear fees or override (OWNER_ADMIN)');
    }
    const doc = await this.createDocument(input.studentId, input.type as DocumentType);
    await this.audit.record({
      action: AuditActions.CERTIFICATE_ISSUED,
      entityType: 'Student',
      entityId: input.studentId,
      ...(input.reason ? { reason: input.reason } : {}),
      newValue: { documentId: doc.id, type: input.type, overrodeFeeClearance: !!input.overrideFeeClearance && !cleared },
    });
    return doc;
  }

  async listForStudent(studentId: string) {
    await this.scopedStudent(studentId);
    return this.db.document.findMany({ where: { studentId }, orderBy: { issuedAt: 'desc' } });
  }

  /** 10-minute pre-signed GET — after the campus check on the document's student (§15, §22.6). */
  async getUrl(id: string) {
    const doc = await this.db.document.findFirst({ where: { id } });
    if (!doc) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Document not found');
    // ⚠️ Authorise the STUDENT before signing anything. A document id is opaque but not secret: it
    // appears in lists and URLs, and a link signed for it is a copy of the certificate.
    if (doc.studentId) await this.scopedStudent(doc.studentId);
    // Not tied to a student: there is no campus to check a campus-bound caller against, so only a
    // school-wide admin may read it.
    else assertCampusAccess(this.ctx.user, null);
    const url = await this.storage.presignGet(doc.fileKey, 600, `${doc.type}.pdf`);
    return { url, expiresInSeconds: 600 };
  }

  /** Student withdrawal workflow (§15). */
  async withdraw(studentId: string, input: WithdrawInput) {
    assertOwnerOverride(this.ctx.user, input.overrideFeeClearance, 'fee clearance at withdrawal');

    const student = await this.db.student.findFirst({
      where: { id: studentId },
      include: { enrollments: { where: { status: EnrollmentStatus.ACTIVE }, select: { campusId: true } } },
    });
    if (!student) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Student not found');
    // ⚠️ Found by id alone — RLS scopes that to the school, not the campus. A campus admin could
    // otherwise withdraw another campus's student, disable their login and issue their leaving
    // certificate. A student with no ACTIVE enrolment has no campus to check against, and is
    // refused to a campus-bound caller for the same reason `getOne` refuses them.
    const campusId = student.enrollments[0]?.campusId ?? null;
    assertCampusAccess(this.ctx.user, campusId);
    if (!student.enrollments.length) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'This student is not currently enrolled');
    }

    const leftOn = input.leavingDate ? new Date(`${input.leavingDate.slice(0, 10)}T00:00:00Z`) : new Date();
    if (leftOn.getTime() > Date.now() + 86_400_000) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'The leaving date cannot be in the future');
    }

    // ⚠️ Invoices already raised for months AFTER the student left are not owed — the student was not
    // enrolled for them. Left as they were, they aged into OVERDUE and put a family that left owing
    // nothing on the defaulter list, which does not look at enrolment. They are closed with a waiver
    // line whose reason says exactly why. Anything for a month that had begun stays owed: withdrawal is
    // not a write-off (Decision D6).
    const owing = await this.db.feeInvoice.findMany({ where: { studentId, status: { in: OWING } }, select: { id: true, month: true, year: true } });
    const afterLeaving = owing.filter((inv) => periodStart(inv) > leftOn);
    for (const inv of afterLeaving) {
      await this.invoicing.waive(inv.id, { reason: `Withdrawn on ${leftOn.toISOString().slice(0, 10)}: not enrolled for this period` });
    }

    const cleared = await this.feeCleared(studentId, leftOn);
    if (!input.overrideFeeClearance && !cleared) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Unpaid invoices exist; clear fees or override');
    }

    // ⚠️ A fee clearance certificate only when fees ARE clear. Overriding lets the student leave with a
    // balance still owed; it does not make "has cleared all outstanding fee dues" true, and until
    // 2026-09-16 withdrawal issued that certificate anyway.
    const feeClearance = cleared ? await this.createDocument(studentId, DocumentType.FEE_CLEARANCE) : null;
    const leavingCert = await this.createDocument(studentId, DocumentType.LEAVING_CERT);

    await this.db.studentEnrollment.updateMany({
      where: { studentId, status: EnrollmentStatus.ACTIVE },
      data: { status: EnrollmentStatus.WITHDRAWN, endedAt: leftOn },
    });
    await this.db.student.update({ where: { id: studentId }, data: { isActive: false } });
    if (student.userId) {
      await this.db.user.update({ where: { id: student.userId }, data: { status: 'DISABLED' } });
    }

    // Every withdrawal is audited as what it is. The override gets its own entry, and only when fees
    // were actually owed — previously every withdrawal was logged as WITHDRAWAL_FEE_OVERRIDE, so the log
    // could not answer "who let a student leave owing money?".
    await this.audit.record({
      action: AuditActions.STUDENT_WITHDRAWN,
      entityType: 'Student',
      entityId: studentId,
      reason: input.reason,
      newValue: { leavingDate: leftOn.toISOString().slice(0, 10), waivedInvoicesAfterLeaving: afterLeaving.length },
    });
    if (!cleared) {
      await this.audit.record({
        action: AuditActions.WITHDRAWAL_FEE_OVERRIDE,
        entityType: 'Student',
        entityId: studentId,
        reason: input.reason,
        newValue: { overrode: true },
      });
    }
    return {
      feeClearanceId: feeClearance?.id ?? null,
      leavingCertId: leavingCert.id,
      status: 'WITHDRAWN' as const,
      waivedInvoicesAfterLeaving: afterLeaving.length,
      leftOwing: !cleared,
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────────────
  /** Render the certificate PDF, upload it to storage, and create the Document row. */
  private async createDocument(studentId: string, type: DocumentType) {
    const [student, school] = await Promise.all([
      this.db.student.findFirst({ where: { id: studentId } }),
      this.db.school.findFirst({ where: { id: this.sid } }),
    ]);
    const buffer = await this.pdf.certificate({
      schoolName: school?.name ?? 'School',
      studentName: student?.fullName ?? '',
      grNumber: student?.grNumber ?? '',
      type,
      issuedOn: new Date().toISOString().slice(0, 10),
      body: CERT_BODY[type] ?? 'This document is issued by the school administration.',
    });
    const fileKey = `documents/${this.sid}/${type.toLowerCase()}/${studentId}-${Date.now()}.pdf`;
    await this.storage.putObject(fileKey, buffer, 'application/pdf');
    return this.db.document.create({
      data: { schoolId: this.sid, studentId, type, fileKey, issuedById: this.ctx.user!.userId },
    });
  }

  /**
   * Does this student owe anything for a period that has BEGUN by `asOf`?
   *
   * ⚠️ (B6) This used to count every unpaid invoice, including one raised early for a month that had not
   * started — so a student whose next month was already billed could not be withdrawn or given a leaving
   * certificate without an override, for money they did not yet owe.
   */
  private async feeCleared(studentId: string, asOf: Date = new Date()): Promise<boolean> {
    const unpaid = await this.db.feeInvoice.findMany({ where: { studentId, status: { in: OWING } }, select: { month: true, year: true } });
    return !unpaid.some((inv) => periodStart(inv) <= asOf);
  }

  /**
   * The student, after the campus check. Scoped by their most recent enrolment of ANY status — a withdrawn
   * student has no active one, and the campus admin who withdrew them must still reach their certificate.
   */
  private async scopedStudent(studentId: string) {
    const student = await this.db.student.findFirst({
      where: { id: studentId },
      include: { enrollments: { orderBy: { startedAt: 'desc' }, take: 1, select: { campusId: true } } },
    });
    if (!student) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Student not found');
    assertCampusAccess(this.ctx.user, student.enrollments[0]?.campusId ?? null);
    return student;
  }
}

const CERT_BODY: Partial<Record<DocumentType, string>> = {
  LEAVING_CERT: 'This is to certify that the student named below was a bona fide student of this institution and has left the school. We wish them success in their future endeavours.',
  CHARACTER_CERT: 'This is to certify that the student named below has, to the best of our knowledge, borne a good moral character during their time at this institution.',
  FEE_CLEARANCE: 'This is to certify that the student named below has cleared all outstanding fee dues with this institution as of the date of issue.',
};
