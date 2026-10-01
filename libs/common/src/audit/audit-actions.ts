/**
 * Audit-action catalog (blueprint Appendix B). Sensitive mutations write an
 * AuditLog row with one of these stable action constants (old->new values, reason).
 * Grows per milestone.
 */
export const AuditActions = {
  // admissions / students / enrollment (M2)
  INQUIRY_STATUS_CHANGED: 'INQUIRY_STATUS_CHANGED',
  STUDENT_ADMITTED: 'STUDENT_ADMITTED',
  STUDENT_UPDATED: 'STUDENT_UPDATED',
  STUDENT_DELETED: 'STUDENT_DELETED',
  STUDENT_STATUS_CHANGED: 'STUDENT_STATUS_CHANGED',
  /** A national ID was decrypted and shown to a human — the read itself is the event worth
   *  recording, which is why reveal is a separate endpoint and not part of the profile load. */
  STUDENT_CNIC_REVEALED: 'STUDENT_CNIC_REVEALED',
  /** A CNIC was recorded or replaced after admission. Replacing one changes a live portal
   *  credential, so the event matters even though the value is never written to the log. */
  STUDENT_CNIC_SET: 'STUDENT_CNIC_SET',
  GUARDIAN_LINKED: 'GUARDIAN_LINKED',
  GUARDIAN_UNLINKED: 'GUARDIAN_UNLINKED',
  PRIMARY_GUARDIAN_CHANGED: 'PRIMARY_GUARDIAN_CHANGED',
  GUARDIAN_RELATION_CHANGED: 'GUARDIAN_RELATION_CHANGED',
  GUARDIAN_CONTACT_UPDATED: 'GUARDIAN_CONTACT_UPDATED',
  ENROLLMENT_TRANSFERRED: 'ENROLLMENT_TRANSFERRED',
  ACADEMIC_YEAR_SET_CURRENT: 'ACADEMIC_YEAR_SET_CURRENT',

  // Structural deletes (setup). audit_logs has no FK to the entity — by design, so the row
  // outlives what it describes — which means oldValue must carry enough identity to say
  // WHAT was destroyed, not just its now-dangling id.
  CAMPUS_DELETED: 'CAMPUS_DELETED',
  CLASS_DELETED: 'CLASS_DELETED',
  SECTION_DELETED: 'SECTION_DELETED',
  SUBJECT_DELETED: 'SUBJECT_DELETED',
  // Drifted subject names (Mathmetics / Maths → Mathematics) folded onto one canonical name.
  // Where a class already had the target name, the duplicate's exam results, teacher assignments,
  // timetable slots, section links and class tests were repointed onto it and the duplicate deleted.
  SUBJECT_MERGED: 'SUBJECT_MERGED',
  TEACHER_ASSIGNMENT_REMOVED: 'TEACHER_ASSIGNMENT_REMOVED',

  /**
   * The school's own clock (bell schedule). Changing a day reshapes every register and every
   * teacher's week on that day, and — because there is deliberately no dated seasonal variant —
   * editing the timings IS how a school runs a Ramadan or exam schedule. So the log is the only
   * place the previous shape survives, which is exactly the argument Cover made for auditing a
   * permission grant. `oldValue`/`newValue` carry the composed day, not the whole schedule.
   */
  BELL_SCHEDULE_CREATED: 'BELL_SCHEDULE_CREATED',
  BELL_SCHEDULE_UPDATED: 'BELL_SCHEDULE_UPDATED',
  BELL_SCHEDULE_DELETED: 'BELL_SCHEDULE_DELETED',
  BELL_SCHEDULE_DAY_SET: 'BELL_SCHEDULE_DAY_SET',

  // auth / platform (M1)
  ROLE_CHANGED: 'ROLE_CHANGED',
  USER_DISABLED: 'USER_DISABLED',
  USER_REMOVED: 'USER_REMOVED',
  MFA_RESET: 'MFA_RESET',
  /**
   * A CORRECT password presented at the wrong login door (§29, Owner Login Plan I8) — an owner at
   * the staff door, or anyone else at the owner door.
   *
   * ⚠️ Worth a row precisely because the caller is told nothing: the refusal is byte-identical to
   * a wrong password so the door cannot be used to discover who the owner is, which leaves the audit
   * log as the ONLY place this event is visible. It is either a confused owner or somebody probing a
   * credential they should not hold, and the two look the same from outside.
   */
  LOGIN_WRONG_DOOR: 'LOGIN_WRONG_DOOR',
  SCHOOL_PROVISIONED: 'SCHOOL_PROVISIONED',
  /** School settings changed. These govern money (fee due day, proration, sibling discount)
   *  and pay (attendance windows, self-marking), so the row records only the keys that moved
   *  with their before/after — a diff, not a dump of the whole blob. */
  SCHOOL_SETTINGS_UPDATED: 'SCHOOL_SETTINGS_UPDATED',

  // finance / exams (later milestones — declared as they are used)
  FEE_WAIVED: 'FEE_WAIVED',
  /** One student invoiced on their own, outside a class batch (Fees Billing Plan, B1) — the
   *  mid-session admission and the cashier's "generate for this child" path. Recorded because it
   *  is a discretionary act by a person, where a batch is a scheduled one over a whole class. */
  INVOICE_GENERATED: 'INVOICE_GENERATED',
  /** An office user asked the owner to sign off something (a campus's monthly vouchers, a school-wide setup change). */
  APPROVAL_REQUESTED: 'APPROVAL_REQUESTED',
  APPROVAL_APPROVED: 'APPROVAL_APPROVED',
  APPROVAL_REJECTED: 'APPROVAL_REJECTED',
  FINE_WAIVED: 'FINE_WAIVED',
  PAYMENT_REVERSED: 'PAYMENT_REVERSED',
  GRADE_CHANGED_POST_PUBLISH: 'GRADE_CHANGED_POST_PUBLISH',
  TERM_DELETED: 'TERM_DELETED',
  EXAM_DELETED: 'EXAM_DELETED',
  ATTENDANCE_EDITED_POST_WINDOW: 'ATTENDANCE_EDITED_POST_WINDOW',
  /** An admin replaced what a staff member recorded about themselves. It changes their pay,
   *  so the previous claim is preserved in `oldValue` — the row itself forgets. */
  STAFF_ATTENDANCE_OVERRIDDEN: 'STAFF_ATTENDANCE_OVERRIDDEN',
  /** An admin changed staff attendance for a month that had already closed (G5). There is no
   *  backfill floor here on purpose — schools do correct last month's register — but staff
   *  attendance feeds payroll, and reaching back a month with no trace was the actual hole. */
  STAFF_ATTENDANCE_BACKDATED: 'STAFF_ATTENDANCE_BACKDATED',
  /** A school closure was declared or removed. Audited because it moves money: a closure changes
   *  the month's working-day count, which is the divisor for every absence deduction — so
   *  re-opening a day quietly changes what everyone should have been paid. */
  HOLIDAY_DECLARED: 'HOLIDAY_DECLARED',
  HOLIDAY_REMOVED: 'HOLIDAY_REMOVED',
  /** Someone was given the right to mark another class's register for a day (Cover Plan).
   *  Audited because it **is a permission grant, not a note**: it lets one person write to a
   *  register that feeds pay and defaulter reporting, and it can be created for a past date. The
   *  row names both teachers, so "who took my class, and who decided" survives the cover itself. */
  COVER_ASSIGNED: 'COVER_ASSIGNED',
  COVER_REMOVED: 'COVER_REMOVED',
  /** Somebody claimed a payment, and somebody decided about it. A claim is the evidence trail
   *  for money the school did not watch arrive — VERIFIED records the receipt it produced. */
  FEE_CLAIM_SUBMITTED: 'FEE_CLAIM_SUBMITTED',
  FEE_CLAIM_VERIFIED: 'FEE_CLAIM_VERIFIED',
  /** A bank statement was uploaded for reconciliation. Records what was parsed vs stored —
   *  the gap between them is the duplicate lines a re-upload correctly skipped. */
  FEE_STATEMENT_IMPORTED: 'FEE_STATEMENT_IMPORTED',
  FEE_CLAIM_REJECTED: 'FEE_CLAIM_REJECTED',
  /** A chargeable item was removed from the school's list. Only ever possible while nothing
   *  references it, so the name is all that needs preserving. */
  FEE_HEAD_DELETED: 'FEE_HEAD_DELETED',
  /** A class's price changed or was switched off. These decide what every family in that
   *  class is billed, so the previous amount is preserved in `oldValue`. */
  FEE_STRUCTURE_UPDATED: 'FEE_STRUCTURE_UPDATED',
  FEE_STRUCTURE_DELETED: 'FEE_STRUCTURE_DELETED',
  /** A whole plan copied across classes or rolled into the next year. */
  FEE_PLAN_COPIED: 'FEE_PLAN_COPIED',
  DISCOUNT_APPROVED: 'DISCOUNT_APPROVED',
  DISCOUNT_REVOKED: 'DISCOUNT_REVOKED',
  PROMOTION_OVERRIDE: 'PROMOTION_OVERRIDE',
  PROMOTION_COMMITTED: 'PROMOTION_COMMITTED',
  PAYROLL_DRAFT_DISCARDED: 'PAYROLL_DRAFT_DISCARDED',
  WITHDRAWAL_FEE_OVERRIDE: 'WITHDRAWAL_FEE_OVERRIDE',
  STUDENT_WITHDRAWN: 'STUDENT_WITHDRAWN',
  CERTIFICATE_ISSUED: 'CERTIFICATE_ISSUED',
  PII_ANONYMIZED: 'PII_ANONYMIZED',
  DATA_EXPORTED: 'DATA_EXPORTED',
  SUPPORT_SESSION_STARTED: 'SUPPORT_SESSION_STARTED',

  // HR — recruitment

  // Access grants — owner assigns/removes a role on an existing employee (reused account)
  HR_ACCESS_GRANTED: 'HR_ACCESS_GRANTED',
  HR_ACCESS_REVOKED: 'HR_ACCESS_REVOKED',
  CAMPUS_ADMIN_GRANTED: 'CAMPUS_ADMIN_GRANTED',
  CAMPUS_ADMIN_REVOKED: 'CAMPUS_ADMIN_REVOKED',
  ROLE_ACCESS_GRANTED: 'ROLE_ACCESS_GRANTED',
  ROLE_ACCESS_REVOKED: 'ROLE_ACCESS_REVOKED',
  MODULE_ACCESS_CHANGED: 'MODULE_ACCESS_CHANGED',

  // The per-campus admission seat (§8/§23): one officer per campus, so a change of holder is
  // a single handover event. Recorded as one row naming BOTH parties — a revoke row plus a
  // grant row would not prove they were the same decision, and the seat is the thing that
  // moved, not two unrelated permissions.
  ADMISSION_OFFICER_ASSIGNED: 'ADMISSION_OFFICER_ASSIGNED',
  ADMISSION_OFFICER_REMOVED: 'ADMISSION_OFFICER_REMOVED',

  // A text to many families at once (GAP-15): who chose the audience, what it said, how many it reached.
  SMS_BROADCAST_SENT: 'SMS_BROADCAST_SENT',

  // A salary recorded as handed over. Cash leaves no bank trail, so this row is the trail.
  PAYSLIP_MARKED_PAID: 'PAYSLIP_MARKED_PAID',
} as const;

export type AuditAction = (typeof AuditActions)[keyof typeof AuditActions];
