/**
 * Default SMS templates seeded per school (blueprint §14). OWNER_ADMIN can edit
 * them later. Placeholders use {token} and are filled at send time.
 */
export const SMS_TRIGGER_KEYS = [
  'FEE_REMINDER',
  'FEE_RECEIPT',
  'ABSENCE',
  'RESULT_READY',
  'LEAVE_STATUS',
  'SCHOOL_CLOSED',
  'ACCOUNT_INVITE',
  'MANUAL',
] as const;

export type SmsTriggerKey = (typeof SMS_TRIGGER_KEYS)[number];

export const DEFAULT_TEMPLATES: Record<SmsTriggerKey, string> = {
  ABSENCE:
    'Dear Parent, your child {studentName} was marked ABSENT on {date}. - {schoolName}',
  // ⚠️ Deliberately short. This goes to every guardian at once, and every 160 characters is another
  // segment billed per family — a wordier default would quietly double the cost of a closure.
  SCHOOL_CLOSED:
    'School will be CLOSED on {date} ({reason}). - {schoolName}',
  FEE_RECEIPT:
    'Payment of Rs {amount} received for {studentName}. Receipt #{receiptNo}. - {schoolName}',
  FEE_REMINDER:
    'Reminder: fee of Rs {amount} for {studentName} is due on {dueDate}. - {schoolName}',
  RESULT_READY:
    'Result for {studentName} ({term}) is now available on the portal. - {schoolName}',
  LEAVE_STATUS: 'Leave request for {name} has been {status}. - {schoolName}',
  ACCOUNT_INVITE: 'Welcome to {schoolName}. Set your password here: {link}',
  MANUAL: '',
};
