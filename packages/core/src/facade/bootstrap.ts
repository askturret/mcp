// SPDX-License-Identifier: Apache-2.0
/**
 * Framework-neutral facade wiring (§4, §12.3).
 *
 * Everything an adapter does that is NOT about its framework: applying Light
 * preset defaults, discovering and compiling sources, filtering the operation
 * set, extracting a user context. Express and Fastify call the SAME functions
 * here, which is what makes "swap the import and change nothing else" a
 * property of the code rather than a claim in a README.
 *
 * The dividing line is deliberate and worth stating, because it is also the
 * test §41 asks for: if something in a facade cannot be expressed without
 * naming a request, a response, or a router, it belongs in the adapter. If it
 * can, it belongs here — and anything that ended up in an adapter but could
 * live here is a place the facade was accidentally framework-shaped.
 */

import { createCompiler } from '../compiler/index.js';
import { AtomicRegistryReference } from '../registry-reference.js';
import type { OperationDefinition, RegistrySnapshot } from '../types.js';
import type { CompilerContext } from '../compiler/types.js';
import type {
  DiscoveredOperation,
  DiscoveryContext,
  Logger,
  OperationSource,
} from '../sources/types.js';
import type {
  FacadeRequestContext,
  IncludeFilter,
  McpFacadeOptions,
  ResolvedFacadeDefaults,
} from './types.js';

/** Light preset bounds (§ facade defaults). One definition, both adapters. */
export const FACADE_DEFAULT_MAX_REQUEST_BODY_SIZE = 1048576; // 1 MiB
export const FACADE_DEFAULT_MAX_RESPONSE_SIZE = 1048576; // 1 MiB
export const FACADE_DEFAULT_DEADLINE_MS = 30000; // 30s
export const FACADE_DEFAULT_BASE_PATH = '/mcp';

/**
 * Apply Light preset defaults to a facade's options.
 *
 * Shared so a default cannot silently differ between adapters. "Same body-size
 * limits, same deadline defaults, same Explorer dev-only default" (§41) is a
 * requirement that a second copy of these five numbers would quietly break the
 * first time one of them was tuned.
 */
export function resolveFacadeDefaults(options: McpFacadeOptions): ResolvedFacadeDefaults {
  return {
    basePath: options.basePath ?? FACADE_DEFAULT_BASE_PATH,
    maxRequestBodySize: options.maxRequestBodySize ?? FACADE_DEFAULT_MAX_REQUEST_BODY_SIZE,
    maxResponseSize: options.maxResponseSize ?? FACADE_DEFAULT_MAX_RESPONSE_SIZE,
    deadlineMs: options.deadlineMs ?? FACADE_DEFAULT_DEADLINE_MS,
    // Explorer is off by default in production (§10.1 invariant 9). Note this
    // reads the environment at CALL time, not at module load, so a test that
    // sets NODE_ENV before constructing a facade gets the behaviour it asked for.
    enableExplorer: options.enableExplorer ?? process.env['NODE_ENV'] !== 'production',
  };
}

/**
 * A console logger that goes quiet under NODE_ENV=test.
 *
 * Not merely tidiness: Jest fails a suite that logs after teardown, and the
 * facade's async registry bootstrap routinely finishes after a fast test has
 * ended. Both adapters need exactly this, so it is defined once.
 */
export function createFacadeLogger(): Logger {
  const isTest = process.env['NODE_ENV'] === 'test';
  return {
    debug: (msg: string, meta?: Record<string, unknown>) => {
      if (!isTest) console.debug(msg, meta);
    },
    info: (msg: string, meta?: Record<string, unknown>) => {
      if (!isTest) console.info(msg, meta);
    },
    warn: (msg: string, meta?: Record<string, unknown>) => {
      if (!isTest) console.warn(msg, meta);
    },
    error: (msg: string, meta?: Record<string, unknown>) => {
      if (!isTest) console.error(msg, meta);
    },
  };
}

/** An empty registry to serve from until discovery and compilation finish. */
export function emptySnapshot(): RegistrySnapshot {
  return { hash: '', operations: new Map(), version: 1, createdAt: new Date() };
}

/**
 * Apply the include filter to a compiled snapshot.
 *
 * The `undefined` branch is the security-relevant one: Light preset exposes
 * read-only operations ONLY. A spec-discovered mutation reaching an agent
 * without anyone deciding it should is the failure this default exists to
 * prevent, so opting in is explicit — `'*'` or a list of ids.
 */
