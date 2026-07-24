/**
 * Shared presentation helpers for the self-service portals (student / parent / staff), so a
 * status or period is formatted the same everywhere instead of each page re-deriving it.
 */

const MONTHS = ['—', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Aug 2026" (or just "2026" when the invoice has no month). */
export function monthYear(month: number | null | undefined, year: number): string {
  return `${month ? MONTHS[month] : ''} ${year}`.trim();
}

/** Enum-ish status → human text: "HALF_DAY" → "HALF DAY". */
export function humanizeStatus(s: string): string {
  return s.replace(/_/g, ' ');
}

/** Attendance status → badge variant. Present-ish = ok, absent = bad, leave/other = warn. */
export function attendanceBadge(status: string): string {
  return ['PRESENT', 'LATE', 'HALF_DAY'].includes(status) ? 'ok' : status === 'ABSENT' ? 'bad' : 'warn';
}

/** Fee-invoice status → badge variant. Paid = ok, overdue = bad, partial = warn, pending = neutral. */
export function feeBadge(status: string): string {
  return status === 'PAID' ? 'ok' : status === 'OVERDUE' ? 'bad' : status === 'PARTIAL' ? 'warn' : '';
}
