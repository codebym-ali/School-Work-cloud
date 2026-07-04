import { InquiryStatus } from '@prisma/client';
import { AppError } from '@common';
import { assertTransition, canTransition, isOverrideAdmit } from './inquiry-state-machine';

describe('Inquiry state machine (§8)', () => {
  it('allows the documented forward transitions', () => {
    expect(canTransition(InquiryStatus.INQUIRY, InquiryStatus.ENTRY_TEST_SCHEDULED)).toBe(true);
    expect(canTransition(InquiryStatus.INQUIRY, InquiryStatus.ADMITTED)).toBe(true); // admit without test
    expect(canTransition(InquiryStatus.ENTRY_TEST_SCHEDULED, InquiryStatus.ENTRY_TEST_PASSED)).toBe(true);
    expect(canTransition(InquiryStatus.ENTRY_TEST_SCHEDULED, InquiryStatus.ENTRY_TEST_FAILED)).toBe(true);
    expect(canTransition(InquiryStatus.ENTRY_TEST_PASSED, InquiryStatus.ADMITTED)).toBe(true);
    expect(canTransition(InquiryStatus.ENTRY_TEST_FAILED, InquiryStatus.ADMITTED)).toBe(true); // override
  });

  it('allows reject/withdraw from every non-terminal state', () => {
    for (const s of [
      InquiryStatus.INQUIRY,
      InquiryStatus.ENTRY_TEST_SCHEDULED,
      InquiryStatus.ENTRY_TEST_PASSED,
      InquiryStatus.ENTRY_TEST_FAILED,
    ]) {
      expect(canTransition(s, InquiryStatus.REJECTED)).toBe(true);
      expect(canTransition(s, InquiryStatus.WITHDRAWN)).toBe(true);
    }
  });

  it('forbids leaving terminal states', () => {
    for (const t of [InquiryStatus.ADMITTED, InquiryStatus.REJECTED, InquiryStatus.WITHDRAWN]) {
      expect(canTransition(t, InquiryStatus.ADMITTED)).toBe(false);
      expect(canTransition(t, InquiryStatus.ENTRY_TEST_SCHEDULED)).toBe(false);
    }
  });

  it('forbids skipping the test schedule step and other illegal jumps', () => {
    expect(canTransition(InquiryStatus.INQUIRY, InquiryStatus.ENTRY_TEST_PASSED)).toBe(false);
    expect(canTransition(InquiryStatus.ENTRY_TEST_PASSED, InquiryStatus.ENTRY_TEST_SCHEDULED)).toBe(false);
  });

  it('assertTransition throws INVALID_STATE_TRANSITION on an illegal move', () => {
    expect(() => assertTransition(InquiryStatus.ADMITTED, InquiryStatus.REJECTED)).toThrow(AppError);
    try {
      assertTransition(InquiryStatus.INQUIRY, InquiryStatus.ENTRY_TEST_PASSED);
      fail('expected throw');
    } catch (e) {
      expect((e as AppError).code).toBe('INVALID_STATE_TRANSITION');
    }
  });

  it('flags admit-from-failed as an audited override', () => {
    expect(isOverrideAdmit(InquiryStatus.ENTRY_TEST_FAILED)).toBe(true);
    expect(isOverrideAdmit(InquiryStatus.ENTRY_TEST_PASSED)).toBe(false);
  });
});