export function applyIncludeFilter(
  snapshot: RegistrySnapshot,
  include: IncludeFilter | undefined,
): RegistrySnapshot {
  if (include === '*') return snapshot;

  const operations = new Map<string, OperationDefinition>();

  if (Array.isArray(include)) {
    for (const id of include) {
      const op = snapshot.operations.get(id);
      if (op) operations.set(id, op);
    }
    return { ...snapshot, operations };
  }

  for (const [id, op] of snapshot.operations.entries()) {
    if (op.effects.readOnly) operations.set(id, op);
  }
  return { ...snapshot, operations };
}

export interface RegistryBootstrap {
  /** Serves an empty snapshot until `ready` resolves, then the compiled one. */
  readonly registry: AtomicRegistryReference;

  /**
   * Resolves when discovery and compilation have finished.
   *
   * An adapter MUST await this before handling a request. Without it a fast
   * first caller races the bootstrap and gets an empty tools list — which looks
   * like "this server exposes nothing" rather than like a race, and so gets
   * reported as a configuration problem.
   */
  readonly ready: Promise<void>;
}

/**
 * Discover, compile, filter, and publish — the whole neutral bootstrap.
 */
export function bootstrapRegistry(
  sources: OperationSource[],
  include: IncludeFilter | undefined,
  logger: Logger,
): RegistryBootstrap {
  const registry = new AtomicRegistryReference(emptySnapshot());

  const ready = (async () => {
    try {
      const snapshot = await compileSnapshot(sources, include, logger, 'light');
      registry.swap(snapshot);
      logger.info('Registry initialized', { operationCount: snapshot.operations.size });
    } catch (error) {
      logger.error('Failed to initialize registry', { error });
      throw error;
    }
  })();

  return { registry, ready };
}

/**
 * Discover, compile and filter — producing a snapshot without publishing it.
 *
 * Extracted from `bootstrapRegistry` for #131. The difference that matters is
 * REPEATABILITY: bootstrap runs this once and swaps the result in, whereas a
 * reload controller needs a `compile()` it can call again on every reload. The
 * same steps in both places is the point — a reload that compiled differently
 * from the boot path would drift from it silently, and the first symptom would
 * be a snapshot that only reproduces after a restart.
 *
 * `preset` is a parameter rather than the hardcoded `'light'` it replaced,
 * because a preset-driven server compiles under its own preset. Bootstrap still
 * passes `'light'`, so facade behaviour is unchanged.
 */
export async function compileSnapshot(
  sources: OperationSource[],
  include: IncludeFilter | undefined,
  logger: Logger,
  preset: CompilerContext['preset'],
): Promise<RegistrySnapshot> {
  const abortController = new AbortController();
  const discoveryContext: DiscoveryContext = {
    logger,
    abortSignal: abortController.signal,
  };

  const discovered: DiscoveredOperation[] = [];
  for (const source of sources) {
    discovered.push(...(await source.discover(discoveryContext)));
  }

  const compilerContext: Omit<CompilerContext, 'warnings'> = {
    logger,
    preset,
    overlays: [],
  };
  const compiled = await createCompiler().compile(discovered, compilerContext);

  return applyIncludeFilter(compiled, include);
}

/**
 * Extract a user context from whatever the host framework attached.
 *
 * A small ALLOWLIST rather than reflection over the object. A host's user
 * object routinely carries a session token, a password hash, or a full
 * provider profile, and this context is handed to hooks and can reach logs and
 * spans. Copying everything would make the facade a data-exfiltration path by
 * default; copying four named fields cannot.
 *
 * Framework-neutral because it takes the user object, not the request —
 * Express reads `req.user`, Fastify reads a decorator, and both arrive here.
 */
export function extractUserContext(user: unknown): FacadeRequestContext['user'] | undefined {
  if (!user || typeof user !== 'object') return undefined;

  const candidate = user as Record<string, unknown>;
  const result: NonNullable<FacadeRequestContext['user']> = {};

  if (typeof candidate['id'] === 'string') result.id = candidate['id'];
  if (typeof candidate['email'] === 'string') result.email = candidate['email'];
  if (typeof candidate['name'] === 'string') result.name = candidate['name'];
  if (Array.isArray(candidate['roles'])) result.roles = candidate['roles'] as string[];

  return result;
}

/**
 * The warning emitted when Explorer is switched on in production.
 *
 * §10.1 invariant 9 makes Explorer off-by-default in production. An operator
 * who turns it on anyway is not blocked — but the reason is named, because
 * Explorer publishes the full tool surface and can invoke tools while having no
 * authentication of its own.
 */
export function explorerProductionWarning(basePath: string): string {
  return (
    'Explorer is ENABLED in production by an explicit enableExplorer: true setting. ' +
    'It publishes the full tool surface and can invoke tools. Explorer has no ' +
    'authentication of its own — it inherits only whatever protects ' +
    `${basePath}/explorer in the host app.`
  );
}
