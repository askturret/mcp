/**
 * Type-level and runtime tests for canonical types
 *
 * Verifies:
 * 1. Every OperationErrorCode is listed, exactly once, and usable
 * 2. OperationDefinition structure is correct
 * 3. OperationResult discriminated union works
 * 4. No raw Error objects leak (compile-time check)
 * 5. Source-specific fields cannot reach the canonical model (compile-time check)
 *
 * Two runners, deliberately. `tsc` enforces 4 and 5 and the exhaustiveness half
 * of 1 — see the "forbidden shapes" section at the bottom for how. Jest runs
 * the rest, which is new: until #216 this file was excluded from jest AND had a
 * self-invocation runner that never fired, so nothing in it executed at all.
 *
 * Check 1 deliberately no longer names a COUNT. A hand-maintained "all N codes"
 * assertion is exactly what went stale here; the count is now derived from the
 * union by the compiler rather than restated in prose.
 */

import { describe, it, expect } from '@jest/globals';

import type {
  OperationDefinition,
  OperationCommand,
  OperationResult,
  OperationError,
  OperationErrorCode,
  RegistrySnapshot,
} from '../types.js';

// =============================================================================
// Type-level tests (compile-time checks)
// =============================================================================

/**
 * Type test: OperationDefinition requires all mandatory fields
 */
const validDefinition: OperationDefinition = {
  id: 'op-001',
  name: 'createUser',
  description: 'Creates a new user',
  input: { type: 'object', properties: {} },
  output: { type: 'object', properties: {} },
  effects: {
    readOnly: false,
    idempotent: true,
    retryable: true,
    idempotencyKeyRequired: false,
    classifications: ['state-change'],
  },
  executor: { type: 'handler' },
};

/**
 * Type test: OperationDefinition with all optional fields
 */
const fullDefinition: OperationDefinition = {
  ...validDefinition,
  annotations: { sourceApi: 'users-v2' },
  provenance: [
    { field: 'description', kind: 'openapi', location: 'openapi.yaml#/paths/users/post' },
  ],
};
void fullDefinition; // Type-level test - intentionally unused

/**
 * Type test: OperationResult success case
 */
const successResult: OperationResult<{ userId: string }> = {
  ok: true,
  value: { userId: 'user-123' },
  metadata: { durationMs: 42 },
};
void successResult; // Type-level test - intentionally unused

/**
 * Type test: OperationResult error case
 */
const errorResult: OperationResult<never> = {
  ok: false,
  error: {
    code: 'INVALID_INPUT',
    message: 'Missing required field: email',
    details: { field: 'email' },
  },
};
void errorResult; // Type-level test - intentionally unused

/**
 * Type test: OperationCommand with all fields
 */
const command: OperationCommand = {
  requestId: 'req-001',
  operationId: 'op-001',
  input: { email: 'test@example.com' },
  principal: { id: 'user-123', type: 'user' },
  confirmation: {
    challengeId: 'ch-001',
    response: 'confirmed',
    confirmedAt: new Date(),
  },
  idempotencyKey: 'idem-001',
  deadline: new Date(Date.now() + 30000),
  signal: new AbortController().signal,
  registryHash: 'hash-001',
};
void command; // Type-level test - intentionally unused

/**
 * Type test: RegistrySnapshot structure
 */
const snapshot: RegistrySnapshot = {
  version: 1,
  hash: 'snapshot-hash',
  createdAt: new Date(),
  operations: new Map([['op-001', validDefinition]]),
};
void snapshot; // Type-level test - intentionally unused

// =============================================================================
// Runtime tests - every OperationErrorCode is reachable
// =============================================================================

/**
 * Every member of the `OperationErrorCode` union, listed once.
 *
 * The list is hand-written because a TypeScript union has no runtime form to
 * enumerate. That is exactly what went wrong before (#216): this list drifted
 * out of date and nobody noticed, because the file it lives in never ran.
 *
 * So the list is no longer trusted on its own. It is pinned to the union from
 * BOTH sides by the two assertions below, at compile time, and checked for
 * duplicates at run time — which the type system cannot see.
 */
const ALL_ERROR_CODES = [
  'INVALID_INPUT',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFIRMATION_REQUIRED',
  'RATE_LIMITED',
  'QUEUE_FULL',
  'TIMEOUT',
  'CANCELLED',
  'UPSTREAM_UNAVAILABLE',
  'OUTCOME_UNKNOWN',
  'REQUEST_TOO_LARGE',
  'OUTPUT_TOO_LARGE',
  'INTERNAL_ERROR',
] as const satisfies readonly OperationErrorCode[];

/** Only satisfied when `T` is exactly `true`; the compile-time assert. */
type Assert<T extends true> = T;

/**
 * Compile-time exhaustiveness, both directions.
 *
 * Add a 15th code to the union and forget this list, and `MISSING` stops being
 * `never` — `tsc` fails on the line below rather than the omission sitting here
 * unnoticed until someone reads it. The reverse direction catches a code
 * removed from the union but left here.
 *
 * `tsc` is a real runner for these: `packages/core`'s tsconfig includes
 * `src/**\/*` and CI builds the package, the same mechanism #298 relies on.
 * Exported so `noUnusedLocals` does not strip the assertion as dead.
 */
