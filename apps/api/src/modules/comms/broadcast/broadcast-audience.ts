/**
 * Who a broadcast actually reaches (GAP-15) — a pure function so the counting rules are testable alone.
 *
 * ⚠️ **One text per phone, not per student.** Three siblings share a mother; she gets one message, not
 * three. The school pays per message and the family reads it as spam.
 *
 * ⚠️ **The counts are the point.** "Send to Class 5" used to mean typing numbers by hand. The screen now
 * says, before anything is spent, how many families are reachable and why the rest are not — an unverified
 * number or a parent who opted out is a reason the office can act on, not a silent gap.
 */
export interface AudienceRow {
  studentId: string;
  guardian: { phone: string; verified: boolean; optedOut: boolean } | null;
}

export interface Audience {
  /** Distinct phones that will be texted. */
  recipients: string[];
  students: number;
  skipped: { noGuardian: number; unverified: number; optedOut: number };
}

export function resolveAudience(rows: readonly AudienceRow[]): Audience {
  const students = new Set<string>();
  const reachable = new Set<string>();
  const unverified = new Set<string>();
  const optedOut = new Set<string>();
  let noGuardian = 0;
  for (const r of rows) {
    if (students.has(r.studentId)) continue;
    students.add(r.studentId);
    const g = r.guardian;
    if (!g || !g.phone) { noGuardian += 1; continue; }
    // Opt-out wins over verification: a parent who said stop is never texted, and is counted as such.
    if (g.optedOut) optedOut.add(g.phone);
    else if (!g.verified) unverified.add(g.phone);
    else reachable.add(g.phone);
  }
  return {
    recipients: [...reachable].sort(),
    students: students.size,
    // Counted as families (phones), matching what `recipients` counts.
    skipped: { noGuardian, unverified: unverified.size, optedOut: optedOut.size },
  };
}

/** Split recipients into queue jobs small enough that one failure does not stall the whole broadcast. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
