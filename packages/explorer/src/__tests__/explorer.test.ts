// SPDX-License-Identifier: Apache-2.0
/**
 * Explorer view-model and HTML rendering tests.
 */

import { describe, it, expect } from '@jest/globals';
import type {
  OperationDefinition,
  RegistrySnapshot,
  EffectMetadata,
} from '@askturret/mcp-core';

import { buildExplorerViewModel } from '../view-model.js';
import { renderExplorerHtml } from '../html.js';

const EFFECTS_READONLY: EffectMetadata = {
  readOnly: true,
  idempotent: true,
  retryable: true,
  idempotencyKeyRequired: false,
  classifications: [],
};

const EFFECTS_MUTATING: EffectMetadata = {
  readOnly: false,
  idempotent: false,
  retryable: false,
  idempotencyKeyRequired: true,
  classifications: ['destructive'],
};

function op(overrides: Partial<OperationDefinition> = {}): OperationDefinition {
  return {
    id: 'listPets',
    name: 'listPets',
    description: 'List all pets',
    input: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many pets to return' },
      },
      required: ['limit'],
    },
    output: {
      type: 'object',
      properties: { pets: { type: 'array', items: { type: 'string' } } },
    },
    effects: EFFECTS_READONLY,
    executor: { type: 'http', config: { baseUrl: 'https://upstream.example.com', apiKey: 'sk-secret' } },
    ...overrides,
  } as OperationDefinition;
}

function snapshot(ops: OperationDefinition[]): RegistrySnapshot {
  return {
    hash: 'sha256:abc123',
    version: 7,
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    operations: new Map(ops.map((o) => [o.id, o])),
  };
}

describe('buildExplorerViewModel', () => {
  it('exposes registry identity in the header', () => {
    const model = buildExplorerViewModel(snapshot([op()]), '/mcp');

    expect(model.header.registryHash).toBe('sha256:abc123');
    expect(model.header.version).toBe(7);
    expect(model.header.createdAt).toBe('2026-01-02T03:04:05.000Z');
    expect(model.header.toolCount).toBe(1);
    expect(model.basePath).toBe('/mcp');
  });

  it('carries the per-tool detail fields tools/list does not return', () => {
    const model = buildExplorerViewModel(snapshot([op()]), '/mcp');
    const tool = model.tools[0]!;

    expect(tool.name).toBe('listPets');
    expect(tool.description).toBe('List all pets');
    // tools/list returns only name/description/inputSchema — the detail view
    // needs these three as well.
    expect(tool.outputSchema).toEqual({
      type: 'object',
      properties: { pets: { type: 'array', items: { type: 'string' } } },
    });
    expect(tool.effects.readOnly).toBe(true);
    expect(tool.executorType).toBe('http');
  });

  it('never exposes executor config, which can hold upstream URLs and secrets', () => {
    const model = buildExplorerViewModel(snapshot([op()]), '/mcp');

    expect(model.tools[0]).not.toHaveProperty('executor');
    expect(JSON.stringify(model)).not.toContain('sk-secret');
    expect(JSON.stringify(model)).not.toContain('upstream.example.com');
  });

  it('reports mutating tools distinctly from read-only ones', () => {
    const model = buildExplorerViewModel(
      snapshot([op({ id: 'deletePet', name: 'deletePet', effects: EFFECTS_MUTATING })]),
      '/mcp',
    );
    const tool = model.tools[0]!;

    expect(tool.effects.readOnly).toBe(false);
    expect(tool.effects.idempotencyKeyRequired).toBe(true);
    expect(tool.effects.classifications).toEqual(['destructive']);
  });

  it('sorts tools by name so the list does not shuffle between restarts', () => {
    const model = buildExplorerViewModel(
      snapshot([
        op({ id: 'zebra', name: 'zebra' }),
        op({ id: 'alpha', name: 'alpha' }),
        op({ id: 'mid', name: 'mid' }),
      ]),
      '/mcp',
    );

    expect(model.tools.map((t) => t.name)).toEqual(['alpha', 'mid', 'zebra']);
  });

  it('handles an empty registry', () => {
    const model = buildExplorerViewModel(snapshot([]), '/mcp');

    expect(model.tools).toEqual([]);
    expect(model.header.toolCount).toBe(0);
  });

  it('renders a createdAt that arrived as a string rather than a Date', () => {
    // Snapshots can be rehydrated from JSON, where createdAt is a string.
    const raw = {
      ...snapshot([op()]),
      createdAt: '2026-01-02T03:04:05.000Z' as unknown as Date,
    };

    expect(buildExplorerViewModel(raw, '/mcp').header.createdAt).toBe('2026-01-02T03:04:05.000Z');
  });
});

describe('renderExplorerHtml', () => {
  it('renders a complete HTML document', () => {
    const html = renderExplorerHtml(buildExplorerViewModel(snapshot([op()]), '/mcp'));

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('AskTurret MCP Explorer');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('embeds the tools and registry identity into the page', () => {
    const html = renderExplorerHtml(buildExplorerViewModel(snapshot([op()]), '/mcp'));

    expect(html).toContain('listPets');
    expect(html).toContain('sha256:abc123');
    expect(html).toContain('window.__EXPLORER__=');
  });

  it('points the invoke panel at the MCP base path, not a private endpoint', () => {
    const html = renderExplorerHtml(buildExplorerViewModel(snapshot([op()]), '/custom-api'));
    const model = JSON.parse(extractModel(html));

    expect(model.basePath).toBe('/custom-api');
    expect(html).toContain("method: 'tools/call'");
  });

  it('escapes angle brackets so a tool description cannot break out of the script tag', () => {
    const hostile = op({
      id: 'evil',
      name: 'evil',
      description: '</script><img src=x onerror=alert(1)>',
    });
    const html = renderExplorerHtml(buildExplorerViewModel(snapshot([hostile]), '/mcp'));

    // The raw closing tag must not survive into the document...
    expect(html).not.toContain('</script><img');
    expect(html).not.toContain('<img src=x');
    // ...but the text must still round-trip intact for display.
    const model = JSON.parse(extractModel(html));
    expect(model.tools[0].description).toBe('</script><img src=x onerror=alert(1)>');
  });

  it('escapes U+2028/U+2029, which are legal in JSON but terminate a JS line', () => {
    const weird = op({ id: 'weird', name: 'weird', description: 'a\u2028b\u2029c' });
    const html = renderExplorerHtml(buildExplorerViewModel(snapshot([weird]), '/mcp'));

    const scriptLine = html.split('\n').find((l) => l.includes('window.__EXPLORER__='))!;
    // The separators must not appear raw inside the script line.
    expect(scriptLine).not.toContain('\u2028');
    expect(scriptLine).not.toContain('\u2029');
    expect(JSON.parse(extractModel(html)).tools[0].description).toBe('a\u2028b\u2029c');
  });

  it('stays far below the 100 KB budget', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      op({ id: `op${i}`, name: `operation_${i}`, description: `Operation number ${i}` }),
    );
    const html = renderExplorerHtml(buildExplorerViewModel(snapshot(many), '/mcp'));

    // Uncompressed; gzip is well under half this.
    expect(Buffer.byteLength(html, 'utf-8')).toBeLessThan(100 * 1024);
  });
});

/**
 * Pull the embedded view model back out of the rendered page.
 */
function extractModel(html: string): string {
  const marker = 'window.__EXPLORER__=';
  const start = html.indexOf(marker) + marker.length;
  const end = html.indexOf(';</script>', start);
  return html
    .slice(start, end)
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>');
}
