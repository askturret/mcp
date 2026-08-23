// SPDX-License-Identifier: Apache-2.0
/**
 * The stable plugin API (§6 "Plugin author API", ADR-018, #53).
 *
 * ## The whole design in one sentence
 *
 * A plugin receives SCOPED, TYPED SETTERS — never a handle on anything mutable
 * that the runtime owns.
 *
 * That is the difference between an ecosystem and a liability. Epics 1–3 built
 * a fixed execution envelope, an immutable registry snapshot, a redaction
 * pipeline whose built-ins win ties, and an audit path that cannot be skipped.
 * Every one of those invariants is enforced by the runtime holding the only
 * reference to the thing that could break it. Hand a plugin the dispatcher and
 * all of it is advisory.
 *
 * So `PluginContext` exposes six `register*` methods and nothing else. There is
 * no `getRegistry()`, no `getDispatcher()`, no `redactionPipeline`. A plugin
 * cannot mutate a snapshot, cannot reorder envelope stages, cannot remove a
 * built-in redaction rule, and cannot reach another plugin's state — not
 * because it is asked not to, but because no method exists that would let it.
 *
 * ## What this does NOT do
 *
 * It is not a sandbox. A plugin runs in the same process, on the same event
 * loop, with the same filesystem and network access as the host, and nothing
 * here changes that: a malicious plugin can still `require('fs')`. §53 puts
 * sandboxing explicitly out of scope, and saying so plainly matters more than
 * the guarantee sounding complete — an adopter who believes this API contains
 * hostile code would make a worse decision than one who knows it does not.
 *
 * What it DOES contain is accident. A plugin cannot break an invariant it did
 * not mean to touch, and its manifest states in one line what it can affect.
 */

import type { CompilerPass } from '../compiler/types.js';
import type { OperationExecutor } from '../executor/types.js';
import type { Policy } from '../policy/types.js';
import type { RedactionRule } from '../redaction/types.js';
import type { OperationSource } from '../sources/types.js';
import type { Observability } from '../telemetry/types.js';

/**
 * The version of THIS API — deliberately not the package version.
 *
 * §53 requires the two to be separate, and the reason is that they answer
 * different questions. `@askturret/mcp`'s version moves whenever anything in
 * the package changes; a plugin author does not care about any of that. They
 * care about one thing: will the methods I call still exist?
 *
 * So this bumps ONLY when a `PluginContext` method changes signature or a
 * `PluginCapability` is removed. Adding a capability or a method is additive
 * and moves the MINOR; neither breaks an existing plugin.
 */
export const PLUGIN_API_VERSION = '1.0.0';

/**
 * What a plugin is allowed to register.
 *
 * A manifest listing these is a code-review artifact: a reviewer reads one line
 * and knows the blast radius. `'redaction-rule'` and `'policy'` on the same
 * plugin is worth a closer look; `'observability'` alone is not.
 */
export type PluginCapability =
  | 'source'
  | 'executor'
  | 'policy'
  | 'compiler-pass'
  | 'observability'
  | 'redaction-rule';

/** Every capability, for validation and for tests that must stay exhaustive. */
export const PLUGIN_CAPABILITIES: readonly PluginCapability[] = [
  'source',
  'executor',
  'policy',
  'compiler-pass',
  'observability',
  'redaction-rule',
];

/**
 * A telemetry destination contributed by a plugin.
 *
 * §53 names `ObservabilityExporter` in the `PluginContext` signature but does
 * not define it, and no such type existed — the observability package exposes
 * `openTelemetry()` returning an `Observability` (a tracer plus a metric
 * recorder), which is the real seam. So this wraps that: an exporter is an
 * identified `Observability`. Logged to #156 with the epic's other spec-vs-code
 * drift.
 *
 * The `id` is required rather than optional because two exporters registered by
 * different plugins have to be distinguishable in diagnostics; an anonymous
 * exporter that misbehaves is one nobody can attribute.
 */
export interface ObservabilityExporter {
  readonly id: string;
  readonly observability: Observability;
}

export interface PluginManifest {
  readonly name: string;
  /** The PLUGIN's own version. Opaque to the runtime. */
  readonly version: string;
  /**
   * The version of the ASKTURRET plugin API this plugin was built against.
   *
   * Checked against the runtime's supported range at load. See
   * `PLUGIN_API_VERSION`.
   */
  readonly apiVersion: string;
  readonly capabilities: readonly PluginCapability[];
}

