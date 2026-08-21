// SPDX-License-Identifier: Apache-2.0
/**
 * In-memory session store implementation
 *
 * IMPORTANT: This is suitable for development only.
 * Production deployments should use a distributed session store
 * (Redis, DynamoDB, etc.) to support horizontal scaling.
 */

import type { SessionStore, SessionData } from './types.js';

/**
 * Create an in-memory session store
 *
 * WARNING: Sessions are lost on process restart.
 * Not suitable for production unless running a single instance.
 */
export function createInMemorySessionStore(): SessionStore {
  return new InMemorySessionStore();
}

/**
 * In-memory session store implementation
 */
class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionData>();

  async get(sessionId: string): Promise<SessionData | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async set(sessionId: string, data: SessionData): Promise<void> {
    this.sessions.set(sessionId, data);
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}
