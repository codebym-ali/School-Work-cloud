/** Job payloads consumed by the SMS worker (blueprint §26, §27). */
export type SmsJob =
  | { type: 'ABSENCE'; schoolId: string; enrollmentId: string; studentId: string; date: string }
  | { type: 'LEAVE_STATUS'; schoolId: string; studentId: string; status: string }
  | { type: 'RESULT_READY'; schoolId: string; studentId: string; term: string }
  | { type: 'FEE_RECEIPT'; schoolId: string; studentId: string; invoiceId: string; amount: number; receiptNo: number }
  /**
   * A closure announcement to one student's guardian.
   *
   * ⚠️ Fanned out one job PER STUDENT rather than one job for the school. The queue already retries,
   * logs and de-duplicates per message, and a single job looping 400 families would lose all of
   * that the moment one send failed halfway.
   */
  | { type: 'SCHOOL_CLOSED'; schoolId: string; studentId: string; holidayId: string; date: string; reason: string }
  | { type: 'MANUAL'; schoolId: string; recipients: string[]; body: string };

export const SMS_QUEUE = Symbol('SMS_QUEUE');
export const SMS_QUEUE_NAME = 'sms';
