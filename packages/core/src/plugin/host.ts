// SPDX-License-Identifier: Apache-2.0
/**
 * Loading plugins: version gate, capability negotiation, registration
 * collection (§6, ADR-018, #53).
 *
 * Two refusals, at two different moments, and the distinction is load-bearing:
 *
 *   - **apiVersion out of range → refused at LOAD**, before `setup` runs. A
 *     plugin built against an API we do not speak must not execute a line: its
 *     first call could be to a method that no longer means what it did.
 *   - **undeclared capability → refused at SETUP**, when the call is made. The
 *     manifest cannot be checked against calls that have not happened yet, so
 *     this one can only fire in the act.
 *
 * Both throw. Neither logs-and-continues, because a partially-loaded plugin is
 * the worst outcome available — it has registered some of what it needs and
 * the operator has an error in a log rather than a server that refused to
 * start.
 */

import type { CompilerPass } from '../compiler/types.js';
import type { OperationExecutor } from '../executor/types.js';
import type { Policy } from '../policy/types.js';
import type { RedactionRule } from '../redaction/types.js';
import type { OperationSource } from '../sources/types.js';
import {
  PLUGIN_API_VERSION,
  PLUGIN_CAPABILITIES,
  type AskTurretPlugin,
  type ObservabilityExporter,
  type PluginCapability,
  type PluginContext,
  type PluginManifest,
  type PluginRegistration,
  type PluginRegistrations,
} from './types.js';

/** A plugin was refused. `code` is stable; the message is not. */
export class PluginRefusedError extends Error {
  readonly code:
    | 'api-version-unparseable'
    | 'api-version-out-of-range'
    | 'unknown-capability'
    | 'capability-not-declared'
    | 'duplicate-plugin';
  readonly plugin: string;

  constructor(code: PluginRefusedError['code'], plugin: string, message: string) {
    super(message);
    this.name = 'PluginRefusedError';
    this.code = code;
    this.plugin = plugin;
  }
}

interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * Parse `MAJOR.MINOR.PATCH`, ignoring any pre-release or build suffix.
 *
 * Hand-rolled rather than pulling in a semver library: this repository has
 * added no runtime dependency so far, and the comparison below needs three
 * integers, not range syntax. Returns undefined rather than throwing so the
 * caller decides what an unparseable version means.
 */
export function parseSemVer(value: string): SemVer | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (match === null) return undefined;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * Is a plugin built against `pluginApiVersion` loadable on `runtimeVersion`?
 *
 * Same MAJOR, and the plugin's MINOR no higher than the runtime's.
 *
 * The asymmetry is the point and runs the opposite way to intuition. A plugin
 * built against 1.0 runs fine on a 1.2 runtime — the API is additive within a
 * major, so everything it calls still exists. A plugin built against 1.2 must
 * NOT run on a 1.0 runtime: it may call a method 1.0 does not have, and it
 * would fail as `undefined is not a function` deep inside `setup`, after
 * partially registering. Refusing at load turns that into one clear sentence.
 *
 * PATCH is ignored entirely. A patch bump that changed what a plugin can call
 * would be a mislabelled release, and honouring it here would encourage one.
 */
export function isPluginApiCompatible(
  pluginApiVersion: string,
  runtimeVersion: string = PLUGIN_API_VERSION,
): boolean {
  const plugin = parseSemVer(pluginApiVersion);
  const runtime = parseSemVer(runtimeVersion);
  if (plugin === undefined || runtime === undefined) return false;

  return plugin.major === runtime.major && plugin.minor <= runtime.minor;
}

interface MutableRegistrations {
  sources: PluginRegistration<OperationSource>[];
  executors: PluginRegistration<{ name: string; executor: OperationExecutor }>[];
  policies: PluginRegistration<Policy>[];
  compilerPasses: PluginRegistration<CompilerPass>[];
  observabilityExporters: PluginRegistration<ObservabilityExporter>[];
  redactionRules: PluginRegistration<RedactionRule>[];
}

function emptyRegistrations(): MutableRegistrations {
  return {
    sources: [],
    executors: [],
    policies: [],
    compilerPasses: [],
    observabilityExporters: [],
    redactionRules: [],
  };
}

