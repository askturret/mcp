// SPDX-License-Identifier: Apache-2.0
/**
 * Overlays and provenance (§5.3, ADR-019, #55).
 *
 * §55 names four tests. Three are here; the fourth ("Explorer shows correct
 * precedence per field") is the sibling UI issue's, and what this suite owes it
 * is that the DATA is resolvable — which the provenance assertions check.
 *
 * The YAML reader gets its own section, and most of it is about what it
 * REFUSES. A hand-written parser is only defensible if it never guesses, so the
 * refusals are the load-bearing tests, not the successes.
 */

import { describe, it, expect } from '@jest/globals';

import { parseYamlSubset, YamlParseError } from '../yaml.js';
import { parseOverlay, loadOverlay, validateOverlayDocument } from '../load.js';
import {
  applyOverlaysToOperation,
  jsonMergePatch,
  provenanceEntries,
  unmatchedOverlayIds,
  type OverlayTarget,
} from '../merge.js';
import {
  OverlayValidationError,
  outranks,
  provenanceRank,
  type OverlayConflict,
  type OverlayDocument,
} from '../types.js';
import { applyOverlays } from '../../compiler/passes/apply-overlays.js';
import type { CompiledOperation, CompilerContext, CompilerWarning } from '../../compiler/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OVERLAY_YAML = `# askturret.mcp.yaml
version: 1
operations:
  createOrder:
    description: |
      Places a new order for the authenticated customer.
      Requires a valid product ID and quantity.
    effects:
      classifications: [financial]
      idempotencyKeyRequired: true
    visibility:
      requirePermissions: [orders:write]
