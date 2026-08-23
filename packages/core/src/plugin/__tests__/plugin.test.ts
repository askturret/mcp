// SPDX-License-Identifier: Apache-2.0
/**
 * Plugin API tests (§6, ADR-018, #53).
 *
 * The four §53 names, plus the half that is easy to skip: the things a plugin
 * must NOT be able to do. Those are enforced by ABSENCE — no method exists that
 * would let a plugin mutate a snapshot or reach another plugin's state — and
 * absence is exactly what a test suite forgets to check, because there is
 * nothing to call. So the surface itself is pinned: a future method that
 * quietly widened it would fail here.
 */

import { describe, it, expect } from '@jest/globals';

import {
  applyPluginRedactionRules,
  createPluginContext,
  isPluginApiCompatible,
  loadPlugins,
  parseSemVer,
  PluginRefusedError,
} from '../host.js';
import {
  PLUGIN_API_VERSION,
  PLUGIN_CAPABILITIES,
  type AskTurretPlugin,
  type PluginCapability,
  type PluginContext,
} from '../types.js';
import { createRedactionPipeline } from '../../redaction/pipeline.js';
import type { OperationSource } from '../../sources/types.js';
import type { RedactionRule } from '../../redaction/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function plugin(
  name: string,
  capabilities: readonly PluginCapability[],
  setup: (context: PluginContext) => Promise<void>,
  overrides?: { apiVersion?: string },
): AskTurretPlugin<PluginCapability> {
  return {
    manifest: {
      name,
      version: '1.0.0',
      apiVersion: overrides?.apiVersion ?? PLUGIN_API_VERSION,
      capabilities,
    },
    setup: setup as AskTurretPlugin<PluginCapability>['setup'],
  };
}

const noopSource: OperationSource = {
  id: 'plugin-source',
  discover: async () => [],
};

// ---------------------------------------------------------------------------
// 1. Capability negotiation
// ---------------------------------------------------------------------------

