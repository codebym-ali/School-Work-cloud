import { HttpStatus } from '@nestjs/common';
import { InquiryStatus } from '@prisma/client';
import { AppError, ErrorCodes } from '@common';

/**
 * Admissions state machine (blueprint §8). The allowed transitions ARE the
 * acceptance criteria; anything else => 409 INVALID_STATE_TRANSITION.
 *
 *   INQUIRY ──schedule──▶ ENTRY_TEST_SCHEDULED ──result──▶ PASSED | FAILED
 *      │                                                      │
 *      ├──admit (no test)──▶ ADMITTED                         ├──admit──▶ ADMITTED
 *      └──reject/withdraw──▶ REJECTED | WITHDRAWN   (FAILED ──admit override, audited──▶ ADMITTED)
 *
 * ADMITTED / REJECTED / WITHDRAWN are terminal.
 */
export const INQUIRY_TRANSITIONS: Record<InquiryStatus, InquiryStatus[]> = {
  [InquiryStatus.INQUIRY]: [
    InquiryStatus.ENTRY_TEST_SCHEDULED,
    InquiryStatus.ADMITTED,
    InquiryStatus.REJECTED,
    InquiryStatus.WITHDRAWN,
  ],
  [InquiryStatus.ENTRY_TEST_SCHEDULED]: [
    InquiryStatus.ENTRY_TEST_PASSED,
    InquiryStatus.ENTRY_TEST_FAILED,
    InquiryStatus.REJECTED,
    InquiryStatus.WITHDRAWN,
  ],
  [InquiryStatus.ENTRY_TEST_PASSED]: [
    InquiryStatus.ADMITTED,
    InquiryStatus.REJECTED,
    InquiryStatus.WITHDRAWN,
  ],
  [InquiryStatus.ENTRY_TEST_FAILED]: [
    InquiryStatus.ADMITTED, // admin override, audited
    InquiryStatus.REJECTED,
    InquiryStatus.WITHDRAWN,
  ],
  [InquiryStatus.ADMITTED]: [],
  [InquiryStatus.REJECTED]: [],
  [InquiryStatus.WITHDRAWN]: [],
};

export function canTransition(from: InquiryStatus, to: InquiryStatus): boolean {
  return INQUIRY_TRANSITIONS[from].includes(to);
}

/** Throws 409 INVALID_STATE_TRANSITION unless from->to is allowed. */
export function assertTransition(from: InquiryStatus, to: InquiryStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError(
      ErrorCodes.INVALID_STATE_TRANSITION,
      HttpStatus.CONFLICT,
      `Cannot move inquiry from ${from} to ${to}`,
    );
  }
}

/** Whether admitting from this state is an audited override (test was failed). */
export function isOverrideAdmit(from: InquiryStatus): boolean {
  return from === InquiryStatus.ENTRY_TEST_FAILED;
}
