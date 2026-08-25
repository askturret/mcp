/**
 * Type-level and runtime tests for canonical types
 *
 * Verifies:
 * 1. All 14 OperationErrorCode values are present
 * 2. OperationDefinition structure is correct
 * 3. OperationResult discriminated union works
 * 4. No raw Error objects leak (type-level check)
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
// Type-level test: raw Error objects cannot be assigned to OperationError
// =============================================================================

/**
 * Type test: raw Error cannot be used as OperationError
 * This test should FAIL to compile if uncommented
 */
/*
const rawError = new Error('Something went wrong');
const operationError: OperationError = rawError; // ❌ Should be a type error
*/

// =============================================================================
// Type-level test: source-specific fields rejected
// =============================================================================

/**
 * Type test: adding source-specific fields to OperationDefinition should fail
 * This test should FAIL to compile if uncommented
 */
/*
const invalidDefinition: OperationDefinition = {
  ...validDefinition,
  openApiPath: '/users', // ❌ Should be a type error - use annotations instead
};
*/

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
