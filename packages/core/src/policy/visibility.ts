// SPDX-License-Identifier: Apache-2.0
/**
 * Discovery-time visibility — filtering a registry snapshot through a policy
 * before an agent ever sees it.
 *
 * **This is not the security boundary.** §5.5 is explicit that call-time
 * authorization is. Hiding an operation shrinks the surface an agent reasons
 * about; it does not stop anyone who already knows the name from invoking it.
 * Every operation filtered out here must still be denied at call time by the
 * same policy — which is why both phases share one `Policy` interface rather
 * than having a list-only variant that could drift out of agreement with it.
 */

// Bare specifier, matching compiler/passes/freeze-and-hash.ts — the only other
// node-builtin import in this package.
import { createHash } from 'crypto';
import type { OperationDefinition, OperationId, Principal, RegistrySnapshot } from '../types.js';
import type { ClientInfo, Policy, PolicyContext, PolicyDecision, PolicyPhase } from './types.js';

/**
 * Sink for decision counts.
 *
 * Deliberately narrow: a phase and an effect, and nothing else. §9.2 forbids
 * principal-identifying labels on metrics, and the cheapest way to honour that
 * is an interface with nowhere to put one — a rule enforced by the type system
 * costs nothing to remember.
 *
 * The default implementation does nothing. Real metric export arrives with
 * observability (#39); this exists so the call sites are correct now and #39
 * is a wiring change rather than a hunt for where counting should happen.
 */
export interface PolicyMetrics {
  recordDecision(phase: PolicyPhase, effect: PolicyDecision['effect']): void;
}

const NOOP_METRICS: PolicyMetrics = { recordDecision: () => undefined };

/** Default visibility cache lifetime. */
export const DEFAULT_VISIBILITY_TTL_MS = 30_000;

/** Default cap on distinct cached identities. */
export const DEFAULT_VISIBILITY_CACHE_MAX_ENTRIES = 1_000;

export interface VisibilityEngineOptions {
  readonly policy: Policy;

  /**
   * Fingerprint of the policy's CONFIGURATION, not just its shape.
   *
   * Defaults to `policy.id`, which captures the structure of a composed tree
   * (`allOf(authenticated, permissionPolicy)`) but **not** the data inside it.
   * Swap the permission map inside a `permissionPolicy` without changing its
   * id and cached decisions stay valid for up to the TTL, because nothing the
   * cache can see has changed.
   *
   * Pass an explicit version whenever policy configuration is reloadable. That
   * is the entire reason this field exists.
   */
  readonly policyVersion?: string;

  /** Cache lifetime in ms. Defaults to 30s. `0` disables caching entirely. */
  readonly ttlMs?: number;

  /**
   * Maximum distinct identities held in the cache.
   *
   * The issue calls for a bounded cache KEY; this bounds the cache SIZE, which
   * is a different thing and also necessary. One entry per principal is
   * unbounded growth in the number of callers, and an attacker who can present
   * many identities would otherwise have a memory-exhaustion primitive.
   */
  readonly maxEntries?: number;

  readonly metrics?: PolicyMetrics;

  /** Injectable clock. Exists so TTL behaviour is testable without sleeping. */
  readonly now?: () => number;
}

export interface VisibleOperationsRequest {
  readonly snapshot: RegistrySnapshot;
  readonly principal?: Principal;
  readonly clientInfo?: ClientInfo;
}

export interface VisibilityEngine {
  /**
   * The operations this principal may see, in snapshot order.
   *
   * `deny` hides an operation. `allow` shows it. **`confirmation_required`
   * shows it too** — the agent is meant to see that the tool exists and learn
   * at call time that using it needs confirmation. Hiding it would make a
   * confirmable operation indistinguishable from a forbidden one.
   */
  visibleOperations(request: VisibleOperationsRequest): Promise<readonly OperationDefinition[]>;

  /** Evaluations actually performed. Cache hits do not count. For tests and diagnostics. */
  readonly evaluationCount: number;
}

interface CacheEntry {
  readonly visibleIds: ReadonlySet<OperationId>;
  readonly expiresAt: number;
}

/**
 * A stable, non-reversible fingerprint of WHO is asking.
 *
 * ## The rule this encodes
 *
 * **Every part of `PolicyContext` a policy can branch on, and that varies
 * between callers, must be in the cache key.** For discovery those are exactly
 * `principal` and `clientInfo` — `operation` is evaluated per-operation,
 * `registryHash` is a separate key component, `phase` is constant, and `input`
 * does not exist yet. Anything varying and absent from the key means two
 * different callers share one entry.
 *
 * §9.1 forbids raw identifiers as cache keys, so nothing here appears in
 * plaintext; the whole tuple is hashed. `type` is included because a user and a
 * service account can legitimately share an id string.
 *
 * ## Why clientInfo is here (QA on PR #118)
 *
 * It was not, originally, and that was a cross-client cache-poisoning bug
 * rather than a missed optimisation. `principal` is always `undefined` at
 * discovery in v0.1, so this function returned the constant `'anon'` for every
 * caller — one shared cache entry for the whole transport. A policy branching
 * on `clientInfo.name` would serve an untrusted client the trusted client's
 * full tool list, or vice versa, for up to the TTL.
 *
 * The failure is worth naming precisely: forwarding `clientInfo` into
 * `PolicyContext` and not adding it to the key made the cache *wrong*, where
 * before it had merely been *coarse*. Plumbing a new input into a cached
 * computation is exactly when its key has to grow.
 *
 * ## Why adding components is always safe here
 *
 * A finer key can only ever cause a miss, never a wrong hit. That is why
 * permissions are mixed in too, which the issue's three-part key did not ask
 * for: without them, revoking a permission leaves visibility cached until the
 * TTL expires, because the identity did not change.
 *
 * `clientInfo` is client-supplied and therefore attacker-controlled, so a
 * caller can vary it to force misses and grow the cache. That is bounded by
 * `maxEntries`, which now does double duty.
 */
