/**
 * Shared presentation helpers for the self-service portals (student / parent / staff), so a
 * status or period is formatted the same everywhere instead of each page re-deriving it.
 */

const MONTHS = ['—', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Aug 2026" (or just "2026" when the invoice has no month). */
export function monthYear(month: number | null | undefined, year: number): string {
  return `${month ? MONTHS[month] : ''} ${year}`.trim();
}

/** A `YYYY-MM` performance bucket → "Sep 2026". Sibling of `monthYear`, which takes the
 *  numeric month/year an invoice carries; performance groups by a calendar-month key. */
export function monthKeyLabel(key: string): string {
  const [y, m] = key.split('-');
  return `${MONTHS[Number(m)] ?? ''} ${y}`.trim();
}

/**
 * Enum-ish value → human text in SENTENCE case: "HALF_DAY" → "Half day", "BANK_TRANSFER" → "Bank transfer",
 * "MALE" → "Male". (Owner UX Phase 2: it returned "HALF DAY" — shouting, and the exact thing the owner flagged.)
 * Anything that is not an all-caps enum (a name, "GR-0031") passes through untouched.
 */
export function humanizeStatus(s: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(s)) return s;
  const words = s.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Attendance status → badge variant. Present-ish = ok, absent = bad, leave/other = warn. */
export function attendanceBadge(status: string): string {
  return ['PRESENT', 'LATE', 'HALF_DAY'].includes(status) ? 'ok' : status === 'ABSENT' ? 'bad' : 'warn';
}

/** Fee-invoice status → badge variant. Paid = ok, overdue = bad, partial = warn, pending = neutral. */
export function feeBadge(status: string): string {
  return status === 'PAID' ? 'ok' : status === 'OVERDUE' ? 'bad' : status === 'PARTIAL' ? 'warn' : '';
}