/**
 * Build the context handed to ONE plugin's `setup`.
 *
 * A fresh object per plugin, closing over that plugin's declared capabilities
 * and its name. That is what makes "no cross-plugin state access" structural
 * rather than promised: plugin B is not given a reference through which plugin
 * A's registrations could be read or removed, and the shared accumulator is
 * captured in the closure rather than exposed on the context.
 *
 * Exported for tests, which need to drive the assert directly.
 */
export function createPluginContext(
  manifest: PluginManifest,
  into: MutableRegistrations,
): PluginContext {
  const declared = new Set<PluginCapability>(manifest.capabilities);

  const require_ = (capability: PluginCapability, method: string): void => {
    if (declared.has(capability)) return;

    throw new PluginRefusedError(
      'capability-not-declared',
      manifest.name,
      `Plugin '${manifest.name}' called ${method}() without declaring the '${capability}' ` +
        `capability. Declared: [${manifest.capabilities.join(', ') || 'none'}]. Add ` +
        `'${capability}' to the manifest's capabilities if this call is intended — the ` +
        `manifest is the code-review artifact for what this plugin can affect, so it has to ` +
        `say so.`,
    );
  };

  return {
    registerSource(source) {
      require_('source', 'registerSource');
      into.sources.push({ plugin: manifest.name, value: source });
    },
    registerExecutor(name, executor) {
      require_('executor', 'registerExecutor');
      into.executors.push({ plugin: manifest.name, value: { name, executor } });
    },
    registerPolicy(policy) {
      require_('policy', 'registerPolicy');
      into.policies.push({ plugin: manifest.name, value: policy });
    },
    registerCompilerPass(pass) {
      require_('compiler-pass', 'registerCompilerPass');
      into.compilerPasses.push({ plugin: manifest.name, value: pass });
    },
    registerObservabilityExporter(exporter) {
      require_('observability', 'registerObservabilityExporter');
      into.observabilityExporters.push({ plugin: manifest.name, value: exporter });
    },
    addRedactionRule(rule) {
      require_('redaction-rule', 'addRedactionRule');
      into.redactionRules.push({ plugin: manifest.name, value: rule });
    },
  };
}

export interface LoadPluginsOptions {
  /**
   * Runtime API version to check plugins against. Defaults to
   * `PLUGIN_API_VERSION`; injectable so version-gate tests do not have to move
   * the real constant.
   */
  readonly runtimeApiVersion?: string;
}

/**
 * Load plugins: gate each on API version, then run `setup` with a scoped
 * context, and return everything they registered.
 *
 * Sequential rather than concurrent, deliberately. Registration order is
 * observable — compiler passes run in order, redaction rules are first-match —
 * so `Promise.all` would make the resulting configuration depend on which
 * plugin's `setup` happened to resolve first. A reproducible server is worth
 * more here than a few milliseconds at boot.
 */
export async function loadPlugins(
  plugins: readonly AskTurretPlugin<PluginCapability>[],
  options?: LoadPluginsOptions,
): Promise<PluginRegistrations> {
  const runtimeApiVersion = options?.runtimeApiVersion ?? PLUGIN_API_VERSION;
  const into = emptyRegistrations();
  const seen = new Set<string>();

  for (const plugin of plugins) {
    const { manifest } = plugin;

    // Two plugins under one name would make every registration ambiguous —
    // `PluginRegistration.plugin` is the only attribution there is.
    if (seen.has(manifest.name)) {
      throw new PluginRefusedError(
        'duplicate-plugin',
        manifest.name,
        `Plugin '${manifest.name}' was supplied twice. Registrations are attributed by name, ` +
          `so two plugins sharing one would make every attribution ambiguous.`,
      );
    }
    seen.add(manifest.name);

    if (parseSemVer(manifest.apiVersion) === undefined) {
      throw new PluginRefusedError(
        'api-version-unparseable',
        manifest.name,
        `Plugin '${manifest.name}' declares apiVersion '${manifest.apiVersion}', which is not ` +
          `a MAJOR.MINOR.PATCH version. The runtime speaks plugin API ${runtimeApiVersion}.`,
      );
    }

    if (!isPluginApiCompatible(manifest.apiVersion, runtimeApiVersion)) {
      throw new PluginRefusedError(
        'api-version-out-of-range',
        manifest.name,
        `Plugin '${manifest.name}' requires plugin API ${manifest.apiVersion}, but this runtime ` +
          `speaks ${runtimeApiVersion}. A plugin is loadable when its MAJOR matches and its ` +
          `MINOR is no higher than the runtime's — a newer plugin may call methods this ` +
          `runtime does not have. Upgrade @askturret/mcp, or install a plugin release built ` +
          `for plugin API ${runtimeApiVersion}.`,
      );
    }

    // Unknown capability is refused BEFORE setup: a manifest naming a
    // capability we do not recognise is either a typo — in which case the
    // method it meant to authorise will be refused later with a much more
    // confusing message — or a plugin from a newer API that slipped the
    // version gate.
    for (const capability of manifest.capabilities) {
      if (!PLUGIN_CAPABILITIES.includes(capability)) {
        throw new PluginRefusedError(
          'unknown-capability',
          manifest.name,
          `Plugin '${manifest.name}' declares unknown capability '${capability}'. Known ` +
            `capabilities: ${PLUGIN_CAPABILITIES.join(', ')}.`,
        );
      }
    }

    const context = createPluginContext(manifest, into);
    // Cast because the plugin's `setup` is typed against its OWN narrowed
    // context; the host holds the full one, which satisfies every narrowing.
    await plugin.setup(context as Parameters<typeof plugin.setup>[0]);
  }

  return into;
}

