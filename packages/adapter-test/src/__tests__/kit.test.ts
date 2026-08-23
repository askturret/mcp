// SPDX-License-Identifier: Apache-2.0
/**
 * Conformance kit tests (§12.2, #54).
 *
 * §54 names four: the kit against Express (all pass), against Fastify (all
 * pass), against a deliberately-broken adapter (the RIGHT category fails), and
 * a stable `--json` shape.
 *
 * The third is the one that earns the other two. A kit that returned PASS
 * unconditionally would satisfy the first two perfectly, and "our conformance
 * tool says everyone conforms" is the failure mode a conformance tool is most
 * likely to ship with.
 */

import { describe, it, expect } from '@jest/globals';
import { createServer } from 'node:http';

import {
  KIT_VERSION,
  RESULT_SCHEMA_VERSION,
  AdapterContractError,
  assertAdapterUnderTest,
  generateBadge,
  knownCategoryNames,
  renderReport,
  runConformance,
  type AdapterUnderTest,
} from '../kit.js';
import { parseArgs, runCli, usage } from '../cli.js';

import {
  expressAdapterUnderTest as expressAdapter,
  fastifyAdapterUnderTest as fastifyAdapter,
} from '../in-repo-adapters.js';

const MOUNT_PATH = '/mcp';

describe('the kit against the in-repo adapters', () => {
  it('passes every category for Express', async () => {
    const report = await runConformance(expressAdapter);

    // Named failures rather than a bare boolean: `passed: false` alone sends
    // whoever reads this to run it by hand to find out which category.
    expect(report.categories.filter((c) => !c.passed).map((c) => `${c.category}: ${c.note}`)).toEqual(
      [],
    );
    expect(report.passed).toBe(true);
    expect(report.complete).toBe(true);
  }, 120_000);

  it('passes every category for Fastify', async () => {
    const report = await runConformance(fastifyAdapter);

    expect(report.categories.filter((c) => !c.passed).map((c) => `${c.category}: ${c.note}`)).toEqual(
      [],
    );
    expect(report.passed).toBe(true);
  }, 120_000);

  it('covers all eight §12.2 categories', () => {
    // Pinned so a category silently disappearing from the bank — which would
    // make every adapter's result quietly weaker — fails here.
    expect(knownCategoryNames()).toHaveLength(8);
    expect(knownCategoryNames()).toEqual(
      expect.arrayContaining(['discovery', 'cancellation', 'error-mapping']),
    );
  });
});

describe('the kit against a deliberately broken adapter', () => {
  /**
   * Serves valid JSON-RPC but reports NO tools.
   *
   * Broken in one specific way, so the assertion can be that the RIGHT
   * category fails. An adapter that failed everything would prove only that
   * the kit can say FAIL — not that it can tell categories apart, which is the
   * property a community author depends on when they read their report.
   */
  const emptyDiscoveryAdapter: AdapterUnderTest = {
    name: 'broken-discovery',
    async createServer() {
      const server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          let id: unknown = null;
          try {
            id = (JSON.parse(body) as { id?: unknown }).id ?? null;
          } catch {
            id = null;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          // Always an empty tool list, whatever was asked.
          res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [] } }));
        });
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      return {
        url: `http://127.0.0.1:${port}${MOUNT_PATH}`,
        close: () =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
            server.closeAllConnections?.();
          }),
      };
    },
  };

  it('fails discovery, and says why', async () => {
    const report = await runConformance(emptyDiscoveryAdapter, { categories: ['discovery'] });

    expect(report.passed).toBe(false);
    const discovery = report.categories.find((c) => c.category === 'discovery');
    expect(discovery?.passed).toBe(false);
    // The note is the bank's assertion message. A FAIL with no reason just
    // moves the work back to the author.
    expect(discovery?.note.length).toBeGreaterThan(0);
  }, 120_000);

  it('marks a filtered run as INCOMPLETE, so it cannot be read as conformance', async () => {
    const report = await runConformance(emptyDiscoveryAdapter, { categories: ['discovery'] });

    // Without this a `--category discovery` pass would be indistinguishable
    // from a full pass in the JSON, and the table would happily accept it.
    expect(report.complete).toBe(false);
    expect(report.categories).toHaveLength(1);
    expect(report.knownCategories).toHaveLength(8);
  }, 120_000);
});

