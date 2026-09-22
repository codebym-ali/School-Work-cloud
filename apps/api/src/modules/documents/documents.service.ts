import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError, assertCampusAccess, ErrorCodes, StorageService, TenantContext } from '@common';
import { TenantPrismaService } from '@database';

/**
 * Read access to the documents a school ISSUES and stores as PDFs — currently report cards
 * (blueprint §15, §22.6): a campus-scoped list and a short-lived presigned download link.
 *
 * ⚠️ Certificate issuance (leaving / character / fee-clearance) was removed on 2026-09-19 — schools
 * issue those on paper now. This service only READS existing issued documents; nothing here writes.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ctx: TenantContext,
    private readonly storage: StorageService,
  ) {}

  private get db() {
    return this.tenantPrisma.client;
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
    // appears in lists and URLs, and a link signed for it is a copy of the document.
    if (doc.studentId) await this.scopedStudent(doc.studentId);
    // Not tied to a student: there is no campus to check a campus-bound caller against, so only a
    // school-wide admin may read it.
    else assertCampusAccess(this.ctx.user, null);
    const url = await this.storage.presignGet(doc.fileKey, 600, `${doc.type}.pdf`);
    return { url, expiresInSeconds: 600 };
  }

  /**
   * The student, after the campus check. Scoped by their most recent enrolment of ANY status — a
   * withdrawn student has no active one, but their report card must still be reachable.
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
