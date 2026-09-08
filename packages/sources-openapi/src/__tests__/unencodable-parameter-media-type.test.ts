/**
 * A parameter dropped for an unencodable media type names THAT cause (#768)
 *
 * PR #767 taught the reader to accept `content`-form query parameters
 * serialised as `application/json`. A parameter declaring any OTHER media type
 * still drops, correctly — the executor has no encoder for it, and serving one
 * anyway would put a malformed request on the wire.
 *
 * The defect was the REASON given. The drop reported `MISSING_INPUT_SCHEMA`:
 * true in effect, since no schema we can serve exists, but false in fact,
 * because a schema WAS present and readable. Someone debugging their spec was
 * told a schema is missing from a document that plainly contains one.
 *
 * ## Why this drives the whole compile path
 *
 * The cause is known at the DROP SITE, in this package, and the message is
 * emitted by a pass in `core` that sees only the absence. Testing either half
 * alone would pass while the wiring between them was broken — the reason lives
 * in `hints`, and a test of the pass with a hand-built hint proves nothing about
 * whether this reader ever sets it.
 *
 * So each case compiles a real spec end to end and reads the warnings the
 * compiler actually collected. That is also the channel #762 will consume, so
 * this asserts it at the level that issue depends on.
 *
 * ## The last case is the discriminator, not padding
 *
 * Two of these cases produce an operation with no input; only the CAUSE differs.
 * Asserting each code in isolation would still pass if both collapsed back into
 * one code, so the codes are compared directly.
 */

import { describe, it, expect } from '@jest/globals';
import type { DiscoveryContext, CompilerWarning } from '@askturret/mcp-core';
import { createCompiler } from '@askturret/mcp-core';
import { fromOpenApi } from '../from-openapi.js';

/** A logger that records the warnings the compiler hands it. */
function recordingContext(): { context: DiscoveryContext; warnings: CompilerWarning[] } {
  const warnings: CompilerWarning[] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    error: () => {},
    warn: (_message: string, meta?: unknown) => {
      const collected = (meta as { warnings?: CompilerWarning[] } | undefined)?.warnings;
      if (Array.isArray(collected)) warnings.push(...collected);
    },
  };
  return {
    context: { logger, abortSignal: new AbortController().signal } as DiscoveryContext,
    warnings,
  };
}

/** Build a one-operation spec around the supplied parameter list. */
function specWithParameters(parameters: unknown[]): Record<string, unknown> {
  return {
    openapi: '3.0.0',
    info: { title: 'Unencodable parameter probe', version: '1.0.0' },
    servers: [{ url: 'http://127.0.0.1:9099/api' }],
    paths: {
      '/things': {
        get: {
          operationId: 'listThings',
          description: 'Lists things',
          parameters,
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    },
  };
}

/** Discover from the spec, compile it, and return the warnings that resulted. */
async function warningsFor(parameters: unknown[]): Promise<CompilerWarning[]> {
  const { context, warnings } = recordingContext();
  const discovered = await fromOpenApi(specWithParameters(parameters)).discover(context);
  await createCompiler().compile(discovered, {
    logger: context.logger,
    overlays: [],
    preset: 'balanced',
  });
  return warnings;
}

const codes = (warnings: CompilerWarning[]): string[] => warnings.map((w) => w.code);

describe('a parameter dropped for an unencodable media type (#768)', () => {
  it('reports UNENCODABLE_INPUT_MEDIA_TYPE, not MISSING_INPUT_SCHEMA', async () => {
    const warnings = await warningsFor([
      {
        name: 'filter',
        in: 'query',
        content: { 'application/xml': { schema: { type: 'object' } } },
      },
    ]);

    expect(codes(warnings)).toContain('UNENCODABLE_INPUT_MEDIA_TYPE');
    expect(codes(warnings)).not.toContain('MISSING_INPUT_SCHEMA');
  });

  it('names the media type it could not encode, and the parameter carrying it', async () => {
    const warnings = await warningsFor([
      {
        name: 'filter',
        in: 'query',
        content: { 'application/xml': { schema: { type: 'object' } } },
      },
    ]);

    const warning = warnings.find((w) => w.code === 'UNENCODABLE_INPUT_MEDIA_TYPE');
    // The media type is the actionable part for whoever wrote the spec: it is
    // what they change to make the operation servable.
    expect(warning?.message).toContain('application/xml');
    expect(warning?.message).toContain('filter');
    // ...and it must not repeat the falsehood it replaces.
    expect(warning?.message).not.toMatch(/missing required 'input' schema/);
  });

  it('still says MISSING_INPUT_SCHEMA when the schema is genuinely absent', async () => {
    // A named parameter with neither `schema` nor `content`. Nothing was
    // declared, so "missing" is the honest word and must survive.
    const warnings = await warningsFor([{ name: 'filter', in: 'query' }]);

    expect(codes(warnings)).toContain('MISSING_INPUT_SCHEMA');
    expect(codes(warnings)).not.toContain('UNENCODABLE_INPUT_MEDIA_TYPE');
  });

  it('THE DISCRIMINATOR: the two causes do not share a code', async () => {
    // Both operations compile to no input. If a later edit collapses the two
    // back into one code, every assertion above still passes for one of them —
    // this is the one that cannot.
    const unencodable = await warningsFor([
      { name: 'filter', in: 'query', content: { 'application/xml': { schema: { type: 'object' } } } },
    ]);
    const missing = await warningsFor([{ name: 'filter', in: 'query' }]);

    const unencodableCode = unencodable.find((w) => w.message.includes('listThings'))?.code;
    const missingCode = missing.find((w) => w.message.includes('listThings'))?.code;

    expect(unencodableCode).toBeDefined();
    expect(missingCode).toBeDefined();
    expect(unencodableCode).not.toBe(missingCode);
  });

  it('a servable application/json content parameter warns about neither', async () => {
    // The control. Without it, both codes above are satisfied by a reader that
    // dropped every `content`-form parameter — which is the #718 defect, and
    // exactly what these warnings would then be describing.
    const warnings = await warningsFor([
      {
        name: 'filter',
        in: 'query',
        content: { 'application/json': { schema: { type: 'object' } } },
      },
    ]);

    expect(codes(warnings)).not.toContain('UNENCODABLE_INPUT_MEDIA_TYPE');
    expect(codes(warnings)).not.toContain('MISSING_INPUT_SCHEMA');
  });

  it('offering application/json alongside an unencodable type is servable, and silent', async () => {
    // The media type we can encode is present, so nothing was dropped for one we
    // cannot. Reporting the sibling type here would be a new wrong cause.
    const warnings = await warningsFor([
      {
        name: 'filter',
        in: 'query',
        content: {
          'application/xml': { schema: { type: 'object' } },
          'application/json': { schema: { type: 'object' } },
        },
      },
    ]);

    expect(codes(warnings)).not.toContain('UNENCODABLE_INPUT_MEDIA_TYPE');
    expect(codes(warnings)).not.toContain('MISSING_INPUT_SCHEMA');
  });
});