describe('capability negotiation', () => {
  it('refuses a register call the manifest did not declare', async () => {
    const rogue = plugin('rogue', ['observability'], async (context) => {
      context.registerExecutor('sneaky', { execute: async () => ({ ok: true, value: {} }) });
    });

    await expect(loadPlugins([rogue])).rejects.toThrow(PluginRefusedError);
  });

  it('names the plugin, the method and what WAS declared', async () => {
    const rogue = plugin('rogue', ['observability'], async (context) => {
      context.registerExecutor('sneaky', { execute: async () => ({ ok: true, value: {} }) });
    });

    // The message is what an operator reads at 3am, so it has to carry all
    // three: who, what they tried, and what they were allowed.
    await expect(loadPlugins([rogue])).rejects.toThrow(/rogue/);
    await expect(loadPlugins([rogue])).rejects.toThrow(/registerExecutor/);
    await expect(loadPlugins([rogue])).rejects.toThrow(/observability/);
  });

  it('allows a call the manifest DID declare', async () => {
    const good = plugin('good', ['source'], async (context) => {
      context.registerSource(noopSource);
    });

    const registrations = await loadPlugins([good]);

    expect(registrations.sources).toHaveLength(1);
    expect(registrations.sources[0]?.plugin).toBe('good');
  });

  it('refuses an unknown capability BEFORE setup runs', async () => {
    let setupRan = false;
    const weird = plugin('weird', ['telepathy' as PluginCapability], async () => {
      setupRan = true;
    });

    await expect(loadPlugins([weird])).rejects.toThrow(PluginRefusedError);
    // The point of refusing early: a manifest we cannot interpret must not get
    // to execute a line.
    expect(setupRan).toBe(false);
  });

  it('enforces every capability, with no gaps in the map', async () => {
    // Exhaustive by construction. A seventh capability added to the union
    // without a matching runtime assert would leave a method unguarded, and
    // that gap is invisible to any test that lists methods by hand.
    const calls: Record<PluginCapability, (c: PluginContext) => void> = {
      source: (c) => c.registerSource(noopSource),
      executor: (c) => c.registerExecutor('x', { execute: async () => ({ ok: true, value: {} }) }),
      policy: (c) =>
        c.registerPolicy({ id: 'p', evaluate: async () => ({ effect: 'allow', evidence: [] }) }),
      'compiler-pass': (c) => c.registerCompilerPass({ name: 'pass', run: async (ops) => ops }),
      observability: (c) =>
        c.registerObservabilityExporter({
          id: 'e',
          observability: {
            tracer: { startSpan: () => ({}) as never },
            metrics: { add: () => {}, record: () => {}, set: () => {} },
          } as never,
        }),
      'redaction-rule': (c) =>
        c.addRedactionRule({ id: 'r', matches: () => false, transform: (v) => v }),
    };

    for (const capability of PLUGIN_CAPABILITIES) {
      const invoke = calls[capability];

      // Declared → permitted.
      const permitted = plugin(`ok-${capability}`, [capability], async (c) => invoke(c));
      await expect(loadPlugins([permitted])).resolves.toBeDefined();

      // Not declared → refused. Declaring a DIFFERENT capability rather than
      // none, so this cannot pass merely because the plugin declared nothing.
      const other: PluginCapability = capability === 'source' ? 'policy' : 'source';
      const refused = plugin(`no-${capability}`, [other], async (c) => invoke(c));
      await expect(loadPlugins([refused])).rejects.toThrow(PluginRefusedError);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. API version discipline
// ---------------------------------------------------------------------------

describe('apiVersion discipline', () => {
  it('parses MAJOR.MINOR.PATCH and rejects nonsense', () => {
    expect(parseSemVer('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemVer('1.2.3-beta.1')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemVer('1.2')).toBeUndefined();
    expect(parseSemVer('latest')).toBeUndefined();
    expect(parseSemVer('')).toBeUndefined();
  });

  it('accepts an OLDER plugin on a newer runtime', () => {
    // The API is additive within a major, so everything a 1.0 plugin calls
    // still exists on 1.2.
    expect(isPluginApiCompatible('1.0.0', '1.2.0')).toBe(true);
    expect(isPluginApiCompatible('1.2.0', '1.2.0')).toBe(true);
  });

  it('refuses a NEWER plugin on an older runtime', () => {
    // The asymmetry is the whole point: a 1.2 plugin may call a method 1.0
    // does not have, which would fail as `undefined is not a function` deep
    // inside setup, after partial registration.
    expect(isPluginApiCompatible('1.2.0', '1.0.0')).toBe(false);
  });

  it('refuses across a MAJOR, in both directions', () => {
    expect(isPluginApiCompatible('2.0.0', '1.0.0')).toBe(false);
    expect(isPluginApiCompatible('1.0.0', '2.0.0')).toBe(false);
  });

  it('ignores PATCH entirely', () => {
    // A patch bump that changed what a plugin may call would be a mislabelled
    // release; honouring it here would encourage one.
    expect(isPluginApiCompatible('1.0.9', '1.0.0')).toBe(true);
    expect(isPluginApiCompatible('1.0.0', '1.0.9')).toBe(true);
  });

  it('refuses an out-of-range plugin at LOAD, before setup runs', async () => {
    let setupRan = false;
    const future = plugin('from-the-future', ['source'], async () => {
      setupRan = true;
    }, { apiVersion: '2.0.0' });

    await expect(loadPlugins([future], { runtimeApiVersion: '1.0.0' })).rejects.toThrow(
      PluginRefusedError,
    );
    // Load-time, not setup-time: a plugin speaking an API we do not must not
    // execute a line.
    expect(setupRan).toBe(false);
  });

  it('explains the mismatch with both versions and a way forward', async () => {
    const future = plugin('from-the-future', ['source'], async () => {}, {
      apiVersion: '2.0.0',
    });

    await expect(loadPlugins([future], { runtimeApiVersion: '1.0.0' })).rejects.toThrow(/2\.0\.0/);
    await expect(loadPlugins([future], { runtimeApiVersion: '1.0.0' })).rejects.toThrow(/1\.0\.0/);
    await expect(loadPlugins([future], { runtimeApiVersion: '1.0.0' })).rejects.toThrow(/Upgrade/i);
  });

  it('refuses an unparseable apiVersion rather than guessing', async () => {
    const vague = plugin('vague', ['source'], async () => {}, { apiVersion: 'latest' });

    await expect(loadPlugins([vague])).rejects.toThrow(PluginRefusedError);
  });

  it('is distinct from the package version', () => {
    // §53 requires the two to be separate. Pinned so a release script that
    // "helpfully" synced them would fail here rather than silently making
    // every package release a plugin-API break.
    expect(PLUGIN_API_VERSION).toBe('1.0.0');
  });
});

// ---------------------------------------------------------------------------
// 3. Registration reaches the compiler input
// ---------------------------------------------------------------------------

describe('registered sources reach the compiler input', () => {
  it('surfaces a plugin OperationSource, attributed to its plugin', async () => {
    const discovered = [{ id: 'fromPlugin' }] as never;
    const source: OperationSource = { id: 'plugin-src', discover: async () => discovered };

    const registrations = await loadPlugins([
      plugin('src-plugin', ['source'], async (c) => c.registerSource(source)),
    ]);

    expect(registrations.sources).toHaveLength(1);
    const registered = registrations.sources[0];
    expect(registered?.plugin).toBe('src-plugin');

    // The source is usable as compiler INPUT — the thing §53 actually asks
    // for. Asserting the object came back would not show that.
    await expect(registered?.value.discover({} as never)).resolves.toBe(discovered);
  });

  it('preserves registration ORDER across plugins', async () => {
    const registrations = await loadPlugins([
      plugin('first', ['compiler-pass'], async (c) =>
        c.registerCompilerPass({ name: 'a', run: async (ops) => ops }),
      ),
      plugin('second', ['compiler-pass'], async (c) =>
        c.registerCompilerPass({ name: 'b', run: async (ops) => ops }),
      ),
    ]);

    // Order is observable — passes run in sequence — so loading must be
    // deterministic. Concurrent setup would make this depend on which promise
    // resolved first.
    expect(registrations.compilerPasses.map((p) => p.value.name)).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// 4. Redaction: plugins EXTEND, never replace
// ---------------------------------------------------------------------------

describe('plugin redaction rules extend, never replace', () => {
  it('lets a plugin rule redact something the built-ins miss', async () => {
    const pipeline = createRedactionPipeline();
    const registrations = await loadPlugins([
      plugin('redactor', ['redaction-rule'], async (c) =>
        c.addRedactionRule({
          id: 'acme-employee-id',
          matches: (_context, value) => typeof value === 'string' && value.startsWith('ACME-'),
          transform: () => '[REDACTED]',
        }),
      ),
    ]);

    applyPluginRedactionRules(pipeline, registrations);

    const out = pipeline.redact(
      { employee: 'ACME-12345' },
      { surface: 'audit', path: [] },
    ) as Record<string, unknown>;

    expect(out['employee']).toBe('[REDACTED]');
  });

  it('CANNOT un-redact what a built-in already catches', async () => {
    const pipeline = createRedactionPipeline();
    const before = pipeline.rules().length;

    const registrations = await loadPlugins([
      plugin('malicious', ['redaction-rule'], async (c) =>
        c.addRedactionRule({
          id: 'passthrough',
          // Matches everything and returns it untouched — the shape of a rule
          // written to defeat redaction.
          matches: () => true,
          transform: (value) => value,
        }),
      ),
    ]);

    applyPluginRedactionRules(pipeline, registrations);

    const out = pipeline.redact(
      { apiKey: 'sk_live_abcdef123456' },
      { surface: 'audit', path: [] },
    ) as Record<string, unknown>;

    // This is the test that found the hole, and ORDERING ALONE DOES NOT PASS
    // IT. The pipeline evaluates rules at every node including the ROOT, and a
    // match returns transform(value) without descending — so a match-everything
    // rule claimed the root object, returned it untouched, and every secret
    // inside survived while every built-in remained installed.
    //
    // It passes because plugin rules are constrained to LEAF values, so the
    // container falls through to the walk and the built-ins get their turn.
    expect(out['apiKey']).not.toBe('sk_live_abcdef123456');

    // And it was genuinely ADDED, not silently dropped: the guarantee is that
    // it cannot win, not that it was refused.
    expect(pipeline.rules().length).toBe(before + 1);
  });

  it('cannot short-circuit the walk by claiming a NESTED container either', async () => {
    // The root case above is the obvious one. This is the same hazard one
    // level down: a rule matching `{ credentials: {...} }` would stop the
    // descent before the built-ins reached the token inside it.
    const pipeline = createRedactionPipeline();
    const registrations = await loadPlugins([
      plugin('nested-passthrough', ['redaction-rule'], async (c) =>
        c.addRedactionRule({
          id: 'claim-objects',
          matches: (_context, value) => typeof value === 'object' && value !== null,
          transform: (value) => value,
        }),
      ),
    ]);

    applyPluginRedactionRules(pipeline, registrations);

    const out = pipeline.redact(
      { outer: { credentials: { apiKey: 'sk_live_abcdef123456' } } },
      { surface: 'audit', path: [] },
    ) as Record<string, Record<string, Record<string, unknown>>>;

    expect(out['outer']?.['credentials']?.['apiKey']).not.toBe('sk_live_abcdef123456');
  });

  it('still lets a plugin rule redact leaves inside a container', async () => {
    // The constraint narrows WHAT a plugin rule may claim, not its coverage:
    // it applies to each leaf individually instead of the whole subtree.
    const pipeline = createRedactionPipeline();
    const registrations = await loadPlugins([
      plugin('leafy', ['redaction-rule'], async (c) =>
        c.addRedactionRule({
          id: 'acme-ids',
          matches: (_context, value) => typeof value === 'string' && value.startsWith('ACME-'),
          transform: () => '[REDACTED]',
        }),
      ),
    ]);

    applyPluginRedactionRules(pipeline, registrations);

    const out = pipeline.redact(
      { nested: { employee: 'ACME-1', other: 'keep-me' } },
      { surface: 'audit', path: [] },
    ) as Record<string, Record<string, unknown>>;

    expect(out['nested']?.['employee']).toBe('[REDACTED]');
    expect(out['nested']?.['other']).toBe('keep-me');
  });

  it('cannot remove a built-in rule — there is no method that would', () => {
    const pipeline = createRedactionPipeline();
    const builtInIds = pipeline.rules().map((r) => r.id);

    // The PluginContext surface offers `addRedactionRule` and nothing else.
    // No remove, no replace, no setter for the rule list.
    const context = createPluginContext(
      { name: 'p', version: '1.0.0', apiVersion: PLUGIN_API_VERSION, capabilities: ['redaction-rule'] },
      {
        sources: [],
        executors: [],
        policies: [],
        compilerPasses: [],
        observabilityExporters: [],
        redactionRules: [],
      },
    );

    expect(Object.keys(context).filter((k) => /redact/i.test(k))).toEqual(['addRedactionRule']);
    expect(pipeline.rules().map((r) => r.id)).toEqual(builtInIds);
  });
});

// ---------------------------------------------------------------------------
// 5. What plugins CANNOT do — enforced by absence
// ---------------------------------------------------------------------------

describe('the non-negotiables', () => {
  const context = createPluginContext(
    {
      name: 'surface-probe',
      version: '1.0.0',
      apiVersion: PLUGIN_API_VERSION,
      capabilities: [...PLUGIN_CAPABILITIES],
    },
    {
      sources: [],
      executors: [],
      policies: [],
      compilerPasses: [],
      observabilityExporters: [],
      redactionRules: [],
    },
  );

  it('exposes EXACTLY six methods and nothing else', () => {
    // The omissions are the specification, and absence is what a test suite
    // forgets to check — there is nothing to call. Pinning the surface means a
    // future `getDispatcher()` fails here instead of shipping.
    expect(Object.keys(context).sort()).toEqual([
      'addRedactionRule',
      'registerCompilerPass',
      'registerExecutor',
      'registerObservabilityExporter',
      'registerPolicy',
      'registerSource',
    ]);
  });

  it.each([
    ['registry snapshot mutation', /registry|snapshot|swap/i],
    ['dispatcher internals', /dispatch|stage|envelope/i],
    ['redaction pipeline internals', /pipeline|removeRedaction|replaceRedaction/i],
    ['other plugins', /plugins|registrations|otherPlugin/i],
  ])('offers no way to reach %s', (_label, forbidden) => {
    expect(Object.keys(context).filter((key) => forbidden.test(key))).toEqual([]);
  });

  it('gives each plugin its own context, so one cannot read another', async () => {
    const contexts: PluginContext[] = [];

    await loadPlugins([
      plugin('a', ['source'], async (c) => {
        contexts.push(c);
        c.registerSource(noopSource);
      }),
      plugin('b', ['source'], async (c) => {
        contexts.push(c);
      }),
    ]);

    // Distinct objects, and neither carries a reference through which the
    // shared accumulator could be read. Plugin B cannot see that A registered
    // anything: the accumulator is captured in a closure, not exposed.
    expect(contexts[0]).not.toBe(contexts[1]);
    for (const c of contexts) {
      expect(Object.values(c).every((v) => typeof v === 'function')).toBe(true);
    }
  });

  it('refuses two plugins sharing a name, since attribution is by name', async () => {
    const first = plugin('same-name', ['source'], async (c) => c.registerSource(noopSource));
    const second = plugin('same-name', ['source'], async (c) => c.registerSource(noopSource));

    await expect(loadPlugins([first, second])).rejects.toThrow(PluginRefusedError);
  });

  it('attributes every registration to the plugin that made it', async () => {
    const registrations = await loadPlugins([
      plugin('alpha', ['source'], async (c) => c.registerSource(noopSource)),
      plugin('beta', ['redaction-rule'], async (c) =>
        c.addRedactionRule({ id: 'b', matches: () => false, transform: (v) => v } as RedactionRule),
      ),
    ]);

    expect(registrations.sources[0]?.plugin).toBe('alpha');
    expect(registrations.redactionRules[0]?.plugin).toBe('beta');
  });
});
