/**
 * ESLint config.
 * Enforces TypeScript strictness + module boundaries (blueprint §16, §34):
 * feature modules communicate only through exported services; import direction
 * is one-way (features -> common/database, never the reverse, never feature -> feature
 * except through a public index barrel).
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    // Both projects: `test/e2e` was split out of the root tsconfig (Playwright specs need the
    // DOM lib the API deliberately lacks), and a file in no project is a file eslint refuses
    // to parse — which is a silent hole, not a smaller lint run.
    project: ['tsconfig.json', 'test/e2e/tsconfig.json'],
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'boundaries'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:boundaries/recommended',
    'prettier',
  ],
  settings: {
    'boundaries/include': ['apps/**/*', 'libs/**/*'],
    'boundaries/elements': [
      { type: 'common', pattern: 'libs/common/*' },
      { type: 'database', pattern: 'libs/database/*' },
      { type: 'feature', pattern: 'apps/api/src/modules/*', capture: ['moduleName'] },
      { type: 'app', pattern: 'apps/*/src/*' },
    ],
  },
  rules: {
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    // Import direction is one-way: libs never depend on feature modules.
    // Feature<->feature is allowed (modules "communicate through exported services",
    // blueprint §16) — a barrel-enforced stricter rule is a future refinement.
    'boundaries/element-types': [
      'error',
      {
        default: 'allow',
        rules: [
          {
            from: ['common', 'database'],
            disallow: 'feature',
            message: 'libs must not depend on feature modules (import direction is one-way).',
          },
        ],
      },
    ],
  },
  overrides: [
    {
      files: ['*.spec.ts', '*.e2e-spec.ts', 'test/**/*.ts'],
      rules: { 'boundaries/element-types': 'off' },
    },
    {
      // The shared packages: React/JSX needing the DOM lib, which the backend project lacks.
      // Their own project (packages/tsconfig.lint.json) describes them, so type-aware rules work.
      // `boundaries` is off here — its element map covers apps/ and libs/, and packages/ is a flat
      // set of leaves with no import-direction rule to enforce.
      files: ['packages/**/*.ts', 'packages/**/*.tsx'],
      parserOptions: { project: ['packages/tsconfig.lint.json'] },
      plugins: ['react-hooks'],
      rules: {
        'boundaries/element-types': 'off',
        // ⚠️ These files already carried `eslint-disable-next-line react-hooks/exhaustive-deps`
        // comments while NO config defined the rule — suppressions against a rule nothing enforced.
        // It is worth having for real: the /timetable stale-closure bug (a mount effect capturing
        // `sectionId` as '' forever, so a late response overwrote the user's choice) is precisely
        // the class of defect this rule flags. Warn, not error, so the existing suppressions can be
        // revisited deliberately rather than blocking this gate landing.
        'react-hooks/rules-of-hooks': 'error',
        'react-hooks/exhaustive-deps': 'warn',
      },
    },
  ],
  /**
   * ⚠️ `apps/*-web` is a GLOB, matching tsconfig.json's exclude. This config is the BACKEND's, and
   * type-aware linting needs every file it touches to belong to the backend TS project — so once the
   * front-ends were excluded there, linting them here failed with "file was not found in any of the
   * provided project(s)" rather than with anything about the code. Each front-end has its own
   * `next lint` gate; they are not unlinted, they are linted by the config that understands them.
   */
  ignorePatterns: ['dist/', 'node_modules/', '**/generated/**', '*.js', 'apps/web/', 'apps/*-web/'],
};
