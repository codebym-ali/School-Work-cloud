const MUHAMMAD_VARIANTS = /^(?:muhammad|mohammed|mohammad|muhammed|mohd|mohmd|muhd)$/i;
const ABDUL_VARIANTS = /^(?:abd|abdl)$/i;

/**
 * Normalize a Pakistani name for duplicate matching:
 * lowercase, collapse whitespace, canonicalize Muhammad/Abdul variants,
 * strip common honorifics, and remove diacritics.
 */
export function normalizePkName(raw: string): string {
  let name = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[.\-']/g, ' ')
    .replace(/\s+/g, ' ');

  const parts = name.split(' ').filter(Boolean);
  const normalized = parts.map((p) => {
    if (MUHAMMAD_VARIANTS.test(p)) return 'muhammad';
    if (ABDUL_VARIANTS.test(p)) return 'abdul';
    return p;
  });

  return normalized.join(' ');
}
