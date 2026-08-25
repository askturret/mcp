/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Every entry here is a test file that DOES NOT RUN. `types.test.ts` was
  // removed from this list by #216: it held no jest tests, only exported
  // functions and a self-invocation runner that never fired, so the exclusion
  // was hiding a file that checked nothing rather than skipping a slow one.
  //
  // The two below have the SAME defect — excluded here AND carrying a
  // self-invocation guard that never fires, so nothing in them has ever run.
  // Deliberately not converted in #216's change; tracked by #313. Never add a
  // file to this list to quieten a failing suite; converting it is the fix.
  testPathIgnorePatterns: [
    '/node_modules/',
    'src/sources/__tests__/composite\\.test\\.ts',
    'src/sources/__tests__/from-definitions\\.test\\.ts',
  ],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts', '!src/__tests__/**'],
};
