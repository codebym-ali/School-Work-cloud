export function normalizeSubjectName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function canonical(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function subjectCatalogueFrom(subjects: { name: string; classId: string }[]): { name: string; classCount: number }[] {
  const byName = new Map<string, { name: string; classes: Set<string> }>();
  for (const s of subjects) {
    const key = canonical(s.name);
    if (!key) continue;
    const entry = byName.get(key) ?? { name: s.name, classes: new Set<string>() };
    entry.classes.add(s.classId);
    byName.set(key, entry);
  }
  return [...byName.values()]
    .map((e) => ({ name: e.name, classCount: e.classes.size }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

function isSingleWord(value: string): boolean {
  return !/\s/.test(value.trim());
}

export function nearestSubject(name: string, catalogue: string[]): string | null {
  const target = canonical(name);
  if (target.length < 2) return null;
  if (catalogue.some((entry) => canonical(entry) === target)) return null;

  const targetSingleWord = isSingleWord(name);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const entry of catalogue) {
    const other = canonical(entry);
    if (other.length < 2) continue;

    const shorter = target.length < other.length ? target : other;
    const longer = target.length < other.length ? other : target;
    const prefixMatch = targetSingleWord && isSingleWord(entry) && shorter.length >= 3 && longer.startsWith(shorter);

    const distance = editDistance(target, other);
    const limit = Math.min(target.length, other.length) <= 4 ? 1 : 2;

    if (prefixMatch || distance <= limit) {
      const score = prefixMatch ? longer.length - shorter.length : distance;
      if (score < bestScore) {
        best = entry;
        bestScore = score;
      }
    }
  }

  return best;
}
