import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { Roles } from '@common';
import { StudentPortalService } from './student-portal.service';
import { PaymentsService } from '../fees/payments.service';

/**
 * Student self-service portal (§28). STUDENT-only; every route is read-only and resolves
 * the caller's own Student record in the service (SelfGuard, §22.8) — no id is accepted
 * from the client, so cross-student access is structurally impossible.
 */
@Roles('STUDENT')
@Controller('portal')
export class StudentPortalController {
  constructor(
    private readonly portal: StudentPortalService,
    private readonly payments: PaymentsService,
  ) {}

  @Get('overview')
  overview() {
    return this.portal.overview();
  }

  /**
   * The student's own notification list.
   *
   * ⚠️ Separate from the staff `/notifications` on purpose — see the service. That one resolves a
   * STAFF profile and returns an empty list for a student, so a shared endpoint would have looked
   * like a working bell that never said anything.
   */
  @Get('notifications')
  notifications() {
    return this.portal.notifications();
  }

  /** "I have looked." A POST because it writes, which also means it carries the CSRF token. */
  @Post('notifications/seen')
  @HttpCode(HttpStatus.OK)
  markSeen() {
    return this.portal.markNotificationsSeen();
  }

  @Get('attendance')
  attendance() {
    return this.portal.attendance();
  }

  /** Counts, not raw rows — "how many days was I absent?" answered directly. */
  @Get('attendance/summary')
  attendanceSummary() {
    return this.portal.attendanceSummary();
  }

  /** Per-subject class-test performance with a monthly trend. No rank, by design. */
  @Get('performance')
  performance() {
    return this.portal.testPerformance();
  }

  @Get('results')
  results() {
    return this.portal.results();
  }

  /** One term in full (every subject's marks, total, percent, grade). Self-only: the term is found through the caller's own report card. */
  @Get('results/:termId')
  termResult(@Param('termId') termId: string) {
    return this.portal.termResult(termId);
  }

  /** The caller's own report-card PDF for a term, as a short-lived link. */
  @Get('results/:termId/file')
  termResultFile(@Param('termId') termId: string) {
    return this.portal.termResultFile(termId);
  }

  @Get('fees')
  fees() {
    return this.portal.fees();
  }

  /**
   * The student's own receipt as a PDF.
   *
   * Delegates to the ordinary payment path rather than reimplementing it — same renderer, same
   * refusal for a reversed payment. The self-check lives in `PaymentsService.receiptPdf`, which
   * matches the payment's student against the caller (§22.8: it reads tenant rows, so it cannot
   * be a guard) and 404s otherwise. No id from the client can widen that.
   */
  @Get('fees/payments/:id/receipt')
  receipt(@Param('id') id: string) {
    return this.payments.receiptPdf(id);
  }
}