/**
 * Constrain a plugin rule to LEAF values.
 *
 * ## Why ordering alone is not enough — found by the #53 test suite
 *
 * The redaction pipeline appends user rules after the built-ins and takes the
 * first match, and its own comment concludes from that: "a user rule therefore
 * cannot un-redact something the defaults already catch."
 *
 * That is true at a single node and FALSE across nesting. `walk()` evaluates
 * rules at every node INCLUDING the root, and a match returns
 * `transform(value)` without descending. So a plugin rule that matches the
 * containing object short-circuits the entire subtree, and the built-ins never
 * get to see the leaves they would have caught:
 *
 * ```ts
 * { id: 'passthrough', matches: () => true, transform: (v) => v }
 * ```
 *
 * Registered by a plugin, that rule matches the ROOT object, returns it
 * untouched, and every secret inside it survives — without removing a single
 * built-in. §53's non-negotiable is "no removing built-in redaction rules";
 * this neutralises them instead, which is the same outcome for the adopter and
 * is exactly what that rule exists to prevent.
 *
 * So a plugin rule is wrapped to decline containers. Objects and arrays fall
 * through to the walk, the built-ins get their turn on every leaf, and the
 * plugin rule still applies to each leaf individually — which is where a
 * redaction rule's job actually is.
 *
 * ## What this deliberately does not do
 *
 * It does not change the pipeline for rules an adopter adds themselves. An
 * adopter calling `pipeline.add` directly is trusted with their own process and
 * may legitimately want to replace a whole subtree. The constraint is applied
 * at the PLUGIN boundary, because that is where the trust boundary is — a
 * plugin is third-party code the adopter installed, not code they wrote.
 *
 * The cost is that a plugin cannot redact a whole object in one rule. It can
 * still redact every leaf within it, so coverage is unchanged; only the shape
 * of the output differs.
 */
export function constrainPluginRedactionRule(rule: RedactionRule): RedactionRule {
  return {
    id: rule.id,
    matches(context, value) {
      // Containers are never a plugin rule's to claim — matching one would
      // stop the walk before the built-ins saw anything inside it.
      if (value !== null && typeof value === 'object') return false;
      return rule.matches(context, value);
    },
    transform: (value) => rule.transform(value),
  };
}

/**
 * Append plugin-registered redaction rules to a pipeline.
 *
 * Two things make §53's "plugins extend, never replace" hold, and both are
 * needed:
 *
 *   1. `add` APPENDS, so every built-in is ahead of every plugin rule under
 *      first-match-wins. That is the pipeline's own guarantee.
 *   2. Each plugin rule is constrained to leaf values, so it cannot match a
 *      container and skip the walk that would have reached the built-ins. See
 *      `constrainPluginRedactionRule` — ordering alone does NOT give this.
 */
export function applyPluginRedactionRules(
  pipeline: { add(rule: RedactionRule): void },
  registrations: PluginRegistrations,
): void {
  for (const registration of registrations.redactionRules) {
    pipeline.add(constrainPluginRedactionRule(registration.value));
  }
}
