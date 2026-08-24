// SPDX-License-Identifier: Apache-2.0
/**
 * A reference `RegistryPeerStore` (#64).
 *
 * In-process, so it is only useful for TESTS and for a single-instance
 * deployment where divergence is impossible by construction. Shipped because
 * the interface is the deliverable, and an interface with no implementation is
 * a shape nobody has checked against reality.
 *
 * A real deployment supplies Redis, a shared file, or a ConfigMap. `put` and
 * `list` are the whole contract — see `RegistryPeerStore`.
 */

import type { PeerEntry, RegistryPeerStore } from './types.js';

export function createMemoryPeerStore(): RegistryPeerStore & { clear(): void } {
  const entries = new Map<string, PeerEntry>();

  return {
    put(entry: PeerEntry): Promise<void> {
      // Keyed by scope AND instance, so the same instanceId in two scopes is
      // two entries rather than one silently overwriting the other.
      entries.set(`${entry.scope} ${entry.instanceId}`, entry);
      return Promise.resolve();
    },
    list(scope: string): Promise<readonly PeerEntry[]> {
      return Promise.resolve([...entries.values()].filter((entry) => entry.scope === scope));
    },
    clear(): void {
      entries.clear();
    },
  };
}