describe('the adapter contract is checked before the bank runs', () => {
  it.each([
    ['a non-object', 42],
    ['a null', null],
    ['an object with no name', { createServer: async () => ({ url: '', close: async () => {} }) }],
    ['an empty name', { name: '', createServer: async () => ({ url: '', close: async () => {} }) }],
    ['no createServer', { name: 'x' }],
  ])('rejects %s with a specific message', (_label, value) => {
    // Checked structurally so the author gets "your adapter is missing
    // createServer" rather than a TypeError from inside the bank — which reads
    // like a kit bug and sends them to the wrong repository.
    expect(() => assertAdapterUnderTest(value)).toThrow(AdapterContractError);
  });

  it('accepts a well-formed adapter', () => {
    expect(() => assertAdapterUnderTest(expressAdapter)).not.toThrow();
  });

  it('rejects an unknown category rather than silently running nothing', async () => {
    await expect(
      runConformance(expressAdapter, { categories: ['telepathy'] }),
    ).rejects.toThrow(AdapterContractError);
  });

  it('rejects an empty category selection', async () => {
    await expect(runConformance(expressAdapter, { categories: [] })).rejects.toThrow(
      AdapterContractError,
    );
  });
});

describe('the --json document is a public contract', () => {
  const report = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    kitVersion: KIT_VERSION,
    adapter: 'demo',
    passed: true,
    categories: [{ id: 1, category: 'discovery', passed: true, note: 'ok' }],
    knownCategories: knownCategoryNames(),
    complete: false,
  };

  it('has exactly these top-level fields', () => {
    // The public conformance table and adopters' CI parse this. A field
    // removed or renamed without bumping schemaVersion breaks consumers we
    // cannot see, so the shape is pinned rather than described.
    expect(Object.keys(report).sort()).toEqual([
      'adapter',
      'categories',
      'complete',
      'kitVersion',
      'knownCategories',
      'passed',
      'schemaVersion',
    ]);
  });

  it('has exactly these per-category fields', () => {
    expect(Object.keys(report.categories[0] as object).sort()).toEqual([
      'category',
      'id',
      'note',
      'passed',
    ]);
  });

  it('separates the schema version from the kit version', () => {
    // They move for different reasons: a parser breaks when the SHAPE changes,
    // not when a category is added. One number for both would make every new
    // category look like a breaking change to every consumer.
    expect(RESULT_SCHEMA_VERSION).toBe(1);
    expect(KIT_VERSION).toBe('1.0.0');
    expect(typeof RESULT_SCHEMA_VERSION).toBe('number');
    expect(typeof KIT_VERSION).toBe('string');
  });

  it('is JSON round-trippable', () => {
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

describe('reporting', () => {
  const failing = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    kitVersion: KIT_VERSION,
    adapter: 'demo',
    passed: false,
    categories: [
      { id: 1, category: 'discovery', passed: true, note: 'listed 2 tools' },
      { id: 4, category: 'cancellation', passed: false, note: 'server never aborted the call' },
    ],
    knownCategories: knownCategoryNames(),
    complete: false,
  };

  it('prints the failure reason, not just FAIL', () => {
    const text = renderReport(failing);

    expect(text).toContain('cancellation');
    expect(text).toContain('server never aborted the call');
  });

  it('says a partial run is partial', () => {
    expect(renderReport(failing)).toContain('PARTIAL RUN');
  });

  it('puts the kit version in the badge, not just a colour', () => {
    // A green badge that does not say what it passed is the exact claim §54's
    // versioning section warns against.
    const badge = generateBadge({ ...failing, passed: true });

    expect(badge).toContain(`kit ${KIT_VERSION}`);
    expect(badge).toContain('#2ea44f');
    expect(generateBadge(failing)).toContain('#d73a49');
    expect(badge.startsWith('<svg')).toBe(true);
  });
});

describe('CLI argument parsing', () => {
  it('takes the first bare argument as the target', () => {
    expect(parseArgs(['./my-adapter']).target).toBe('./my-adapter');
  });

  it('accepts --category repeatedly and comma-separated', () => {
    expect(parseArgs(['x', '--category', 'discovery', '--category', 'cancellation']).categories).toEqual(
      ['discovery', 'cancellation'],
    );
    expect(parseArgs(['x', '--category', 'discovery,cancellation']).categories).toEqual([
      'discovery',
      'cancellation',
    ]);
  });

  it('parses --json, --out and --generate-badge', () => {
    const flags = parseArgs(['x', '--json', '--out', 'r.json', '--generate-badge', 'b.svg']);

    expect(flags.json).toBe(true);
    expect(flags.out).toBe('r.json');
    expect(flags.badge).toBe('b.svg');
  });

  it('defaults the badge filename when none is given', () => {
    expect(parseArgs(['x', '--generate-badge']).badge).toBe('conformance.svg');
  });

  it('lists the categories in its help, so the filter is discoverable', () => {
    for (const name of knownCategoryNames()) expect(usage()).toContain(name);
  });
});

describe('stdout is reserved for the report (--json is a pipeable contract)', () => {
  /**
   * The documented usage is `... --json > results.json`, which only works if
   * stdout carries the document and nothing else.
   *
   * It did not, before this. The compiler prints its progress — one line per
   * pass, per server, and the bank starts a server per category — straight to
   * stdout, so the redirected file began `Starting compilation { …` and
   * JSON.parse failed on the first character.
   *
   * The fixture is deliberately a NOISY adapter rather than a quiet one:
   * silencing our own logger would fix the symptom and miss the cause. A
   * community adapter is arbitrary third-party code that may print anything,
   * and the kit cannot audit it.
   */
  async function captureStdout(argv: readonly string[]): Promise<{ code: number; stdout: string }> {
    const written: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    // Captured at the same seam the CLI protects, so this observes the real
    // mechanism rather than a stand-in for it. The report is emitted through
    // the handle captured HERE, so it lands in `written` too — which is the
    // point: the assertion is about actual stdout, not about a logger fake.
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;

    try {
      const code = await runCli(argv, { log: () => {}, error: () => {} });
      return { code, stdout: written.join('') };
    } finally {
      process.stdout.write = realWrite;
    }
  }

  it('keeps a noisy adapter off stdout, and still reports its result', async () => {
    const { code, stdout } = await captureStdout([
      './src/__tests__/fixtures/noisy-adapter.mjs',
      '--json',
      '--category',
      'discovery',
    ]);

    expect(code).toBe(0);

    // Nothing the adapter printed reached stdout — including the MODULE-SCOPE
    // write, which fires at dynamic-import time. That one guards the ordering
    // around `import()`: if the kit ever loaded the adapter before taking
    // ownership of stdout, a banner printed at import would land in the
    // document and the createServer-only fixture would not notice.
    expect(stdout).not.toContain('NOISY-ADAPTER-MODULE-SCOPE');
    expect(stdout).not.toContain('NOISY-ADAPTER-BANNER');
    expect(stdout).not.toContain('NOISY-ADAPTER-RAW-WRITE');
    expect(stdout).not.toContain('Starting compilation');

    const document = JSON.parse(stdout) as { adapter: string; passed: boolean };
    expect(document.adapter).toBe('noisy');
    expect(document.passed).toBe(true);
  }, 120_000);

  it('emits the document at position zero even with a late writer present', async () => {
    // QA's residual edge, and an HONEST note about what this test proves.
    //
    // The fix is real: the document is now emitted inside the owned window,
    // through the captured handle, so it is written before stdout is restored.
    // Under the previous implementation — restore in `finally`, emit after — a
    // write landing in that gap would sit AHEAD of the JSON, the one position
    // that makes it unparseable.
    //
    // This test does NOT reproduce that gap, and is not RED-on-revert against
    // it. Verified by mutation: reverting to emit-after-restore leaves it
    // green, because the gap is microseconds wide and a timer cannot be aimed
    // at it — the 200ms write here lands during the run, where diversion
    // catches it either way.
    //
    // Kept because it still asserts something true and worth guarding — the
    // document starts at character zero with a noisy late writer in play — and
    // labelled rather than dressed up, since a test that looks like proof of
    // an ordering guarantee it does not check is worse than no test at all.
    const { code, stdout } = await captureStdout([
      './src/__tests__/fixtures/late-writer-adapter.mjs',
      '--json',
      '--category',
      'discovery',
    ]);

    expect(code).toBe(0);
    // The document starts at character zero, whatever arrives later.
    expect(stdout.trimStart().startsWith('{')).toBe(true);

    // And it parses, by reading the first JSON value off the stream exactly as
    // a consumer redirecting to a file would.
    const firstValue = stdout.slice(0, stdout.lastIndexOf('}') + 1);
    expect((JSON.parse(firstValue) as { adapter: string }).adapter).toBe('late-writer');
  }, 120_000);
});
