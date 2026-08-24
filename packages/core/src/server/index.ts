// SPDX-License-Identifier: Apache-2.0
/**
 * `createMcpServer` — preset-driven runtime construction (#131).
 *
 * ## What this closes
 *
 * The Production preset declared `reloadMode: 'degraded'` (#36) and
 * `createReloadController` implemented the semantics (#37), but nothing joined
 * them: booting with `preset: 'production'` produced a configuration OBJECT
 * saying `degraded` and no controller enforcing anything. #36 called that a
 * "downgrade, not removal" and declared the gap honestly rather than claiming a
 * guarantee it did not have. This wires it.
 *
 * ## What is still NOT wired, stated plainly
 *
 * This is not a serving server yet. There is no transport, no dispatcher and no
 * listener here — `start()` and `stop()` still refuse, and the preset's
 * `pending` list still names `audit.sink`, `redaction` and `outputValidation`,
 * whose underlying primitives are Epic #3 work. #131's acceptance is explicit
 * that no claim should outrun what is actually wired, so the scope of this
 * function is exactly: expand the preset, build a registry, and construct the
 * reload controller the preset asks for.
 *
 * Adapters that DO serve traffic (`expressMcp`, `fastifyMcp`, the gateway) go
 * through the facade in `../facade/`, which is a separate and older path. This
 * function does not replace them.
 */

import { AtomicRegistryReference, type RegistryReference } from '../registry-reference.js';
import { compileSnapshot } from '../facade/bootstrap.js';
import { emptySnapshot } from '../facade/bootstrap.js';
import type { IncludeFilter } from '../facade/types.js';
import { createReloadController } from '../reload/controller.js';
import type { ReloadController, ReloadMetrics, SnapshotValidator } from '../reload/types.js';
import { describePreset, productionPreset } from '../preset/production.js';
import { regulatedPreset } from '../preset/regulated.js';
import type {
  PresetConfiguration,
  PendingControl,
  ProductionPresetOptions,
  RegulatedPresetOptions,
  ReloadMode,
} from '../preset/types.js';
import type { Logger, OperationSource } from '../sources/types.js';
import type { RegistrySnapshot } from '../types.js';

/**
 * Raised when a preset asks for a reload mode the controller cannot honour.
 *
 * See `assertControllerSupports` for why this refuses rather than falls back.
 */
export class UnsupportedReloadModeError extends Error {
  constructor(
    readonly mode: ReloadMode,
    readonly preset: SupportedPreset,
  ) {
    super(
      `Preset '${preset}' requests reloadMode '${mode}', which createReloadController does not ` +
        `implement. Booting would silently give you 'degraded' behaviour instead. ` +
        `See the 'reloadMode' entry in describePreset('${preset}').pending.`,
    );
    this.name = 'UnsupportedReloadModeError';
  }
}

/**
 * Reload modes `createReloadController` actually has a branch for.
 *
 * `fail-readiness` is deliberately absent — see `assertControllerSupports`.
 */
const CONTROLLER_IMPLEMENTED_MODES: readonly ReloadMode[] = ['degraded', 'fail-fast'];

/**
 * Refuse a mode the controller does not implement, rather than pass it through.
 *
 * ## Why this guard exists at all
 *
 * `ReloadMode` has three members and the controller branches on ONE of them:
 * `if (this.mode === 'fail-fast') throw`. Anything else takes the degraded
 * path. That is fine while nothing hands the controller a third value — and
 * wiring preset → controller is precisely what starts handing it one, because
 * the Regulated preset declares `reloadMode: 'fail-readiness'`.
 *
 * So the naive wiring — `mode: configuration.reloadMode` — would take Regulated's
 * "readiness goes hard-negative, pull me from the load balancer" and quietly
 * turn it into "keep serving while flagged degraded". Regulated's own `pending`
 * entry says that difference "is the entire reason §10.2 lists it separately",
 * and that it was declared rather than silently mapped onto degraded. Wiring it
 * into a silent mapping would undo that decision by accident.
 *
 * Refusing is the honest option: an adopter who selects Regulated learns at
 * construction that the mode is not implemented, instead of discovering it from
 * behaviour during an incident. The refusal names the `pending` entry so the
 * next step is obvious.
 */
function assertControllerSupports(mode: ReloadMode, preset: SupportedPreset): void {
  if (!CONTROLLER_IMPLEMENTED_MODES.includes(mode)) {
    throw new UnsupportedReloadModeError(mode, preset);
  }
}

/** Presets that expand to a configuration this function can build from. */
export type SupportedPreset = 'production' | 'regulated';

export interface McpServerReloadOptions {
  /**
   * Extra validation applied to a candidate snapshot before it is published.
   *
   * Optional: the compiler's own invariant pass already runs during `compile`.
   */
  readonly validate?: SnapshotValidator;

  /**
   * How many previous snapshots to retain for rollback.
   *
   * Named `retain` to match `ReloadControllerOptions` exactly. That is not
   * cosmetic: this object is forwarded with a conditional spread, and a spread
   * defeats TypeScript's excess-property check — so a near-miss name like
   * `retainCount` would compile, forward, and be silently ignored. Which is the
   * dead-but-load-bearing-looking field #129 was about.
   */
  readonly retain?: number;

