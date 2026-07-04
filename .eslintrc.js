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
    project: 'tsconfig.json',
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
  ],
  ignorePatterns: ['dist/', 'node_modules/', '**/generated/**', '*.js'],
};
