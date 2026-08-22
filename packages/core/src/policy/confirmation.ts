// SPDX-License-Identifier: Apache-2.0
/**
 * Confirmation challenges that cannot be replayed.
 *
 * #33 shipped `ConfirmationChallenge` with a DERIVED id and said so plainly:
 * it "is NOT a nonce ... it carries no unpredictability and no expiry, so it
 * cannot by itself stop a `ConfirmationProof` from one call being replayed
 * against another." That was the correct boundary to draw at the time. This is
 * the piece that was deferred.
 *
 * A confirmation is only worth anything if it answers three questions, and a
 * derived id answers none of them:
 *
 *   1. Did WE issue this? — unguessable nonce, not a value derivable from the
 *      operation id, which any caller can compute for themselves.
 *   2. Is it still fresh? — explicit expiry.
 *   3. Has it already been used? — single-use consumption.
 *
 * Plus a fourth that is easy to miss: is it being redeemed for the SAME thing
 * it was issued for? A proof for a £5 transfer must not authorise a £5,000 one,
 * and a proof issued to one caller must not work for another.
 */

import { randomUUID } from 'crypto';
import type { ConfirmationProof } from '../types.js';
import type { ConfirmationChallenge } from './types.js';

/** Default lifetime of an issued challenge. */
export const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60_000;

/** Default cap on outstanding challenges. */
export const DEFAULT_MAX_OUTSTANDING_CONFIRMATIONS = 10_000;

/**
 * What a challenge is bound to.
 *
 * A proof is only redeemable against the exact tuple its challenge was issued
 * for. Every field here is re-derived server-side at redemption time; none of
 * it is read back from the proof, because a value the client supplies cannot
 * attest to itself.
 */
export interface ConfirmationBinding {
  /** Hash of the authenticated caller — never a raw identifier. */
  readonly callerHash: string;
  readonly operationId: string;
  readonly registryHash: string;
  /** Hash of the exact input being confirmed. */
  readonly inputHash: string;
}

export type ConfirmationRejection =
  | 'unknown'
  | 'expired'
  | 'already_used'
  | 'wrong_caller'
  | 'wrong_operation'
  | 'wrong_input'
  | 'wrong_registry';

export type ConfirmationOutcome =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: ConfirmationRejection };

export interface ConfirmationRegistryOptions {
  /** Challenge lifetime in ms. Defaults to 5 minutes. */
  readonly ttlMs?: number;
  /** Cap on outstanding challenges. Defaults to 10,000. */
  readonly maxOutstanding?: number;
  /** Injectable clock, so expiry is testable without sleeping. */
  readonly now?: () => number;
  /** Injectable nonce source, so tests are deterministic. Defaults to randomUUID. */
  readonly nonce?: () => string;
}

export interface ConfirmationRegistry {
  /** Issue a challenge bound to this caller, operation, registry and input. */
  issue(challenge: ConfirmationChallenge, binding: ConfirmationBinding): ConfirmationChallenge;

  /**
   * Redeem a proof. Accepting CONSUMES the challenge — a second redemption of
   * the same proof is rejected as `already_used`.
   *
   * ## Known property: eviction is indistinguishable from forgery
   *
   * A forged id, a consumed one, and one evicted under `maxOutstanding`
   * pressure all return `unknown`. For the first two that is deliberate — an
   * attacker probing ids learns nothing from the difference.
   *
   * For the third it is a real, if narrow, availability cost: a caller who
   * floods the registry can evict an honest user's outstanding challenge, and
   * that user is then told `unknown` for a challenge they legitimately hold.
   * They can retry and get a fresh one, so nothing is lost but a round trip.
   *
   * Fixing it properly means per-caller quotas rather than a global bound,
   * which is bulkhead work (#43) and does not belong here. Documented rather
   * than half-solved: the bound is what stops unbounded memory growth, and
   * removing it to avoid this would trade a small availability cost for a
   * memory-exhaustion primitive.
   */
  redeem(proof: ConfirmationProof, binding: ConfirmationBinding): ConfirmationOutcome;

  /** Outstanding challenge count. For tests and diagnostics. */
  readonly outstanding: number;
}

interface Issued {
  readonly binding: ConfirmationBinding;
  readonly expiresAt: number;
}

export function createConfirmationRegistry(
  options?: ConfirmationRegistryOptions,
): ConfirmationRegistry {
  const ttlMs = options?.ttlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
  const maxOutstanding = options?.maxOutstanding ?? DEFAULT_MAX_OUTSTANDING_CONFIRMATIONS;
  const now = options?.now ?? Date.now;
  const nextNonce = options?.nonce ?? randomUUID;

  const issued = new Map<string, Issued>();

  function evictIfFull(): void {
    // Bounded so an unauthenticated caller cannot mint challenges forever.
    // Oldest-first: Map preserves insertion order and every entry has the same
    // TTL, so the first key is also the soonest to expire.
    if (issued.size < maxOutstanding) return;
    const oldest = issued.keys().next();
    if (!oldest.done) issued.delete(oldest.value);
  }

  return {
    get outstanding() {
      return issued.size;
    },

    issue(challenge: ConfirmationChallenge, binding: ConfirmationBinding): ConfirmationChallenge {
      evictIfFull();

      // The nonce REPLACES the derived id rather than being appended to it. A
      // challenge whose id is partly derivable is partly guessable, and there
      // is no benefit in the caller being able to predict any of it.
      const id = nextNonce();
      issued.set(id, { binding, expiresAt: now() + ttlMs });

      return { ...challenge, id };
    },

    redeem(proof: ConfirmationProof, binding: ConfirmationBinding): ConfirmationOutcome {
      const challengeId = typeof proof?.challengeId === 'string' ? proof.challengeId : '';
      const record = issued.get(challengeId);

      // Covers a forged id, an already-consumed one, and one evicted under
      // pressure. All three are indistinguishable to the caller by design.
      if (record === undefined) return { accepted: false, reason: 'unknown' };

      if (record.expiresAt <= now()) {
        issued.delete(challengeId);
        return { accepted: false, reason: 'expired' };
      }

      // Binding is compared field by field so the rejection says WHICH
      // invariant failed — an operator reading an audit entry needs to tell
      // "wrong caller" (someone else's proof) from "wrong input" (the amount
      // changed after confirmation) from ordinary expiry.
      if (record.binding.callerHash !== binding.callerHash) {
        return { accepted: false, reason: 'wrong_caller' };
      }
      if (record.binding.operationId !== binding.operationId) {
        return { accepted: false, reason: 'wrong_operation' };
      }
      if (record.binding.registryHash !== binding.registryHash) {
        return { accepted: false, reason: 'wrong_registry' };
      }
      if (record.binding.inputHash !== binding.inputHash) {
        return { accepted: false, reason: 'wrong_input' };
      }

      // Consume. This is the single-use property, and it must happen on the
      // ACCEPT path only: deleting on a mismatch would let anyone burn another
      // caller's outstanding challenge by presenting it against the wrong
      // binding.
      issued.delete(challengeId);
      return { accepted: true };
    },
  };
}