/**
 * Everything a plugin may do, and nothing else.
 *
 * Six setters. The omissions are the specification: there is deliberately no
 * accessor for the registry, the dispatcher, the redaction pipeline, or another
 * plugin's registrations.
 *
 * `addRedactionRule` APPENDS. It cannot replace or remove a built-in, because
 * the pipeline evaluates rules in order and takes the first match, and
 * built-ins are already in the list. A plugin rule that tried to "un-redact"
 * something a built-in catches never sees the value.
 */
export interface PluginContext {
  registerSource(source: OperationSource): void;
  registerExecutor(name: string, executor: OperationExecutor): void;
  registerPolicy(policy: Policy): void;
  registerCompilerPass(pass: CompilerPass): void;
  registerObservabilityExporter(exporter: ObservabilityExporter): void;
  addRedactionRule(rule: RedactionRule): void;
}

/** Maps each capability to the method it authorises. */
export interface CapabilityMethodMap {
  source: Pick<PluginContext, 'registerSource'>;
  executor: Pick<PluginContext, 'registerExecutor'>;
  policy: Pick<PluginContext, 'registerPolicy'>;
  'compiler-pass': Pick<PluginContext, 'registerCompilerPass'>;
  observability: Pick<PluginContext, 'registerObservabilityExporter'>;
  'redaction-rule': Pick<PluginContext, 'addRedactionRule'>;
}

/**
 * A `PluginContext` narrowed to the capabilities a plugin declared.
 *
 * This is §53's "typed guard" half. A plugin that types its `setup` with its
 * own capability list gets a COMPILE error for a method it did not declare,
 * which is where a capability mistake is cheapest to find.
 *
 * The runtime assert in `createPluginContext` is the other half and is not
 * redundant with it: types vanish at runtime, plugins arrive as compiled
 * JavaScript from npm, and a manifest can be edited without recompiling.
 * Neither check subsumes the other.
 */
export type ScopedPluginContext<C extends PluginCapability> = C extends unknown
  ? CapabilityMethodMap[C]
  : never;

/**
 * The plugin interface itself.
 *
 * Generic over its capabilities so `setup` receives a context narrowed to
 * exactly what the manifest declared. A plugin may also use the unparameterised
 * form and take the full `PluginContext`; it then relies on the runtime assert
 * alone, which still refuses an undeclared call.
 */
export interface AskTurretPlugin<C extends PluginCapability = PluginCapability> {
  readonly manifest: PluginManifest & { readonly capabilities: readonly C[] };
  setup(context: UnionToIntersection<ScopedPluginContext<C>>): Promise<void>;
}

/**
 * Turn `A | B` into `A & B`.
 *
 * Needed because a plugin declaring two capabilities should receive a context
 * carrying BOTH methods — the union `ScopedPluginContext<'source' | 'policy'>`
 * would let it call neither safely, since a union only exposes common members.
 */
export type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (
  arg: infer I,
) => void
  ? I
  : never;

/**
 * What the plugins collectively registered.
 *
 * Returned as DATA for the adopter to wire, rather than the host reaching into
 * a running server. `createMcpServer` is still a v0.1 stub (#131), so there is
 * no assembled server to inject into — and returning plain data keeps the host
 * honest about that instead of implying an end-to-end wiring that does not
 * exist yet.
 *
 * Every entry records the plugin that contributed it, so a misbehaving
 * registration is attributable without asking each plugin to identify itself.
 */
export interface PluginRegistration<T> {
  readonly plugin: string;
  readonly value: T;
}

export interface PluginRegistrations {
  readonly sources: readonly PluginRegistration<OperationSource>[];
  readonly executors: readonly PluginRegistration<{
    readonly name: string;
    readonly executor: OperationExecutor;
  }>[];
  readonly policies: readonly PluginRegistration<Policy>[];
  readonly compilerPasses: readonly PluginRegistration<CompilerPass>[];
  readonly observabilityExporters: readonly PluginRegistration<ObservabilityExporter>[];
  readonly redactionRules: readonly PluginRegistration<RedactionRule>[];
}
