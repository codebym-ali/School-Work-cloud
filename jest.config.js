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
      testMatch: ['<rootDir>/{apps,libs}/**/*.spec.ts'],
    },
    {
      ...base,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.e2e-spec.ts'],
    },
    {
      ...base,
      displayName: 'isolation',
      testMatch: ['<rootDir>/test/isolation/**/*.spec.ts'],
    },
  ],
};
