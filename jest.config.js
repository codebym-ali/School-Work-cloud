/** Jest projects mirror the CI order (blueprint §34): unit -> integration -> isolation. */
const base = {
  testEnvironment: 'node',
  rootDir: '.',
  setupFiles: ['<rootDir>/test/load-env.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@common$': '<rootDir>/libs/common/src',
    '^@common/(.*)$': '<rootDir>/libs/common/src/$1',
    '^@database$': '<rootDir>/libs/database/src',
    '^@database/(.*)$': '<rootDir>/libs/database/src/$1',
    // The shared front-end packages (Front-End Instance Separation Plan). They had NO unit
    // coverage at all after the split — the pure rules that decide the nav and the role sections
    // live here now, and they are the cheapest things in the app to test.
    '^@sw/(.*)$': '<rootDir>/packages/$1/src',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
};

module.exports = {
  projects: [
    {
      ...base,
      displayName: 'unit',
      // Two explicit patterns rather than a `{apps,libs}` brace — brace expansion in
      // testMatch is unreliable across OS path separators (matches 0 tests on Windows).
      testMatch: ['<rootDir>/apps/**/*.spec.ts', '<rootDir>/libs/**/*.spec.ts', '<rootDir>/packages/**/*.spec.ts'],
    },
    {
      ...base,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.e2e-spec.ts'],
      // Raises the 5s default to 30s — see the file for why it is not `testTimeout` here
      // (a project-level `testTimeout` is silently ignored: "Unknown option", 5s kept).
      setupFilesAfterEnv: ['<rootDir>/test/integration/support/timeout.ts'],
      // A live worker competes for the shared BullMQ "sms" queue and silently corrupts the
      // SMS assertions. Refuse to start rather than produce confusing failures.
      globalSetup: '<rootDir>/test/integration/support/no-worker.js',
    },
    {
      ...base,
      displayName: 'isolation',
      testMatch: ['<rootDir>/test/isolation/**/*.spec.ts'],
    },
  ],
};
