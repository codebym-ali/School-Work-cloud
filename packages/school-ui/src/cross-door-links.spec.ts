import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * ⚠️ `packages/school-ui` renders on MORE THAN ONE DOOR, so "this origin" is not a fixed place.
 *
 * Two links in this package were built as `${window.location.origin}/…` and both broke silently at
 * the front-end split: Campus Hub's campus login pointed campus admins at the owner door, which
 * refuses them, and the Admission Portal link pointed at a route the owner door does not serve.
 * Neither failed a test, because each was correct on the door it was written for.
 *
 * Cross-door links go through `doorOrigin()` from `@sw/roles`. A link to the SAME door needs no
 * origin at all — a relative path does it.
 */
const ROOT = join(__dirname);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sources(full);
    return /\.(ts|tsx)$/.test(name) && !/\.spec\.tsx?$/.test(name) ? [full] : [];
  });
}

/**
 * Comments removed before matching, so explaining this rule in a comment does not trip it.
 * Deliberately simple: block comments, then line comments not preceded by `:` (which would be a URL
 * scheme inside a string, e.g. `https://`).
 */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('school-ui cross-door links', () => {
  it('never builds a URL from window.location.origin', () => {
    const offenders = sources(ROOT)
      .filter((file) => /window\.location\.origin/.test(code(readFileSync(file, 'utf8'))))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('still catches real usage when a comment sits on the same line', () => {
    // The guard must not be defeated by the comment stripping it relies on.
    expect(/window\.location\.origin/.test(code('const u = `${window.location.origin}/x`; // note'))).toBe(true);
    expect(/window\.location\.origin/.test(code('// window.location.origin was wrong here'))).toBe(false);
  });
});