export function callerHash(
  principal: Principal | undefined,
  clientInfo: ClientInfo | undefined,
): string {
  const principalPart =
    principal === undefined
      ? null
      : [principal.type, principal.id, [...(principal.permissions ?? [])].sort()];

  const clientPart =
    clientInfo === undefined ? null : [clientInfo.name ?? null, clientInfo.version ?? null];

  // Hashed even when both parts are null, so the key format never varies by
  // caller shape and no branch can accidentally emit something readable.
  const canonical = JSON.stringify([principalPart, clientPart]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function createVisibilityEngine(options: VisibilityEngineOptions): VisibilityEngine {
  const { policy } = options;
  const policyVersion = options.policyVersion ?? policy.id;
  const ttlMs = options.ttlMs ?? DEFAULT_VISIBILITY_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_VISIBILITY_CACHE_MAX_ENTRIES;
  const metrics = options.metrics ?? NOOP_METRICS;
  const now = options.now ?? Date.now;

  const cache = new Map<string, CacheEntry>();
  let evaluations = 0;

  /**
   * Decide one operation, failing closed.
   *
   * A policy that throws has not made a decision, and an operation whose
   * visibility could not be determined is hidden. The combinators already fail
   * closed internally, but a BARE policy passed straight to this engine has no
   * combinator above it — the same one-layer gap that #33's QA round found at
   * the root of a combinator tree.
   */
  async function isVisible(
    operation: OperationDefinition,
    request: VisibleOperationsRequest,
  ): Promise<boolean> {
    const context: PolicyContext = {
      operation,
      registryHash: request.snapshot.hash,
      phase: 'discovery',
      ...(request.principal === undefined ? {} : { principal: request.principal }),
      ...(request.clientInfo === undefined ? {} : { clientInfo: request.clientInfo }),
      // `input` is deliberately absent: there is no call yet at discovery time.
    };

    let decision: PolicyDecision;
    try {
      decision = await policy.evaluate(context);
    } catch {
      metrics.recordDecision('discovery', 'deny');
      return false;
    }

    const effect = decision?.effect;
    if (effect !== 'allow' && effect !== 'deny' && effect !== 'confirmation_required') {
      // An unrecognised answer is not an allowance.
      metrics.recordDecision('discovery', 'deny');
      return false;
    }

    metrics.recordDecision('discovery', effect);
    return effect !== 'deny';
  }

  function readCache(key: string): ReadonlySet<OperationId> | undefined {
    if (ttlMs <= 0) return undefined;
    const entry = cache.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now()) {
      cache.delete(key);
      return undefined;
    }
    return entry.visibleIds;
  }

  function writeCache(key: string, visibleIds: ReadonlySet<OperationId>): void {
    if (ttlMs <= 0) return;

    // Evict the oldest insertion when full. Map preserves insertion order, so
    // the first key is the oldest. Not an LRU — a plain bound, which is what
    // is needed to stop unbounded growth.
    if (cache.size >= maxEntries && !cache.has(key)) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }

    cache.set(key, { visibleIds, expiresAt: now() + ttlMs });
  }

  return {
    get evaluationCount() {
      return evaluations;
    },

    async visibleOperations(
      request: VisibleOperationsRequest,
    ): Promise<readonly OperationDefinition[]> {
      const operations = [...request.snapshot.operations.values()];

      // The registry hash is part of the key, so a snapshot swap produces a
      // different key and the previous entry is simply never consulted again.
      const key = JSON.stringify([
        callerHash(request.principal, request.clientInfo),
        request.snapshot.hash,
        policyVersion,
      ]);

      const cached = readCache(key);
      if (cached !== undefined) {
        return operations.filter((op) => cached.has(op.id));
      }

      // Evaluated concurrently; `Promise.all` preserves index order, so the
      // returned list follows snapshot order regardless of completion order.
      const verdicts = await Promise.all(operations.map((op) => isVisible(op, request)));
      evaluations += operations.length;

      const visible = operations.filter((_, i) => verdicts[i] === true);
      writeCache(key, new Set(visible.map((op) => op.id)));

      return visible;
    },
  };
}
