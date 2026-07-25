import type { StudentStatus } from '@/lib/api';

/** Plain-language vocabulary for the student lifecycle. Staff using this are school
 *  administrators, not engineers, so every status carries the consequence in words —
 *  the enum name alone doesn't tell anyone whether fees keep running. */
export const STUDENT_STATUS: Record<StudentStatus, { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted'; effect: string }> = {
  ACTIVE: { label: 'Active', tone: 'ok', effect: 'Attending normally.' },
  SUSPENDED: { label: 'Suspended', tone: 'warn', effect: 'Barred from school temporarily. Seat is held and fees continue. Can still sign in to the portal and will see a notice.' },
  RESTRICTED: { label: 'Restricted', tone: 'warn', effect: 'Still attending class, but portal access is blocked. Fees continue.' },
  STRUCK_OFF: { label: 'Struck off', tone: 'danger', effect: 'Name removed from the register. Seat released, billing stops, portal blocked. Any unpaid arrears remain owing.' },
  WITHDRAWN: { label: 'Withdrawn', tone: 'muted', effect: 'Left the school with a leaving certificate.' },
  GRADUATED: { label: 'Graduated', tone: 'muted', effect: 'Completed the final class.' },
};

/** Mirrors the server-side transition guard (students.service.ts). Kept in sync so the UI
 *  only offers moves the API will accept — WITHDRAWN is never offered, it belongs to the
 *  withdrawal workflow which also issues fee clearance and the leaving certificate. */
export const STATUS_TRANSITIONS: Record<StudentStatus, StudentStatus[]> = {
  ACTIVE: ['SUSPENDED', 'RESTRICTED', 'STRUCK_OFF', 'GRADUATED'],
  SUSPENDED: ['ACTIVE', 'RESTRICTED', 'STRUCK_OFF'],
  RESTRICTED: ['ACTIVE', 'SUSPENDED', 'STRUCK_OFF'],
  STRUCK_OFF: ['ACTIVE'],
  WITHDRAWN: [],
  GRADUATED: [],
};

const TONE_STYLE: Record<'ok' | 'warn' | 'danger' | 'muted', { background: string; color: string }> = {
  ok: { background: '#dcfce7', color: '#166534' },
  warn: { background: '#fef3c7', color: '#92400e' },
  danger: { background: '#fee2e2', color: '#991b1b' },
  muted: { background: '#e5e7eb', color: '#374151' },
};

export const statusStyle = (s: StudentStatus) => TONE_STYLE[STUDENT_STATUS[s].tone];
