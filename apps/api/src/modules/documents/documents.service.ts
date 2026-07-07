import { HttpStatus, Injectable } from '@nestjs/common';
import { DocumentType, EnrollmentStatus, FeeInvoiceStatus } from '@prisma/client';
import { AppError, AuditActions, ErrorCodes, PdfService, StorageService, TenantContext } from '@common';
import { AuditService, TenantPrismaService } from '@database';

export interface IssueCertInput {
  studentId: string;
  type: 'LEAVING_CERT' | 'CHARACTER_CERT' | 'FEE_CLEARANCE';
  overrideFeeClearance?: boolean;
  reason?: string;
}

export interface WithdrawInput {
  reason: string;
  overrideFeeClearance?: boolean;
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
  ) {}

  private get db() {
    return this.tenantPrisma.client;
  }
  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  async issueCertificate(input: IssueCertInput) {
    const student = await this.db.student.findFirst({ where: { id: input.studentId } });
    if (!student) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Student not found');

    if (input.type === 'LEAVING_CERT' && !input.overrideFeeClearance && !(await this.feeCleared(input.studentId))) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Unpaid invoices exist; clear fees or override (OWNER_ADMIN)');
    }
    return this.createDocument(input.studentId, input.type as DocumentType);
  }

  async listForStudent(studentId: string) {
    return this.db.document.findMany({ where: { studentId }, orderBy: { issuedAt: 'desc' } });
  }

  /** 10-minute pre-signed GET after an ownership check (§15, §22.6). */
  async getUrl(id: string) {
    const doc = await this.db.document.findFirst({ where: { id } });
    if (!doc) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Document not found');
    const url = await this.storage.presignGet(doc.fileKey, 600, `${doc.type}.pdf`);
    return { fileKey: doc.fileKey, url, expiresInSeconds: 600 };
  }

  /** Student withdrawal workflow (§15). */
  async withdraw(studentId: string, input: WithdrawInput) {
    const student = await this.db.student.findFirst({ where: { id: studentId } });
    if (!student) throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Student not found');
    if (!input.overrideFeeClearance && !(await this.feeCleared(studentId))) {
      throw new AppError(ErrorCodes.CONFLICT, HttpStatus.CONFLICT, 'Unpaid invoices exist; clear fees or override');
    }

    const feeClearance = await this.createDocument(studentId, DocumentType.FEE_CLEARANCE);
    const leavingCert = await this.createDocument(studentId, DocumentType.LEAVING_CERT);

    await this.db.studentEnrollment.updateMany({
      where: { studentId, status: EnrollmentStatus.ACTIVE },
      data: { status: EnrollmentStatus.WITHDRAWN, endedAt: new Date() },
    });
    await this.db.student.update({ where: { id: studentId }, data: { isActive: false } });
    if (student.userId) {
      await this.db.user.update({ where: { id: student.userId }, data: { status: 'DISABLED' } });
    }

    await this.audit.record({
      action: AuditActions.WITHDRAWAL_FEE_OVERRIDE,
      entityType: 'Student',
      entityId: studentId,
      reason: input.reason,
      newValue: { overrode: !!input.overrideFeeClearance },
    });
    return { feeClearanceId: feeClearance.id, leavingCertId: leavingCert.id, status: 'WITHDRAWN' };
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

  private async feeCleared(studentId: string): Promise<boolean> {
    const unpaid = await this.db.feeInvoice.findFirst({
      where: { studentId, status: { in: [FeeInvoiceStatus.PENDING, FeeInvoiceStatus.PARTIAL, FeeInvoiceStatus.OVERDUE] } },
    });
    return !unpaid;
  }
}

const CERT_BODY: Partial<Record<DocumentType, string>> = {
  LEAVING_CERT: 'This is to certify that the student named below was a bona fide student of this institution and has left the school. We wish them success in their future endeavours.',
  CHARACTER_CERT: 'This is to certify that the student named below has, to the best of our knowledge, borne a good moral character during their time at this institution.',
  FEE_CLEARANCE: 'This is to certify that the student named below has cleared all outstanding fee dues with this institution as of the date of issue.',
};
