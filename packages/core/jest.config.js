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
  // NO test file belongs in this list. #216 removed `types.test.ts`, and #313
  // removed the last two — `composite.test.ts` and `from-definitions.test.ts`,
  // both converted to real jest tests in the same change.
  //
  // All three had one shape: excluded HERE and carrying an
  // `import.meta.url === file://...` self-invocation runner that jest never
  // fires. Either half alone stops the file running; together they meant the
  // file name promised tests that had never once executed. Proven rather than
  // argued: a top-level `throw` added to composite.test.ts left the core suite
  // byte-identical at 55 suites / 847 tests, exit 0.
  //
  // Never add a test file here to quieten a failing suite. An excluded test
  // file reads as covered and is not, which is the one failure this
  // repository's guards exist to refuse. Converting it is the fix.
  testPathIgnorePatterns: ['/node_modules/'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts', '!src/__tests__/**'],
};
