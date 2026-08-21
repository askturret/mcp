// SPDX-License-Identifier: Apache-2.0
/**
 * Resolves the upstream base URL for an OpenAPI document.
 *
 * The `servers` array is advisory and frequently imperfect in real specs, so
 * this resolves what it safely can and reports why when it cannot, rather than
 * guessing. A wrong base URL sends real traffic to an unintended host, so an
 * unresolved base URL is always preferable to a plausible-looking one.
 */

import type { Logger } from '@askturret/mcp-core';

/** An OpenAPI Server Object (the subset that affects resolution). */
export interface OpenApiServer {
  url?: string;
  description?: string;
  variables?: Record<string, { default?: string; enum?: string[]; description?: string }>;
}

export interface ServerResolution {
  /** Absolute `http(s)` base URL, or undefined when none could be resolved. */
  baseUrl?: string;
  /** Why resolution failed, for logs and error messages. Absent on success. */
  reason?: string;
  /** Server entries beyond the one chosen — reported so the choice is not silent. */
  alternatives: string[];
}

/**
 * Resolve the base URL to call for operations discovered from a spec.
 *
 * Rules, in order:
 *  1. No `servers` entry — OpenAPI defaults to `/`, which is relative and only
 *     meaningful to a client that already knows the origin. Unresolved.
 *  2. Template variables (`https://{region}.api.com`) are substituted from each
 *     variable's `default`. A variable with no default leaves the URL unusable.
 *  3. An absolute `http(s)` URL is used as-is.
 *  4. A relative URL (`/api/v1`) is resolved against `specUrl` when the spec
 *     itself was fetched over http(s) — that is the origin the spec is relative
 *     to. Otherwise unresolved: a spec loaded from disk carries no origin.
 *  5. Multiple servers — the first usable one wins (OpenAPI treats order as
 *     meaningful), and the rest are returned as `alternatives` so the caller can
 *     surface the choice.
 *
 * Non-http schemes are rejected: this executor speaks HTTP, and honouring
 * `file:` or similar would turn a spec into a local-file read.
 */
export function resolveServerUrl(
  servers: OpenApiServer[] | undefined,
  specUrl: string | undefined,
  logger?: Logger,
): ServerResolution {
  const entries = (servers ?? []).filter((s) => typeof s?.url === 'string' && s.url.length > 0);

  if (entries.length === 0) {
    return {
      reason:
        'the spec declares no servers entry (OpenAPI then defaults to "/", which is relative ' +
        'and has no origin on its own)',
      alternatives: [],
    };
  }

  const failures: string[] = [];
  let chosen: string | undefined;
  const usable: string[] = [];

  for (const server of entries) {
    const substituted = substituteVariables(server, failures);
    if (!substituted) continue;

    const absolute = toAbsolute(substituted, specUrl, failures);
    if (!absolute) continue;

    usable.push(absolute);
    if (chosen === undefined) chosen = absolute;
  }

  if (chosen === undefined) {
    return {
      reason: failures[0] ?? 'no usable server URL in the spec',
      alternatives: [],
    };
  }

  const alternatives = usable.slice(1);
  if (alternatives.length > 0 && logger) {
    // Never silent: an operator should be able to see which upstream was picked.
    logger.info('Multiple servers declared; using the first', {
      using: chosen,
      alternatives,
    });
  }

  return { baseUrl: stripTrailingSlash(chosen), alternatives };
}

/**
 * Substitute `{variable}` placeholders using each variable's declared default.
 */
function substituteVariables(server: OpenApiServer, failures: string[]): string | undefined {
  const url = server.url as string;
  if (!url.includes('{')) return url;

  let missing: string | undefined;
  const substituted = url.replace(/\{([^}]+)\}/g, (match, rawName: string) => {
    const name = rawName.trim();
    const def = server.variables?.[name]?.default;
    if (typeof def !== 'string' || def.length === 0) {
      missing ??= name;
      return match;
    }
    return def;
  });

  if (missing !== undefined) {
    failures.push(
      `server URL "${url}" uses variable {${missing}}, which declares no default value`,
    );
    return undefined;
  }
  return substituted;
}

/**
 * Turn a possibly-relative server URL into an absolute http(s) URL.
 */
function toAbsolute(url: string, specUrl: string | undefined, failures: string[]): string | undefined {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
    if (!/^https?:\/\//i.test(url)) {
      failures.push(`server URL "${url}" does not use http or https`);
      return undefined;
    }
    return url;
  }

  // Relative: only resolvable when the spec itself came from an http(s) URL.
  if (specUrl && /^https?:\/\//i.test(specUrl)) {
    try {
      return new URL(url, specUrl).toString();
    } catch {
      failures.push(`server URL "${url}" could not be resolved against the spec URL "${specUrl}"`);
      return undefined;
    }
  }

  failures.push(
    `server URL "${url}" is relative, and the spec was not loaded from an http(s) URL, ` +
      'so it has no origin to resolve against',
  );
  return undefined;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '') || url;
}
