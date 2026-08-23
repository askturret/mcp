// SPDX-License-Identifier: Apache-2.0
/**
 * Input digests and principal references (§9.3 never-include list).
 */

import { createHash, randomUUID } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted, arrays left in order.
 *
 * Key order is the whole problem. `JSON.stringify` preserves INSERTION order,
 * so `{a:1,b:2}` and `{b:2,a:1}` serialize differently and would digest
 * differently — two records of the same call that no longer correlate. Since
 * insertion order follows however the input was parsed or built, that is not
 * a hypothetical.
 *
 * Array order is preserved deliberately: `[1,2]` and `[2,1]` are different
 * inputs, and sorting them would make two genuinely different calls look
 * identical, which is worse than the problem being solved.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    // `undefined` is dropped by JSON.stringify at the top level, yielding the
    // literal string "undefined" from this function's caller. Normalising it
    // to null keeps the digest a well-formed JSON hash in every case.
    return value === undefined ? null : value;
  }

  if (Array.isArray(value)) return value.map(canonicalValue);

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // Sorted with the default comparator: consistent across runs and platforms,
  // which is what "same input -> same digest across runs" requires.
  for (const key of Object.keys(source).sort()) {
    out[key] = canonicalValue(source[key]);
  }
  return out;
}

/**
 * SHA-256 of the canonicalized input, hex-encoded.
 *
 * Returns `undefined` for absent input rather than the digest of "null", so
 * "there was no input" stays distinguishable from "the input was null".
 */
export function digestInput(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  return createHash('sha256').update(canonicalize(input), 'utf8').digest('hex');
}

/**
 * A safe reference to a principal.
 *
 * Truncated to 128 bits of the SHA-256. Full-length would be no safer — the
 * point is that the raw identifier never appears, and 32 hex characters is
 * ample to correlate records without inviting anyone to treat the value as an
 * identifier they can look up.
 *
 * NOT salted, deliberately: an audit log has to let two records of the same
 * principal be correlated, and a per-process salt would break exactly that
 * across restarts and instances. This is a pseudonym, not a secret — stated
 * plainly so nobody mistakes it for one.
 */
export function principalRef(principalId: string): string {
  return createHash('sha256').update(principalId, 'utf8').digest('hex').slice(0, 32);
}

/**
 * A time-ordered event id.
 *
 * §48 asks for ULID or UUIDv7. Node's `randomUUID` is v4 — not time-ordered —
 * so this prefixes a millisecond timestamp in hex, giving records that sort
 * by creation time under a plain lexicographic sort, which is what the
 * ordering requirement is actually for. Flagged for QA rather than pulling in
 * a ULID dependency for a format nothing downstream parses. See #156.
 */
export function auditEventId(now: number = Date.now()): string {
  return `${now.toString(16).padStart(12, '0')}-${randomUUID()}`;
}
