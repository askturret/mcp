// SPDX-License-Identifier: Apache-2.0
/**
 * Audit sink with mandatory-delivery semantics (§9.3, §8.6, ADR-014).
 *
 * ## Why this is not the telemetry channel
 *
 * Telemetry is allowed to drop. Under overload an exporter sheds samples and
 * nobody is harmed — a metric is a summary, and a summary with a gap is still
 * useful. An audit record is a claim about what happened to somebody's data,
 * and a gap in it is indistinguishable from the event never occurring.
 *
 * Reusing the telemetry path would therefore silently discard exactly the
 * records that matter most, at exactly the moment they matter most: under the
 * load that caused the incident being investigated. Hence a separate
 * abstraction with a separate delivery contract.
 */

import type { PolicyEvidence } from '../policy/types.js';

/**
 * `AuditEvent.registryHash` when the server never observed one (#218).
 *
 * Dispatch assigns a snapshot hash only after stage 1 resolves the operation,
 * so a call naming an operation that does not exist returns before there is
 * one. The record still needs a value — `registryHash` is required, and
 * removing it would be breaking under compatibility-policy §1 — so it gets this
 * server-authored sentinel.
 *
 * It says WHY there is no hash rather than merely that there is none:
 * resolution never happened. Exported so a log consumer can compare against a
 * constant instead of a string literal it has to keep in step by hand.
 */
export const AUDIT_REGISTRY_HASH_UNRESOLVED = 'unresolved';

/**
 * One audit record.
 *
 * ## The absences here are the design
 *
 * There is no `input`, no `output`, and no principal identifier. §9.3 puts all
 * three on the never-include list, and the way to keep them out of an audit
 * log is for the type to have nowhere to put them — a field that exists is a
 * field someone eventually fills in.
 *
 * `inputDigest` and `principalRef` are the sanctioned stand-ins: enough to
 * correlate two records or prove two calls carried the same input, without
 * carrying the value itself.
 */
export interface AuditEvent {
  /** Unique per event. UUIDv7-shaped so records sort by creation time. */
  readonly eventId: string;

  /** ISO-8601 with milliseconds. */
  readonly timestamp: string;

  readonly requestId: string;
  readonly traceId?: string;

  /**
   * A SAFE reference to the principal — a hash, never the raw identifier.
   *
   * Absent for unauthenticated calls, which is a different fact from "the
   * principal was empty" and is preserved as such.
   */
  readonly principalRef?: string;

  readonly operationId: string;

  /**
   * The snapshot digest the SERVER observed serving this call.
   *
   * Server-authored on every path (#218). When dispatch failed before stage 1
   * captured a hash — which every call naming an unknown operation does — this
   * is `AUDIT_REGISTRY_HASH_UNRESOLVED`, never the caller's claim. Redaction
   * exempts this field as non-sensitive by construction, and that exemption is
   * only sound while nothing caller-controlled can reach it.
   */
  readonly registryHash: string;

  /** 'allow' | 'deny' | 'confirmation_required'. */
  readonly policyDecision: string;

  /** SHA-256 of the CANONICALIZED input. Never the input. */
  readonly inputDigest?: string;

  /** An `OperationErrorCode`, or 'success'. */
  readonly outcome: string;

  readonly durationMs: number;

  readonly policyEvidence?: readonly PolicyEvidence[];
}

/**
 * Where audit records go.
 *
 * Implementable by plugin authors — this is the extension point §48 asks for.
 */
export interface AuditSink {
  /** Stable identifier, used as the `sink` metric label. Keep it bounded. */
  readonly id: string;

  /**
   * Record one event.
   *
   * A sink that buffers may resolve before the write is durable; `flush` is
   * what makes durability observable.
   */
  append(event: AuditEvent): Promise<void>;

  /** Resolve only once every event appended before this call is durable. */
  flush(): Promise<void>;

  /** Release resources. Optional — not every sink holds any. */
  close?(): Promise<void>;
}

/**
 * What happens when the buffer is full.
 *
 * `block` is the DEFAULT and the reason this module exists. Back-pressure
 * propagates into dispatch, so the server slows down instead of quietly
 * losing records — a slow server is a visible, diagnosable problem, whereas a
 * silently incomplete audit log is discovered months later by an auditor.
 *
 * `drop` is available for adopters who genuinely prefer availability over
 * completeness, but it is never silent: `mcp_audit_dropped_total` is emitted
 * on every drop and cannot be turned off. A non-zero value on that counter
 * means the deployment is configured to violate the audit guarantee, which is
 * a thing an operator must be able to alert on.
 */
export type OverflowPolicy = 'block' | 'drop';

export interface BufferedSinkOptions {
  /** Maximum events held in memory. Default 1000. */
  readonly maxBufferSize?: number;

  /** Default `block`. */
  readonly overflow?: OverflowPolicy;
}

/** Everything needed to turn a dispatch into an `AuditEvent`. */
export interface AuditEventInput {
  readonly requestId: string;
  readonly traceId?: string;
  readonly principalId?: string;
  readonly operationId: string;
  readonly registryHash: string;
  readonly policyDecision: string;
  readonly input?: unknown;
  readonly outcome: string;
  readonly durationMs: number;
  readonly policyEvidence?: readonly PolicyEvidence[];
}
