// SPDX-License-Identifier: Apache-2.0
/**
 * Atomic registry reference - single source of truth for current snapshot.
 *
 * ADR-004: No mutable global registry.
 * Every in-flight call retains the exact snapshot it started with,
 * even if reload happens mid-execution. This makes tools/list and tools/call
 * coherent during reload and reproducible for audit.
 *
 * Atomicity guarantee (Issue #12):
 * - swap() is observable-instant: any subsequent current() returns new snapshot
 * - In-flight calls keep their original snapshot (dispatcher captures at entry)
 * - JavaScript single-threaded execution gives us atomic reference swap for free
 *
 * Usage:
 * ```ts
 * const ref = new AtomicRegistryReference(initialSnapshot);
 * const snapshot = ref.current();  // Get current snapshot
 * ref.swap(nextSnapshot);          // Atomic replace
 * ```
 */

import type { RegistrySnapshot } from './types.js';

/**
 * Atomic registry reference interface.
 *
 * Provides observable-instant snapshot replacement with no locking required
 * (JavaScript single-threaded execution model).
 */
export interface RegistryReference {
  /**
   * Get the currently-published snapshot.
   *
   * Returns the snapshot that was most recently swapped in.
   * Multiple calls may return different snapshots if swap() is called between them.
   */
  current(): RegistrySnapshot;

  /**
   * Atomically replace the current snapshot.
   *
   * After this returns, all subsequent current() calls return the new snapshot.
   * In-flight operations that already captured the old snapshot are unaffected.
   *
   * @param next - New snapshot to publish
   */
  swap(next: RegistrySnapshot): void;
}

/**
 * Default implementation of atomic registry reference.
 *
 * Thread-safe in JavaScript's single-threaded execution model.
 * No locking required - assignment is atomic.
 */
export class AtomicRegistryReference implements RegistryReference {
  private snapshot: RegistrySnapshot;

  /**
   * Create a new registry reference.
   *
   * @param initial - Initial snapshot
   */
  constructor(initial: RegistrySnapshot) {
    this.snapshot = initial;
  }

  /**
   * Get the current snapshot.
   */
  current(): RegistrySnapshot {
    return this.snapshot;
  }

  /**
   * Atomically swap to a new snapshot.
   *
   * Observable-instant: any code that runs after this method returns
   * will see the new snapshot via current().
   */
  swap(next: RegistrySnapshot): void {
    this.snapshot = next;
  }
}
