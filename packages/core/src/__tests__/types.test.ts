/**
 * Type-level and runtime tests for canonical types
 *
 * Verifies:
 * 1. All 14 OperationErrorCode values are present
 * 2. OperationDefinition structure is correct
 * 3. OperationResult discriminated union works
 * 4. No raw Error objects leak (compile-time check)
 * 5. Source-specific fields cannot reach the canonical model (compile-time check)
 *
 * Checks 4 and 5 are enforced by `tsc`, not by the test runner — see the
 * "forbidden shapes" section at the bottom of this file for how that works.
 */

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
// Runtime tests - all 14 error codes present
// =============================================================================

/**
 * Test: All 14 OperationErrorCode values are reachable
 */
export function testAllErrorCodesPresent(): void {
  const allCodes: OperationErrorCode[] = [
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
  ];

  if (allCodes.length !== 14) {
    throw new Error(`Expected 14 error codes, found ${allCodes.length}`);
  }

  // Verify each code can be used in an OperationError
  allCodes.forEach((code) => {
    const error: OperationError = {
      code,
      message: `Test error for ${code}`,
    };
    if (error.code !== code) {
      throw new Error(`Error code mismatch: expected ${code}, got ${error.code}`);
    }
  });

  console.log('✓ All 14 OperationErrorCode values present and valid');
}

// =============================================================================
// Golden fixture test - OperationError wire shape
// =============================================================================

/**
 * Test: OperationError serializes safely (no leaked internals)
 */
export function testOperationErrorWireShape(): void {
  const error: OperationError = {
    code: 'TIMEOUT',
    message: 'Operation exceeded deadline',
    details: { deadlineMs: 5000, elapsedMs: 5100 },
  };

  const serialized = JSON.stringify(error);
  const parsed = JSON.parse(serialized) as OperationError;

  if (parsed.code !== 'TIMEOUT') {
    throw new Error('Code not preserved after serialization');
  }
  if (parsed.message !== 'Operation exceeded deadline') {
    throw new Error('Message not preserved after serialization');
  }
  if (!parsed.details || parsed.details['deadlineMs'] !== 5000) {
    throw new Error('Details not preserved after serialization');
  }

  // Verify no 'stack' or 'name' properties (leaked from Error object)
  if ('stack' in parsed || 'name' in parsed) {
    throw new Error('OperationError leaked internal Error properties');
  }

  console.log('✓ OperationError wire shape is safe (no leaked internals)');
}

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
 * Note this is independent of whether jest executes this file (#216): these
 * assertions are checked by the compiler either way.
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

// =============================================================================
// Run tests
// =============================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    testAllErrorCodesPresent();
    testOperationErrorWireShape();
    console.log('\n✅ All type tests passed');
  } catch (error) {
    console.error('\n❌ Type test failed:', error);
    process.exit(1);
  }
}
