// SPDX-License-Identifier: Apache-2.0
/**
 * Registry-hash divergence across a horizontal deployment (#64, §11.2).
 *
 * §11.2: *"All instances compile the same configuration and expose the same
 * registry hash. Readiness should fail or alert if hashes diverge unexpectedly
 * across a deployment."*
 *
 * The failure it guards against is not a crash. Two pods serving two snapshots
 * answer `tools/list` differently, so an agent is told a tool exists by one
 * instance and refused by another — intermittently, by load-balancer luck. That
 * is far harder to diagnose than an outage, which is why it needs a detector at
 * all.
 */

/** One instance's declaration of what it is serving. */
export interface PeerEntry {
  /** Stable per-instance identity — a pod name, a hostname, a UUID. */
  readonly instanceId: string;
  /** The registry hash this instance is serving. */
  readonly registryHash: string;
  /**
   * Which deployment this instance belongs to.
   *
   * Divergence is only meaningful WITHIN a scope. Two deployments of different
   * configurations sharing one Redis are not diverged — they are two
   * deployments, and comparing them would fire an alert on a correct setup.
   */
  readonly scope: string;
  /** When this entry was written, as epoch milliseconds. */
  readonly updatedAt: number;
}

/**
 * The operator-provided store.
 *
 * §64: *"the runtime only knows how to write/read a simple key"*. Two methods,
 * no transactions, no watch, no locking — a shared file, a Redis hash and a
 * ConfigMap can all implement this in a few lines, and nothing here constrains
 * which.
 *
 * Both may reject. A store that is down must not take the instance down with
 * it: see `DivergenceMonitor` for why a failed read reports `unknown` rather
 * than `diverged`.
 */
export interface RegistryPeerStore {
  /** Record (or refresh) this instance's entry. */
  put(entry: PeerEntry): Promise<void>;
  /** Every entry the store holds for this scope, including our own. */
  list(scope: string): Promise<readonly PeerEntry[]>;
}

/**
 * What the monitor last concluded.
 *
 * Three states, not two. `unknown` is the one that matters: it is what a store
 * outage produces, and collapsing it into either `ok` or `diverged` is a
 * choice between hiding a real divergence and inventing one. Readiness treats
 * it as ready — see `evaluateReadiness` — because an instance serving correct
 * traffic must not be pulled from rotation by its *monitor's* dependency
 * failing.
 */
export type DivergenceStatus = 'ok' | 'diverged' | 'unknown';

export interface DivergenceState {
  readonly status: DivergenceStatus;
  /** This instance's own hash, for the readiness body and for diagnostics. */
  readonly registryHash: string;
  /** Distinct hashes seen in scope, ours included. One means agreement. */
  readonly hashesInScope: readonly string[];
  /**
   * How long divergence has persisted, in milliseconds. `undefined` unless
   * status is `diverged` or divergence is being observed inside the grace
   * window.
   */
  readonly divergedForMs?: number;
  /** Human-readable, safe to put in a health body. Never a credential. */
  readonly detail?: string;
}
