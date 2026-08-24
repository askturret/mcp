// SPDX-License-Identifier: Apache-2.0
/**
 * Option B — the internal divergence check (#64, §11.2).
 *
 * Opt-in. It announces this instance's `(instanceId, registryHash)` to an
 * operator-provided store, reads back the set, and caches a verdict that
 * `/health/ready` consults.
 *
 * ## The grace period is not a nicety — without it this breaks every deploy
 *
 * A rolling update legitimately runs two hashes at once. An instance that
 * flipped to 503 the moment it saw a foreign hash would take the OLD pods out
 * of rotation as soon as the first new pod appeared, and the new pods out as
 * long as any old one remained. Every instance unready, mid-deploy, on a
 * correct configuration — a detector that causes the outage it was installed
 * to prevent.
 *
 * So divergence must PERSIST past `graceMs` before it reaches readiness. The
 * default matches Option A's alert debounce, deliberately: two mechanisms
 * disagreeing about how long a rollout may take would mean the dashboard says
 * one thing and the load balancer does another.
 *
 * ## What Option B costs, stated because it is the reason A is the default
 *
 * Sustained divergence flips **every** instance to 503, so the deployment
 * leaves rotation entirely. That is the intended behaviour for an adopter who
 * considers an inconsistent tool surface worse than being down — a regulated
 * deployment where a `tools/call` decision must match the `tools/list` that
 * advertised it. For everyone else it is the wrong trade, which is why §64
 * makes Option A the default: an alert costs a human's attention, this costs
 * availability.
 *
 * ## A stale entry must not diverge forever
 *
 * A pod that dies leaves its entry behind. Without expiry the deployment would
 * be permanently "diverged" against a ghost, and the first rolling update would
 * wedge readiness for good. Entries older than `staleAfterMs` are ignored, and
 * the default is a multiple of the refresh interval so a briefly slow instance
 * is not mistaken for a dead one.
 */

import type {
  DivergenceState,
  DivergenceStatus,
  PeerEntry,
  RegistryPeerStore,
} from './types.js';

export interface DivergenceMonitorOptions {
  readonly store: RegistryPeerStore;
  readonly instanceId: string;
  /** Deployment scope; divergence is only compared within one. */
  readonly scope: string;
  /** Reads the CURRENT hash each refresh, so a reload is picked up. */
  readonly currentHash: () => string;
  /** How often to announce and re-read. Default 15s. */
  readonly refreshMs?: number;
  /**
   * How long divergence must persist before readiness is affected.
   * Default 5 minutes, matching Option A's alert `for:`.
   */
  readonly graceMs?: number;
  /** Entries older than this are ignored. Default `4 × refreshMs`. */
  readonly staleAfterMs?: number;
  /** Injected for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface DivergenceMonitor {
  /** Announce and re-read once. Safe to call directly; the timer calls it. */
  refresh(): Promise<DivergenceState>;
  /** The cached verdict. Synchronous — readiness must never await. */
  state(): DivergenceState;
  /** Begin periodic refresh. Idempotent. */
  start(): void;
  /** Stop refreshing. Idempotent. */
  stop(): void;
}

const DEFAULT_REFRESH_MS = 15_000;
const DEFAULT_GRACE_MS = 300_000; // 5 min — Option A's debounce.

export function createDivergenceMonitor(options: DivergenceMonitorOptions): DivergenceMonitor {
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const staleAfterMs = options.staleAfterMs ?? refreshMs * 4;
  const now = options.now ?? (() => Date.now());

  /** When the CURRENT run of divergence began. Null while agreeing. */
  let divergingSince: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  let cached: DivergenceState = {
    // Before the first refresh nothing is known. `unknown` rather than `ok`,
    // so a monitor that never ran cannot be mistaken for one that checked.
    status: 'unknown',
    registryHash: options.currentHash(),
    hashesInScope: [],
    detail: 'No divergence check has completed yet.',
  };

  function conclude(
    status: DivergenceStatus,
    registryHash: string,
    hashesInScope: readonly string[],
    detail: string,
    divergedForMs?: number,
  ): DivergenceState {
    cached = {
      status,
      registryHash,
      hashesInScope,
      ...(divergedForMs === undefined ? {} : { divergedForMs }),
      detail,
    };
    return cached;
  }

  async function refresh(): Promise<DivergenceState> {
    const registryHash = options.currentHash();
    const timestamp = now();

    const entry: PeerEntry = {
      instanceId: options.instanceId,
      registryHash,
      scope: options.scope,
      updatedAt: timestamp,
    };

    let peers: readonly PeerEntry[];
    try {
      await options.store.put(entry);
      peers = await options.store.list(options.scope);
    } catch (error) {
      // A store outage is NOT divergence. Reporting `diverged` here would take
      // a correctly-configured deployment out of rotation because Redis
      // blinked — the monitor's dependency failing must not become the
      // application's failure.
      //
      // The divergence clock is deliberately NOT reset: a store that fails
      // during a genuine divergence must not restart the grace period on every
      // failed read, which would postpone the alert indefinitely.
      return conclude(
        'unknown',
        registryHash,
        [],
        `Peer store unreachable: ${error instanceof Error ? error.message : String(error)}. ` +
          `Divergence is unknown, not absent.`,
      );
    }

    const fresh = peers.filter(
      (peer) => peer.scope === options.scope && timestamp - peer.updatedAt <= staleAfterMs,
    );

    // Our own entry counts even if the store has not made it visible yet —
    // a read-after-write that has not propagated must not look like agreement
    // among peers that excludes us.
    const hashes = [...new Set([registryHash, ...fresh.map((peer) => peer.registryHash)])].sort();

    if (hashes.length <= 1) {
      divergingSince = null;
      return conclude('ok', registryHash, hashes, `All ${String(fresh.length)} instance(s) in scope '${options.scope}' agree.`);
    }

    divergingSince ??= timestamp;
    const divergedForMs = timestamp - divergingSince;

    if (divergedForMs < graceMs) {
      // Inside the window. Reported as `ok` for READINESS purposes — this is
      // what a rolling update looks like, and it is expected. The detail still
      // names it so an operator reading the health body during a deploy sees
      // the truth rather than an unexplained silence.
      return conclude(
        'ok',
        registryHash,
        hashes,
        `${String(hashes.length)} registry hashes in scope '${options.scope}', for ` +
          `${String(Math.round(divergedForMs / 1000))}s — within the ${String(Math.round(graceMs / 1000))}s ` +
          `rollout grace period. Expected during a rolling update.`,
        divergedForMs,
      );
    }

    return conclude(
      'diverged',
      registryHash,
      hashes,
      `${String(hashes.length)} registry hashes have persisted in scope '${options.scope}' for ` +
        `${String(Math.round(divergedForMs / 1000))}s, beyond the ${String(Math.round(graceMs / 1000))}s ` +
        `rollout grace period: ${hashes.join(', ')}. Instances are serving different tool ` +
        `surfaces — check that every instance received the same spec and overlays.`,
      divergedForMs,
    );
  }

  return {
    refresh,
    state: () => cached,
    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => {
        // Failures are already folded into the verdict by `refresh`; this catch
        // only stops an unhandled rejection from the timer.
        void refresh().catch(() => undefined);
      }, refreshMs);
      // Never hold the process open for a monitor. An instance that is
      // otherwise finished must not linger because a health check is due.
      timer.unref?.();
    },
    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
