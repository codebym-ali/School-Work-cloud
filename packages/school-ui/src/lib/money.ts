/**
 * Money for GLANCEABLE surfaces (the owner home), in the units a Pakistani owner says out loud:
 * lakh (1,00,000) and crore (1,00,00,000). "Rs 6.75 lakh" is read in one look; "Rs 675,000.00"
 * has to be counted (Owner Dashboard Redesign Plan §3; research: Few's "too much precision").
 *
 * ⚠️ **Headlines only.** A ledger, a receipt, a reconciliation — anything someone checks against a
 * bank statement — keeps full rupees with two decimals (`money()` on the Fees screens). Rounding
 * belongs where the question is "roughly how much", never where it is "exactly how much".
 *
 * ⚠️ **Arithmetic, not `Intl` compact notation.** `Intl.NumberFormat('en-IN', {notation:'compact'})`
 * output differs between engines and versions ("6.8L", "6.75 lakh", "7L"), and a figure that
 * renders two ways on two phones is one nobody can trust — the same reason `money()` pins its
 * locale. The thresholds here are exact and tested.
 */

const LAKH = 100_000;
const CRORE = 10_000_000;

/** Up to two decimals, trailing zeros dropped: 6.75 → "6.75", 6.5 → "6.5", 10 → "10". */
function trim2(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
}

/**
 * `long`  → "Rs 6.75 lakh" · "Rs 1.25 crore" · "Rs 45,000"   (sentences, card values)
 * `short` → "Rs 6.75L"     · "Rs 1.25Cr"     · "Rs 45,000"   (chart labels, tight tiles)
 *
 * Below one lakh the full figure is already short, so it is printed whole (no "45K": thousands
 * is not how this market counts money, and "0.45 lakh" reads as a mistake).
 */
export function moneyShort(v: number, style: 'long' | 'short' = 'long'): string {
  if (!Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);

  if (a < LAKH) {
    return `${sign}Rs ${Math.round(a).toLocaleString('en-US')}`;
  }
  // Round FIRST, then choose the unit: 99,99,999 is "100 lakh" after rounding, which must read as
  // "1 crore" — deciding the unit before rounding would print the one figure nobody says aloud.
  const lakhs = Math.round((a / LAKH) * 100) / 100;
  if (lakhs < 100) {
    return `${sign}Rs ${trim2(lakhs)}${style === 'short' ? 'L' : ' lakh'}`;
  }
  const crores = a / CRORE;
  return `${sign}Rs ${trim2(crores)}${style === 'short' ? 'Cr' : ' crore'}`;
}

/**
 * Whole-number percentage of `part` in `whole`, or null when the whole is not a real base (nothing
 * billed yet). Capped at 100: advance payments can make "collected" exceed "billed" for the month,
 * and a bar at 112% says something false about the month's dues.
 */
export function percentOf(part: number, whole: number): number | null {
  if (!(whole > 0)) return null;
  return Math.min(100, Math.max(0, Math.round((part / whole) * 100)));
}
