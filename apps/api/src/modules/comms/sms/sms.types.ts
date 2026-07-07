/** Job payloads consumed by the SMS worker (blueprint §26, §27). */
export type SmsJob =
  | { type: 'ABSENCE'; schoolId: string; enrollmentId: string; studentId: string; date: string }
  | { type: 'LEAVE_STATUS'; schoolId: string; studentId: string; status: string }
  | { type: 'FEE_RECEIPT'; schoolId: string; studentId: string; invoiceId: string; amount: number; receiptNo: number }
  | { type: 'MANUAL'; schoolId: string; recipients: string[]; body: string };

export const SMS_QUEUE = Symbol('SMS_QUEUE');
export const SMS_QUEUE_NAME = 'sms';
