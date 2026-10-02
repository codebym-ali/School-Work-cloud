/**
 * Strip dashes from a CNIC string and validate it is exactly 13 digits.
 * Returns the bare 13-digit string, or null if invalid.
 */
export function normalizeCnic(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 13) return null;
  return digits;
}

/** RegExp for class-validator @Matches on a CNIC field (with optional dashes). */
export const CNIC_REGEX = /^\d{5}-?\d{7}-?\d$/;
