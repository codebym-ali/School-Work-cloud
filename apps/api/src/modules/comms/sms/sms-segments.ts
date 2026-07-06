/**
 * SMS segmentation (blueprint §14): compute encoding + segment count so we can
 * show it before send and charge credits per segment. Messages with any non-GSM-7
 * character (e.g. Urdu) fall back to UCS-2.
 */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
// GSM-7 characters that occupy two septets (escape + char).
const GSM7_EXTENDED = '^{}\\[~]|€';

export type SmsEncoding = 'GSM7' | 'UCS2';

export interface SmsSegmentInfo {
  encoding: SmsEncoding;
  length: number; // effective units (septets for GSM7, code units for UCS2)
  segments: number;
}

function isGsm7(text: string): boolean {
  for (const ch of text) {
    if (!GSM7_BASIC.includes(ch) && !GSM7_EXTENDED.includes(ch)) return false;
  }
  return true;
}

export function computeSegments(text: string): SmsSegmentInfo {
  if (isGsm7(text)) {
    let units = 0;
    for (const ch of text) units += GSM7_EXTENDED.includes(ch) ? 2 : 1;
    const segments = units <= 160 ? 1 : Math.ceil(units / 153);
    return { encoding: 'GSM7', length: units, segments: Math.max(segments, 1) };
  }
  // UCS-2 counts UTF-16 code units.
  const units = [...text].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  const segments = units <= 70 ? 1 : Math.ceil(units / 67);
  return { encoding: 'UCS2', length: units, segments: Math.max(segments, 1) };
}

/** Render "{placeholder}" tokens from a values map; unknown tokens are left intact. */
export function renderTemplate(body: string, values: Record<string, string | number>): string {
  return body.replace(/\{(\w+)\}/g, (m, key: string) =>
    key in values ? String(values[key]) : m,
  );
}
