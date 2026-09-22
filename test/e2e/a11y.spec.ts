import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { gotoApp } from './helpers';

/**
 * Accessibility gate (axe-core over the owner app), WCAG 2.0/2.1 A + AA.
 *
 * It gates on **serious and critical** violations — the impact levels that actually stop a keyboard
 * or screen-reader user (a control with no accessible name, an input with no label, failing
 * contrast). Moderate/minor findings are printed, never failed.
 *
 * **Baseline, not zero-tolerance.** The app carries an existing backlog, so a zero-tolerance gate
 * could never land green. Instead `a11y-baseline.json` records today's serious/critical count per
 * page per rule; the gate fails only when a page exceeds its baseline for a rule, or introduces a new
 * rule — i.e. on a *regression*. As screens are fixed, regenerate the baseline (it can only ratchet
 * down): `A11Y_UPDATE=1 pnpm test:a11y`. A count that tries to climb back up fails the build.
 *
 * Its own Playwright project (`a11y`) needs only the tenant-owner session — API + owner-web, not the
 * platform console — so it is cheap to run in CI.
 */
const PAGES: { path: string; name: string }[] = [
  { path: '/dashboard', name: 'Dashboard' },
  { path: '/students', name: 'Students' },
  { path: '/classes', name: 'Classes' },
  { path: '/subjects', name: 'Subjects' },
  { path: '/reports', name: 'Reports' },
  { path: '/fees', name: 'Fees' },
  { path: '/staff', name: 'Staff' },
  { path: '/attendance', name: 'Attendance' },
  { path: '/settings', name: 'Settings' },
];

const BLOCKING = new Set(['serious', 'critical']);
const BASELINE_PATH = join(__dirname, 'a11y-baseline.json');
const UPDATE = process.env.A11Y_UPDATE === '1';

type Baseline = Record<string, Record<string, number>>;
const readBaseline = (): Baseline => (existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : {});

for (const p of PAGES) {
  test(`a11y: ${p.name} has no NEW serious/critical axe violations`, async ({ page }) => {
    await gotoApp(page, p.path);
    await page.waitForLoadState('networkidle').catch(() => {});
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const others = violations.filter((v) => !BLOCKING.has(v.impact ?? ''));
    if (others.length) {
      // eslint-disable-next-line no-console
      console.log(`[a11y] ${p.name} — ${others.length} moderate/minor (not gated): ${others.map((v) => `${v.id}(${v.impact})`).join(', ')}`);
    }

    // Serious/critical count per rule for this page.
    const current: Record<string, number> = {};
    for (const v of violations) {
      if (!BLOCKING.has(v.impact ?? '')) continue;
      current[v.id] = (current[v.id] ?? 0) + v.nodes.length;
    }

    if (UPDATE) {
      // Serial project (workers:1), so read-modify-write of the shared file is safe.
      const baseline = readBaseline();
      baseline[p.name] = current;
      writeFileSync(BASELINE_PATH, `${JSON.stringify(sortDeep(baseline), null, 2)}\n`);
      // eslint-disable-next-line no-console
      console.log(`[a11y] baseline updated for ${p.name}: ${JSON.stringify(current)}`);
      return;
    }

    const baseline = readBaseline()[p.name] ?? {};
    const regressions = Object.entries(current)
      .filter(([id, n]) => n > (baseline[id] ?? 0))
      .map(([id, n]) => `${id}: ${n} > baseline ${baseline[id] ?? 0}`);
    expect(regressions, `${p.name} introduced new serious/critical a11y violations (fix them, do not raise the baseline)`).toEqual([]);
  });
}

/** Stable key order so the committed baseline diffs cleanly. */
function sortDeep(b: Baseline): Baseline {
  const out: Baseline = {};
  for (const page of Object.keys(b).sort()) {
    out[page] = Object.fromEntries(Object.entries(b[page]).sort(([a], [c]) => a.localeCompare(c)));
  }
  return out;
}
