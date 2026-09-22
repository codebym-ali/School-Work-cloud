/**
 * Human-readable URL slugs for the campus segment of the Admission Portal link (#18).
 *
 * The link was `/admission-portal/<raw campus name>`, so a campus called "Falcon school main Campus"
 * produced `/admission-portal/Falcon%20school%20main%20Campus` — spaces as `%20`, mixed case, ugly to
 * paste into a WhatsApp message and awkward to read back. The segment is display-only (login is the
 * ordinary school-wide sign-in; nothing is resolved from it), so a slug is a safe, purely cosmetic fix.
 */

/** "Falcon school main Campus" → "falcon-school-main-campus". */
export function toSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** "falcon-school-main-campus" → "Falcon School Main Campus" (for the portal's subtitle). Tolerates a
 *  legacy space-separated segment too, so old links still read correctly. */
export function fromSlug(slug: string): string {
  return slug
    .replace(/-+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}
