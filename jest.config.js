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
      testMatch: ['<rootDir>/apps/**/*.spec.ts', '<rootDir>/libs/**/*.spec.ts'],
    },
    {
      ...base,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.e2e-spec.ts'],
      // Every suite boots the whole AppModule (Nest DI + Prisma + Redis) in beforeAll.
      // Jest's 5s default is not a realistic budget for that: it only ever passed because
      // ts-jest's cache happened to be warm, and any cold run (fresh clone, cleared
      // .tsbuildinfo, CI) failed dozens of specs with "Exceeded timeout of 5000 ms for a
      // hook" — setup timeouts masquerading as product failures.
      testTimeout: 30000,
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
