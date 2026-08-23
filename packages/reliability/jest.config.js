/**
 * Jest configuration for @askturret/mcp-reliability
 */

export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  // The scenarios drive real concurrency and a real drain, so the default 5s
  // is not enough even at the scaled-down PR size.
  testTimeout: 60000,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts'],
};