type MISSING = Exclude<OperationErrorCode, (typeof ALL_ERROR_CODES)[number]>;
type STRAY = Exclude<(typeof ALL_ERROR_CODES)[number], OperationErrorCode>;

export type EveryErrorCodeIsListed = Assert<[MISSING] extends [never] ? true : false>;
export type NoListedCodeIsStale = Assert<[STRAY] extends [never] ? true : false>;

describe('OperationErrorCode', () => {
  it('lists every union member exactly once', () => {
    // Exhaustiveness itself is proven at compile time above. What the compiler
    // CANNOT see is a duplicate — listing one code twice still satisfies both
    // Exclude<> assertions, so it needs a runtime check.
    expect(new Set(ALL_ERROR_CODES).size).toBe(ALL_ERROR_CODES.length);
  });

  it('accepts every code in an OperationError', () => {
    for (const code of ALL_ERROR_CODES) {
      const error: OperationError = { code, message: `Test error for ${code}` };
      expect(error.code).toBe(code);
    }
  });
});

// =============================================================================
// Golden fixture test - OperationError wire shape
// =============================================================================

describe('OperationError wire shape', () => {
  it('survives a JSON round-trip without leaking internals', () => {
    const error: OperationError = {
      code: 'TIMEOUT',
      message: 'Operation exceeded deadline',
      details: { deadlineMs: 5000, elapsedMs: 5100 },
    };

    const parsed = JSON.parse(JSON.stringify(error)) as OperationError;

    expect(parsed.code).toBe('TIMEOUT');
    expect(parsed.message).toBe('Operation exceeded deadline');
    expect(parsed.details?.['deadlineMs']).toBe(5000);

    // `stack` and `name` would mean a raw Error had been used as the wire
    // shape. The compile-time guard at the bottom of this file forbids that
    // assignment; this is the run-time half of the same claim.
    expect('stack' in parsed).toBe(false);
    expect('name' in parsed).toBe(false);
  });
});

// =============================================================================
// Type-level tests: forbidden shapes must not compile
// =============================================================================

/**
 * How the two guards below are enforced.
 *
 * They run at COMPILE time, not at run time — `tsc` is the test runner. This
 * file is inside `packages/core`'s `include` (`src/**\/*`), so `npm run build
 * -w packages/core` type-checks it, and CI runs exactly that in the
 * `test-core` job before the jest step.
 *
 * `@ts-expect-error` inverts the build: the directive is only satisfied while
 * the line below it is still an error. If a forbidden shape ever starts
 * compiling — someone widens `OperationError`, or adds an index signature to
 * `OperationDefinition` — TypeScript reports the now-unnecessary directive
 * ("Unused '@ts-expect-error' directive") and the build FAILS. That inversion
 * is what makes these live guards rather than commented-out intentions.
 *
 * These are independent of jest: the compiler checks them either way. That
 * mattered more when this file was excluded from jest entirely — #216 has
 * since converted it, so both runners now cover it, each for the half it can
 * actually see.
 */

/**
 * Type test: a raw `Error` is not an `OperationError`.
 *
 * `OperationError` is the wire shape; a raw `Error` carries `name`/`stack` and
 * lacks `code`, so leaking one across the boundary must be a type error. The
 * runtime half of this claim is `testOperationErrorWireShape` above.
 */
const rawError = new Error('Something went wrong');
// @ts-expect-error - a raw Error has no `code` and is not a valid OperationError
const operationError: OperationError = rawError;
void operationError; // Type-level test - intentionally unused

/**
 * Type test: source-specific fields cannot be added to `OperationDefinition`.
 *
 * This is the compile-time enforcement of `OperationDefinition` invariant 2
 * ("No source-specific fields - use annotations or provenance instead"), and
 * the evidence cited by readiness criterion 1. `openApiPath` stands in for any
 * source-native field: the canonical shape is closed, so an OpenAPI-specific
 * key is rejected by TypeScript's excess-property check.
 *
 * The directive sits on the PROPERTY, not on the `const`, because that is the
 * line the excess-property error is reported against — on the declaration it
 * would suppress nothing and silently pass.
 *
 * The sanctioned escape hatch is asserted positively by `fullDefinition`
 * above, which sets `annotations` and `provenance` and must keep compiling.
 * Without that counterpart this guard would also be satisfied by a
 * `OperationDefinition` that rejected everything.
 */
const invalidDefinition: OperationDefinition = {
  ...validDefinition,
  // @ts-expect-error - source-specific data belongs in `annotations`, not the canonical shape
  openApiPath: '/users',
};
void invalidDefinition; // Type-level test - intentionally unused

// The self-invocation runner that used to sit here is gone (#216). It compared
// `import.meta.url` against `` `file://${process.argv[1]}` ``, which never
// matched: argv[1] is the path AS INVOKED (usually relative), while
// `import.meta.url` is an absolute, percent-encoded URL. On a checkout whose
// path contains a space the two cannot be equal even when the path is absolute.
//
// So `npm run test:types` exited 0 having printed nothing, and jest was
// configured to ignore this file besides. The assertions above are now ordinary
// jest tests collected by the `test-core` job, which removes the bespoke entry
// point rather than repairing it — there is no second way to run this file that
// could rot again.
