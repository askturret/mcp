// SPDX-License-Identifier: Apache-2.0
/**
 * Building an `AuditEvent` from a dispatch (§9.3).
 */

import { auditEventId, digestInput, principalRef } from './digest.js';
import type { AuditEvent, AuditEventInput } from './types.js';

/**
 * Assemble the record.
 *
 * The ONLY place an `AuditEvent` is constructed from live dispatch state, so
 * it is the one place the never-include rules have to hold: raw input becomes
 * a digest here, the principal becomes a pseudonymous reference here, and
 * output is never taken as a parameter at all.
 *
 * Centralising that is deliberate. Scattered construction would mean each new
 * call site re-deciding what is safe to include, and the answer only has to
 * be got wrong once for the log to carry something it must not.
 */
export function buildAuditEvent(
  input: AuditEventInput,
  now: Date = new Date(),
): AuditEvent {
  const digest = digestInput(input.input);

  return {
    eventId: auditEventId(now.getTime()),
    timestamp: now.toISOString(),
    requestId: input.requestId,
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    ...(input.principalId === undefined
      ? {}
      : { principalRef: principalRef(input.principalId) }),
    operationId: input.operationId,
    registryHash: input.registryHash,
    policyDecision: input.policyDecision,
    ...(digest === undefined ? {} : { inputDigest: digest }),
    outcome: input.outcome,
    durationMs: input.durationMs,
    ...(input.policyEvidence === undefined ? {} : { policyEvidence: input.policyEvidence }),
  };
}
