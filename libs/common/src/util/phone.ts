/**
 * Normalize a Pakistani phone number to E.164 (blueprint §8, §26 — guardian phones
 * are stored normalized so link-by-phone and SMS dedup work reliably).
 *
 *   03001234567  -> +923001234567
 *   3001234567   -> +923001234567
 *   923001234567 -> +923001234567
 *   +923001234567-> +923001234567
 *
 * Returns null when the input can't be interpreted as a PK mobile number.
 */
export function normalizePkPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  let n = digits.startsWith('+') ? digits.slice(1) : digits;

  if (n.startsWith('0')) n = `92${n.slice(1)}`;
  else if (n.startsWith('3')) n = `92${n}`;
  // else assume it already carries a country code

  // PK mobile: 92 + 3XXXXXXXXX (10 national digits).
  if (!/^923\d{9}$/.test(n)) return null;
  return `+${n}`;
}
