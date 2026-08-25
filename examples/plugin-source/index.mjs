// SPDX-License-Identifier: Apache-2.0
/**
 * Writing a SOURCE plugin (§6, ADR-018, #270).
 *
 * `examples/plugin-otel-exporter/` shows the exporter seam and loads a plugin
 * that lives in `@askturret/mcp-observability`. This one is the other common
 * case — contributing OPERATIONS — and the plugin is written here, inline,
 * because a source plugin is adopter code by definition. There is no shipped
 * reference source to load; what an adopter needs to see is the file they will
 * write themselves.
 *
 * Everything below is the whole lifecycle, in order:
 *
 *   1. Declare        — the manifest, and why `capabilities` is a promise
 *   2. Implement      — an `OperationSource` and what `discover` must return
 *   3. Register       — `context.registerSource` inside `setup`
 *   4. Use            — feed what was registered into the real compiler
 *   5. Watch it fail  — the capability gate refusing an undeclared call
 *
 * Run it:
 *
 *   npm run build -w packages/core
 *   node examples/plugin-source/index.mjs
 */

import {
  createCompiler,
  loadPlugins,
  PLUGIN_API_VERSION,
} from '@askturret/mcp-core';

// A logger is required by both the discovery and compiler contexts. In a real
// deployment this is your structured logger; the shape is all core needs.
const quietLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

// ---------------------------------------------------------------------------
// 1. Declare the plugin
// ---------------------------------------------------------------------------
//
// `capabilities` is not documentation. It is a promise the runtime holds you
// to: declare `source` and you may call `registerSource` and nothing else.
// Section 5 below shows what happens when a plugin reaches past it.
//
// `apiVersion` must match the runtime's `PLUGIN_API_VERSION`. Loading refuses
// on a mismatch rather than hoping the shapes still line up.

const manifest = {
  name: 'inventory-source',
  version: '1.0.0',
  apiVersion: PLUGIN_API_VERSION,
  capabilities: ['source'],
};

// ---------------------------------------------------------------------------
// 2. Implement the source
// ---------------------------------------------------------------------------
//
// An `OperationSource` is two things: an `id`, and a `discover` that returns
// `DiscoveredOperation[]`.
//
// `discover` receives a `DiscoveryContext` — a logger, an `abortSignal` you
// should check if discovery is slow, and optional adapter extensions. Here the
// operations are hard-coded; a real source would read a spec file, walk a route
// table, or call an internal catalogue over HTTP.
//
// Duplicates are FINE. Deduplication and conflict resolution belong to the
// compiler, not to you — `candidateId` is a candidate, not a decision.

const inventorySource = {
  id: 'inventory-catalogue',

  async discover(context) {
    context.logger.info('discovering inventory operations');

    // A slow source should bail out when asked to. Cheap to honour, and the
    // reason `abortSignal` is on the context at all.
    if (context.abortSignal.aborted) return [];

    return [
      {
        candidateId: 'inventory.getItem',
        name: 'getInventoryItem',
        description: 'Look up a single inventory item by SKU.',
        rawInput: {
          type: 'object',
          properties: { sku: { type: 'string' } },
          required: ['sku'],
        },
        rawOutput: {
          type: 'object',
          properties: { sku: { type: 'string' }, onHand: { type: 'number' } },
        },
        // Where this came from. Carried into provenance, so "why is this
        // operation here?" stays answerable (ADR-019).
        source: { kind: 'inventory-catalogue', location: 'catalogue://items' },
        // Effect metadata you already know. Anything you omit is inferred
        // safety-first by the compiler (ADR-006) — declaring a read as
        // read-only is how it becomes retryable.
        effects: { readOnly: true, idempotent: true, retryable: true },
        // How it executes. `type` selects the executor strategy; `config` is
        // opaque to the canonical model.
        executor: { type: 'http', config: { method: 'GET', path: '/items/{sku}' } },
      },
      {
        candidateId: 'inventory.adjustStock',
        name: 'adjustInventoryStock',
        description: 'Adjust the on-hand count for a SKU.',
        rawInput: {
          type: 'object',
          properties: { sku: { type: 'string' }, delta: { type: 'number' } },
          required: ['sku', 'delta'],
        },
        rawOutput: { type: 'object', properties: { onHand: { type: 'number' } } },
        source: { kind: 'inventory-catalogue', location: 'catalogue://items' },
        // Deliberately NOT marked retryable. Replaying a stock adjustment
        // double-counts it, and the safety-first default is what you want here.
        effects: { readOnly: false, idempotent: false, retryable: false },
        executor: { type: 'http', config: { method: 'POST', path: '/items/{sku}/adjust' } },
      },
    ];
  },
};

// ---------------------------------------------------------------------------
// 3. Register it
// ---------------------------------------------------------------------------
//
// `setup` receives a `PluginContext` of SCOPED SETTERS — never a handle on the
// registry, the compiler, or anything else the runtime owns. That is the whole
// plugin design in one line, and it is why a plugin cannot break the runtime's
// invariants even by accident (ADR-018).

const inventoryPlugin = {
  manifest,
  async setup(context) {
    context.registerSource(inventorySource);
  },
};

const registrations = await loadPlugins([inventoryPlugin]);

console.log(`runtime plugin API: ${PLUGIN_API_VERSION}`);
console.log(
  'registered sources:',
  registrations.sources.map((s) => `${s.value.id} (from ${s.plugin})`),
);

// Nothing else was registered — the manifest declared one capability.
console.log('executors:', registrations.executors.length);
console.log('policies:', registrations.policies.length);

// ---------------------------------------------------------------------------
// 4. Use what it contributed
// ---------------------------------------------------------------------------
//
// This is the part that makes the example worth running rather than reading:
// the operations go through the REAL compiler and come out as a real registry
// snapshot. If the plugin seam ever stopped producing usable compiler input,
// this section would fail rather than print something plausible.

const discovered = [];
for (const registration of registrations.sources) {
  const operations = await registration.value.discover({
    logger: quietLogger,
    abortSignal: new AbortController().signal,
  });
  discovered.push(...operations);
}

const snapshot = await createCompiler().compile(discovered, {
  logger: quietLogger,
  overlays: [],
  preset: 'production',
});

console.log(`\ncompiled ${snapshot.operations.size} operation(s)`);
for (const [id, operation] of snapshot.operations) {
  console.log(`  ${id}  ${operation.name}  retryable=${operation.effects.retryable}`);
}
// A content-addressed hash over the contract fields, stable across processes
// (ADR-004). Two runs of this file print the same value.
console.log(`registry hash: ${snapshot.hash}`);

// ---------------------------------------------------------------------------
// 5. Watch the capability gate refuse an undeclared call
// ---------------------------------------------------------------------------
//
// The same shape as the exporter example's section 3, from the other side: a
// plugin that declares `source` and then reaches for an executor. Refused at
// setup, by name, before anything is registered.

const overreaching = {
  manifest: {
    name: 'overreaching-source',
    version: '0.1.0',
    apiVersion: PLUGIN_API_VERSION,
    capabilities: ['source'],
  },
  async setup(context) {
    context.registerSource(inventorySource);
    context.registerExecutor('sneaky', { execute: async () => ({ ok: true, value: {} }) });
  },
};

try {
  await loadPlugins([overreaching]);
  console.error('UNEXPECTED: the over-reaching plugin was allowed');
  process.exitCode = 1;
} catch (error) {
  console.log('\nrefused, as intended:');
  console.log(`  ${error.message}`);
}