`;

function overlay(
  location: string,
  operations: OverlayDocument['operations'],
): OverlayDocument {
  return { version: 1, operations, location };
}

function target(overrides: Partial<OverlayTarget> = {}): OverlayTarget {
  return {
    id: 'createOrder',
    name: 'createOrder',
    description: 'From the spec.',
    effects: { readOnly: false },
    ...overrides,
  };
}

function context(overlays: readonly unknown[]): {
  ctx: CompilerContext;
  warnings: CompilerWarning[];
} {
  const warnings: CompilerWarning[] = [];
  const ctx = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    warnings: { warn: (w: CompilerWarning) => warnings.push(w), getWarnings: () => warnings },
    overlays,
    preset: 'light',
  } as unknown as CompilerContext;
  return { ctx, warnings };
}

// ---------------------------------------------------------------------------
// The YAML subset — mostly about what it refuses
// ---------------------------------------------------------------------------

describe('the YAML subset reader', () => {
  it('reads §55\'s documented overlay format', () => {
    const parsed = parseYamlSubset(OVERLAY_YAML) as Record<string, any>;

    expect(parsed['version']).toBe(1);
    const op = parsed['operations']['createOrder'];
    // A `|` block scalar keeps its newline.
    expect(op['description']).toContain('Places a new order');
    expect(op['description']).toContain('Requires a valid product ID');
    expect(op['effects']['idempotencyKeyRequired']).toBe(true);
  });

  it('reads block sequences, nested mappings, quotes and comments', () => {
    const parsed = parseYamlSubset(
      [
        'version: 1        # trailing comment',
        'operations:',
        '  a:',
        '    name: "quoted: with colon"',
        '    effects:',
        '      classifications:',
        '        - financial',
        '        - destructive',
        '      readOnly: false',
      ].join('\n'),
    ) as Record<string, any>;

    expect(parsed['operations']['a']['name']).toBe('quoted: with colon');
    expect(parsed['operations']['a']['effects']['classifications']).toEqual([
      'financial',
      'destructive',
    ]);
    expect(parsed['operations']['a']['effects']['readOnly']).toBe(false);
  });

  it('reads null, ~ and an empty value as null', () => {
    const parsed = parseYamlSubset('a: null\nb: ~\nc:\n') as Record<string, unknown>;
    expect(parsed).toEqual({ a: null, b: null, c: null });
  });

  it.each([
    ['anchors', 'a: &anchor value'],
    ['aliases', 'a: 1\nb: *anchor'],
    ['multiple documents', '---\na: 1'],
    ['directives', '%YAML 1.2\na: 1'],
    ['merge keys', 'a:\n  <<: *base'],
    ['flow mappings', 'a: {b: 1}'],
    // Relabelled in #182. This case is an UNTERMINATED flow sequence, refused
    // for being unterminated — the old label, "flow sequences in a scalar
    // position", read as though flow sequences were refused as a category. They
    // are not: they are supported, and the two cases below pin that. The header
    // in yaml.ts carried the identical misconception, which is what #182 filed.
    ['an unterminated flow sequence', 'a: [1, 2'],
    ['nested flow collections', 'a: [[1], [2]]'],
    // Defended TWICE, which I only found by reverting: with the nested-collection
    // guard removed this case still refuses, because `splitFlow` hands `{b: 1}`
    // to the flow-MAPPING rule. So it does not discriminate that revert the way
    // the `[[1], [2]]` case above does — it pins that the combination is refused
    // by SOME path, not which one. Kept, and labelled, rather than presented as
    // coverage of the nested guard.
    ['a flow mapping nested inside a flow sequence', 'a: [{b: 1}]'],
    ['tab indentation', 'a:\n\tb: 1'],
  ])('REFUSES %s rather than guessing', (_label, text) => {
    // The load-bearing property. A partial YAML parser that silently
    // mis-reads an anchor produces an overlay subtly different from what the
    // adopter wrote — and overlays change what an agent is told it may do, so
    // a mis-read `classifications` is a missing confirmation prompt.
    expect(() => parseYamlSubset(text)).toThrow(YamlParseError);
  });

  it('SUPPORTS a single-level flow sequence, which §55 overlays use', async () => {
    // The other half of the refusal table above, and the reason "flow
    // collections" was the wrong thing for the header to claim (#182).
    //
    // Flow sequences were already exercised INCIDENTALLY — the §55 fixture
    // above writes `classifications: [financial]` — and removing support does
    // redden those three tests. What was missing is a test that says so by
    // NAME: the header's exception was checkable only as a side effect of
    // fixtures that exist to assert something else, so a reader auditing the
    // safety claim had nothing to point at. This is that test.
    //
    // The empty case genuinely had no coverage.
    const parsed = parseYamlSubset(
      ['classifications: [financial, destructive]', 'empty: []'].join('\n'),
    ) as Record<string, unknown>;

    expect(parsed['classifications']).toEqual(['financial', 'destructive']);
    // An empty flow sequence is a sequence, not null — the distinction decides
    // whether an overlay CLEARS classifications or leaves them untouched.
    expect(parsed['empty']).toEqual([]);
  });

  it('names the line it refused on', () => {
    try {
      parseYamlSubset('version: 1\noperations:\n  a: &anchor\n');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(YamlParseError);
      expect((error as YamlParseError).line).toBe(3);
    }
  });

  it('does not treat a # inside a quoted string as a comment', () => {
    const parsed = parseYamlSubset('a: "text # not a comment"') as Record<string, unknown>;
    expect(parsed['a']).toBe('text # not a comment');
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('overlay validation', () => {
  it('accepts the documented format', () => {
    const document = parseOverlay(OVERLAY_YAML, 'askturret.mcp.yaml');

    expect(document.version).toBe(1);
    expect(document.operations['createOrder']?.effects?.classifications).toEqual(['financial']);
  });

  it('parses JSON overlays too', () => {
    const document = parseOverlay(
      JSON.stringify({ version: 1, operations: { a: { description: 'hi' } } }),
      'askturret.mcp.json',
    );
    expect(document.operations['a']?.description).toBe('hi');
  });

  it('rejects an unknown field, naming the valid ones', () => {
    // A typo is likelier than a feature request, and silently ignoring it
    // means the customisation never applies with nothing to say why.
    try {
      validateOverlayDocument(
        { version: 1, operations: { a: { descriptoin: 'typo' } } },
        'o.yaml',
      );
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(OverlayValidationError);
      expect((error as OverlayValidationError).path).toBe('operations.a.descriptoin');
      expect((error as Error).message).toContain('description');
    }
  });

  it('rejects an unsupported version rather than assuming v1 rules', () => {
    expect(() => validateOverlayDocument({ version: 2, operations: {} }, 'o.yaml')).toThrow(
      OverlayValidationError,
    );
  });

  it('rejects a wrongly-typed field', () => {
    expect(() =>
      validateOverlayDocument(
        { version: 1, operations: { a: { effects: { classifications: 'financial' } } } },
        'o.yaml',
      ),
    ).toThrow(OverlayValidationError);
  });

  it('FAILS FAST in strict mode and collects in development', () => {
    // §55's asymmetry. An overlay that silently failed to load in production
    // means the agent sees operations without the classifications or
    // permissions the adopter wrote — a missing confirmation prompt, with
    // nothing anywhere saying so.
    expect(() => loadOverlay('version: 9\noperations:\n', 'o.yaml', 'strict')).toThrow(
      OverlayValidationError,
    );

    const relaxed = loadOverlay('version: 9\noperations:\n', 'o.yaml', 'development');
    expect(relaxed.document).toBeUndefined();
    expect(relaxed.error).toBeInstanceOf(OverlayValidationError);
  });
});

// ---------------------------------------------------------------------------
// JSON Merge Patch
// ---------------------------------------------------------------------------

describe('JSON Merge Patch semantics (RFC 7386)', () => {
  it('merges objects recursively, leaving siblings alone', () => {
    const merged = jsonMergePatch(
      { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } },
      { properties: { a: { description: 'patched' } } },
    ) as any;

    expect(merged.properties.a).toEqual({ type: 'string', description: 'patched' });
    expect(merged.properties.b).toEqual({ type: 'number' }); // untouched
  });

  it('REPLACES arrays rather than merging them', () => {
    // The RFC's rule, and the right one for schemas: merging
    // required:['a','b'] with required:['c'] has no defensible answer, and
    // picking one silently is how a required field goes missing.
    const merged = jsonMergePatch({ required: ['a', 'b'] }, { required: ['c'] }) as any;
    expect(merged.required).toEqual(['c']);
  });

  it('removes a key set to null', () => {
    const merged = jsonMergePatch({ a: 1, b: 2 }, { b: null }) as any;
    expect(merged).toEqual({ a: 1 });
  });
});

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

describe('the §5.3 precedence chain', () => {
  it('ranks the six levels in order', () => {
    expect(outranks('code', 'overlay')).toBe(true);
    expect(outranks('overlay', 'x-mcp')).toBe(true);
    expect(outranks('x-mcp', 'openapi')).toBe(true);
    expect(outranks('openapi', 'inference')).toBe(true);
    expect(outranks('inference', 'preset')).toBe(true);
  });

  it('ranks openapi and framework EQUALLY — both are level 4', () => {
    // §5.3 has six levels; the kind union has seven values because the source
    // definition comes in two flavours. Ranking them apart would make
    // precedence depend on which source a spec happened to come from.
    expect(provenanceRank('openapi')).toBe(provenanceRank('framework'));
    expect(outranks('openapi', 'framework')).toBe(false);
    expect(outranks('framework', 'openapi')).toBe(false);
  });

  it('does not let a lower level overwrite a higher one', () => {
    const conflicts: OverlayConflict[] = [];
    const { operation, provenance } = applyOverlaysToOperation(
      target(),
      [overlay('a.yaml', { createOrder: { description: 'from overlay' } })],
      { description: { kind: 'code', location: 'plugin:acme' } },
      conflicts,
    );

    // An explicit code enhancement outranks an overlay, so the overlay loses
    // and the provenance still names the code.
    expect(operation.description).toBe('From the spec.');
    expect(provenance['description']?.kind).toBe('code');
  });
});

// ---------------------------------------------------------------------------
// §55's named tests
// ---------------------------------------------------------------------------

describe('overlay application (§55 acceptance)', () => {
  it('renames an operation, and provenance names the overlay AND its location', async () => {
    const document = parseOverlay(
      'version: 1\noperations:\n  createOrder:\n    name: placeOrder\n',
      'askturret.mcp.yaml',
    );

    const { ctx } = context([document]);
    const [applied] = (await applyOverlays.run(
      [
        {
          candidateId: 'createOrder',
          name: 'createOrder',
          description: 'From the spec.',
          source: { kind: 'openapi', location: 'petstore.yaml' },
        } as CompiledOperation,
      ],
      ctx,
    )) as CompiledOperation[];

    expect(applied?.name).toBe('placeOrder');

    const entry = applied?.provenance?.find((p) => p.field === 'name');
    expect(entry?.kind).toBe('overlay');
    // A JSON pointer, not just the filename — provenance should point at the
    // line an adopter edits.
    expect(entry?.location).toBe('askturret.mcp.yaml#/operations/createOrder/name');
  });

  it('adds classifications, which is what makes a preset demand confirmation', async () => {
    const document = parseOverlay(OVERLAY_YAML, 'askturret.mcp.yaml');
    const { ctx } = context([document]);

    const [applied] = (await applyOverlays.run(
      [
        {
          candidateId: 'createOrder',
          name: 'createOrder',
          description: 'From the spec.',
          effects: { readOnly: false } as CompiledOperation['effects'],
        } as CompiledOperation,
      ],
      ctx,
    )) as CompiledOperation[];

    // The §55 test is "Production preset now requires confirmation for this
    // op". That is confirmationForEffects(['financial', …]) reading THIS
    // field, so the classification landing here is the part overlays own.
    expect((applied?.effects as Record<string, unknown>)['classifications']).toEqual(['financial']);
    expect((applied?.effects as Record<string, unknown>)['idempotencyKeyRequired']).toBe(true);
    // Untouched sibling survives.
    expect((applied?.effects as Record<string, unknown>)['readOnly']).toBe(false);
  });

  it('gives two overlays a deterministic winner AND records the conflict', async () => {
    const { ctx, warnings } = context([
      { version: 1, location: 'first.yaml', operations: { a: { description: 'first' } } },
      { version: 1, location: 'second.yaml', operations: { a: { description: 'second' } } },
    ]);

    const [applied] = (await applyOverlays.run(
      [{ candidateId: 'a', name: 'a', description: 'spec' } as CompiledOperation],
      ctx,
    )) as CompiledOperation[];

    // Deterministic winner: the later file.
    expect(applied?.description).toBe('second');

    // And the captured warning — the half that is easy to drop and the more
    // important one, because a silent overwrite is indistinguishable from an
    // overlay that never loaded.
    const conflict = warnings.find((w) => w.code === 'OVERLAY_CONFLICT');
    expect(conflict).toBeDefined();
    expect(conflict?.message).toContain('description');
    expect(conflict?.location).toContain('second.yaml');
  });

  it('removes a field set explicitly to null, and says the overlay did it', () => {
    const conflicts: OverlayConflict[] = [];
    const { operation, provenance } = applyOverlaysToOperation(
      target(),
      [overlay('a.yaml', { createOrder: { description: null } })],
      { description: { kind: 'openapi' } },
      conflicts,
    );

    expect(operation.description).toBeUndefined();
    // "The overlay deleted this" and "nobody ever set it" are different
    // answers to "why is this not here?", so the removal is recorded.
    expect(provenance['description']?.kind).toBe('overlay');
  });

  it('warns when an overlay targets an operation that does not exist', async () => {
    const { ctx, warnings } = context([
      { version: 1, location: 'o.yaml', operations: { renamedUpstream: { description: 'x' } } },
    ]);

    await applyOverlays.run(
      [{ candidateId: 'a', name: 'a', description: 'spec' } as CompiledOperation],
      ctx,
    );

    // Silently doing nothing is indistinguishable from working.
    expect(warnings.some((w) => w.code === 'OVERLAY_UNMATCHED_OPERATION')).toBe(true);
  });

  it('leaves operations untouched when there are no overlays', async () => {
    const { ctx, warnings } = context([]);
    const input = [{ candidateId: 'a', name: 'a', description: 'spec' } as CompiledOperation];

    const output = await applyOverlays.run(input, ctx);

    // The stub's old behaviour is preserved exactly for the no-overlay case,
    // which is every existing caller.
    expect(output).toBe(input);
    expect(warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Provenance is resolvable for EVERY field (§55 acceptance)
// ---------------------------------------------------------------------------

describe('provenance is resolvable', () => {
  it('records an entry for every field the compiler established', async () => {
    const { ctx } = context([
      { version: 1, location: 'o.yaml', operations: { a: { description: 'overlaid' } } },
    ]);

    const [applied] = (await applyOverlays.run(
      [
        {
          candidateId: 'a',
          name: 'a',
          description: 'spec',
          rawInput: { type: 'object' },
          effects: { readOnly: true } as CompiledOperation['effects'],
          source: { kind: 'openapi', location: 'petstore.yaml' },
        } as CompiledOperation,
      ],
      ctx,
    )) as CompiledOperation[];

    const fields = (applied?.provenance ?? []).map((p) => p.field);
    expect(fields).toEqual(expect.arrayContaining(['name', 'description', 'input', 'effects.readOnly']));

    // Untouched fields keep their source; the overlaid one names the overlay.
    const byField = Object.fromEntries((applied?.provenance ?? []).map((p) => [p.field, p]));
    expect(byField['description']?.kind).toBe('overlay');
    expect(byField['name']?.kind).toBe('openapi');
    expect(byField['name']?.location).toBe('petstore.yaml');
    expect(byField['effects.readOnly']?.kind).toBe('inference');
  });

  it('sorts entries by field, so a rebuild cannot move the snapshot hash', () => {
    const entries = provenanceEntries({
      zeta: { kind: 'overlay' },
      alpha: { kind: 'openapi' },
      mid: { kind: 'inference' },
    });

    // The registry hash is compared across deployments (#64). A provenance
    // array whose ORDER varied with overlay application order would make two
    // identical registries hash differently.
    expect(entries.map((e) => e.field)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('omits location rather than emitting undefined', () => {
    expect(provenanceEntries({ a: { kind: 'preset' } })).toEqual([{ field: 'a', kind: 'preset' }]);
  });
});

describe('unmatched overlay ids', () => {
  it('reports the pointer, not just the id', () => {
    const missing = unmatchedOverlayIds(
      [overlay('o.yaml', { gone: {} })],
      new Set(['present']),
    );
    expect(missing).toEqual(['o.yaml#/operations/gone']);
  });
});