  /** Reload metric sink. Absent means metrics are not recorded. */
  readonly metrics?: ReloadMetrics;
}

export interface McpServerOptions {
  /**
   * Which preset governs this server.
   *
   * Required, and narrower than `PresetName`: `light` has no expansion in the
   * preset module, so there is no `reloadMode` to read off it. Light-preset
   * serving is the facade's job (`expressMcp` / `fastifyMcp`), which is a
   * different and already-working path.
   */
  readonly preset: SupportedPreset;

  /** Operation sources, discovered and compiled on boot and on every reload. */
  readonly sources: OperationSource[];

  /** Which operations to expose. See `IncludeFilter`. */
  readonly include?: IncludeFilter;

  /** Absent means SILENT — importing core must not write to stdout uninvited. */
  readonly logger?: Logger;

  /** Knobs the preset does not decide. The MODE is not among them, by design. */
  readonly reload?: McpServerReloadOptions;

  /** Options the chosen preset requires. Regulated refuses without them. */
  readonly presetOptions?: ProductionPresetOptions | RegulatedPresetOptions;
}

export interface McpServer {
  /** The expanded preset — the same object `describePreset` returns. */
  readonly configuration: PresetConfiguration;

  /** Controls this preset declares but that are not yet enforced end to end. */
  readonly pending: readonly PendingControl[];

  /** The reference a dispatcher would read from. The controller swaps it. */
  readonly registry: RegistryReference;

  /** Live, and constructed with the preset's own `reloadMode`. */
  readonly reload: ReloadController;

  /** Resolves once the first compile has published a snapshot. */
  readonly ready: Promise<void>;

  /** Not implemented — this function builds a runtime, it does not serve. */
  start(): Promise<void>;

  /** Not implemented — see `start`. */
  stop(): Promise<void>;
}

const SILENT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Build the runtime a preset describes.
 *
 * The reload controller is constructed from `configuration.reloadMode` — the
 * preset's own value, not a parameter — which is the join #131 asks for. There
 * is deliberately no `reload.mode` option: letting a caller override it would
 * reintroduce the gap this closes, where the declared configuration and the
 * enforced behaviour can disagree.
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const logger = options.logger ?? SILENT_LOGGER;

  // Branched rather than cast at the call site: `describePreset` is overloaded
  // so that Regulated's options are REQUIRED, and collapsing the two arms into
  // one call would need a cast that discards exactly that guarantee.
  //
  // Both are needed. `productionPreset` / `regulatedPreset` return the real
  // expansion — the one carrying `reloadMode` and a live `Policy` — while
  // `describePreset` returns the JSON-safe SUMMARY plus the `pending` list.
  const { configuration, pending } =
    options.preset === 'regulated'
      ? {
          configuration: regulatedPreset(options.presetOptions as RegulatedPresetOptions),
          pending: describePreset('regulated', options.presetOptions as RegulatedPresetOptions)
            .pending,
        }
      : {
          configuration: productionPreset(
            options.presetOptions as ProductionPresetOptions | undefined,
          ),
          pending: describePreset(
            'production',
            options.presetOptions as ProductionPresetOptions | undefined,
          ).pending,
        };

  // Before anything is constructed. A server that has already built half a
  // runtime and then refuses is harder to reason about than one that refuses
  // at the door.
  assertControllerSupports(configuration.reloadMode, options.preset);

  const registry = new AtomicRegistryReference(emptySnapshot());

  const compile = (): Promise<RegistrySnapshot> =>
    compileSnapshot(options.sources, options.include, logger, options.preset);

  const reload = createReloadController({
    reference: registry,
    compile,
    mode: configuration.reloadMode,
    logger,
    ...(options.reload?.validate === undefined ? {} : { validate: options.reload.validate }),
    ...(options.reload?.retain === undefined ? {} : { retain: options.reload.retain }),
    ...(options.reload?.metrics === undefined ? {} : { metrics: options.reload.metrics }),
  });

  // The first publication goes through the SAME compile the controller uses, so
  // boot and reload cannot drift. It is a plain swap rather than a
  // `reload()` call because `reload()` records a reload metric and pushes the
  // empty bootstrap snapshot into rollback history — neither of which describes
  // starting up.
  const ready = (async () => {
    try {
      const snapshot = await compile();
      registry.swap(snapshot);
      logger.info('Registry initialized', { operationCount: snapshot.operations.size });
    } catch (error) {
      logger.error('Failed to initialize registry', { error });
      throw error;
    }
  })();

  const notServing = (method: string): Promise<never> =>
    Promise.reject(
      new Error(
        `createMcpServer().${method}() is not implemented. This builds the runtime a preset ` +
          `describes — registry and reload controller — but does not serve traffic. Use an ` +
          `adapter (expressMcp / fastifyMcp) or @askturret/mcp-gateway to serve.`,
      ),
    );

  return {
    configuration,
    pending,
    registry,
    reload,
    ready,
    start: () => notServing('start'),
    stop: () => notServing('stop'),
  };
}
