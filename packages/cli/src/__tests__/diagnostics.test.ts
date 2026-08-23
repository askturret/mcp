// SPDX-License-Identifier: Apache-2.0
/**
 * `diagnostics` support bundle (§13, #50).
 *
 * The acceptance criterion is a GREP: build a bundle from a fixture holding a
 * known secret, decompress it, and find zero matches. So the tests below
 * mostly operate on the finished archive bytes rather than on intermediate
 * values — a bundle that redacted every intermediate and then wrote the raw
 * value into the README would pass a value-level assertion and fail an
 * operator.
 */

import { describe, it, expect } from '@jest/globals';
import { gunzipSync } from 'node:zlib';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildBundleEntries,
  bundleReadme,
  environmentNames,
  pathBasenames,
  sanitizeErrorText,
} from '../commands/diagnostics-bundle.js';
import { createTarGz, TarNameTooLongError } from '../commands/diagnostics-tar.js';
import { collectBundleInputs, parseDiagnosticsArgs } from '../commands/diagnostics.js';
import type { BundleInputs } from '../commands/diagnostics-bundle.js';

const SECRET = 'sk_live_xyz';

function inputs(overrides: Partial<BundleInputs> = {}): BundleInputs {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    versions: { node: 'v20.11.0', platform: 'linux', arch: 'x64' },
    envNames: ['API_KEY', 'PATH'],
    paths: ['/home/alice/projects/secret-client/askturret.config.ts'],
    ...overrides,
  };
}

/** Decompress and return the whole archive as one searchable string. */
function archiveText(entries: Parameters<typeof createTarGz>[0]): string {
  return gunzipSync(createTarGz(entries)).toString('utf8');
}

describe('secret-leak grep (§50 acceptance)', () => {
  it('finds zero matches for a secret carried under a known key name', () => {
    const text = archiveText(
      buildBundleEntries(
        inputs({
          preset: { audit: { sink: null }, apiKey: SECRET },
          tools: [{ name: 'createPet', inputSchema: { example: { token: SECRET } } }],
          health: { ready: { body: { password: SECRET } } },
        }),
      ),
    );

    expect(text).not.toContain(SECRET);
    expect(text).toContain('[REDACTED]');
  });

  it('LIMIT: a secret embedded in free-form prose under an innocuous key survives', () => {
    // Asserted, not hidden. My first version of the test above used
    //   detail: `failed with authorization ${SECRET}`
    // and failed — correctly. `detail` is not a sensitive key name, and the
    // VALUE is a sentence, not a credential shape, so #49's whole-value rules
    // cannot see it. That is the documented limitation, and §50's acceptance
    // criterion ("grep the bundle, zero matches") is only achievable for the
    // cases the rules can actually recognise.
    //
    // This is exactly why the bundle README says "Review this bundle before
    // you send it" rather than claiming the output is safe by construction.
    const text = archiveText(
      buildBundleEntries(
        inputs({ health: { ready: { body: { detail: `upstream said ${SECRET}` } } } }),
      ),
    );

    expect(text).toContain(SECRET);
  });

  it('redacts a credential-shaped value in the log tail', () => {
    // §13 asks for the tail to be re-sanitised for "residual leakage": a log
    // file can predate the pipeline, come from a differently-configured
    // process, or have been hand-edited.
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';

    const text = archiveText(
      buildBundleEntries(inputs({ logTail: [`GET /pets auth=${jwt}`] })),
    );

    expect(text).not.toContain(jwt);
  });

  it('never emits an environment variable VALUE', () => {
    // The strongest guarantee in the bundle, and the only one that does not
    // depend on the redaction rules being right: values are never read.
    const names = environmentNames({ API_KEY: SECRET, PATH: '/usr/bin' });

    expect(names).toEqual(['API_KEY', 'PATH']);
    expect(JSON.stringify(names)).not.toContain(SECRET);
  });

  it('emits path basenames, not directory layout', () => {
    const text = archiveText(buildBundleEntries(inputs()));

    expect(text).toContain('askturret.config.ts');
    expect(text).not.toContain('/home/alice');
    expect(text).not.toContain('secret-client');
  });
});

describe('operator secrets never reach the bundle via error text (QA #162 r3)', () => {
  const URL_SECRET = 'sk_live_urlsecret_9999';
  const CREDENTIALED_URL = `http://qa_user:${URL_SECRET}@127.0.0.1:1/mcp`;
  const PRIVATE_PATH = '/tmp/operator-private-fixture/typo-spec.yaml';

  /**
   * Drives the REAL collectors against a credentialed URL and a bad path.
   *
   * Not a hand-written `unavailable` map: the leak was that Node embeds the
   * operator's own input in its error strings, so a test that supplied its
   * own reasons would never see the text that actually leaked. This makes
   * every collector fail for real and inspects the finished archive.
   */
  async function bundleFromFailingRun(): Promise<string> {
    const collected = await collectBundleInputs(
      parseDiagnosticsArgs([
        '--url', CREDENTIALED_URL,
        '--spec', PRIVATE_PATH,
        '--log-file', PRIVATE_PATH,
      ]),
    );
    return archiveText(buildBundleEntries(collected));
  }

  it('never writes URL userinfo into any bundle file', async () => {
    const text = await bundleFromFailingRun();

    expect(text).not.toContain(URL_SECRET);
    expect(text).not.toContain('qa_user');
    // No `scheme://…@` userinfo form survives anywhere.
    expect(text).not.toMatch(/:\/\/[^/\s"']*:[^/\s"']*@/);
  });

  it('never writes an absolute filesystem path into any bundle file', async () => {
    // The README promises basenames; that has to hold for error text too, or
    // the operator's directory layout and OS username ship with the bundle.
    const text = await bundleFromFailingRun();

    expect(text).not.toContain('operator-private-fixture');
    expect(text).not.toContain(PRIVATE_PATH);
  });

  it('keeps the failure diagnosable — host and basename survive', async () => {
    // Redaction that removed the whole message would make the bundle useless
    // for the thing it exists to explain.
    const text = await bundleFromFailingRun();

    expect(text).toContain('127.0.0.1');
    expect(text).toContain('typo-spec.yaml');
    expect(text).toContain('[REDACTED]@');
  });

  it('README.md itself goes through the pipeline, not just the JSON files', () => {
    // README.md was the ONE file that bypassed redaction, which made its own
    // guarantee sentence false about itself.
    //
    // The reason bypasses `describeError` deliberately. With the source fix
    // in place nothing unsanitised reaches the README any more, so a test
    // driven through the collectors passes either way — I checked, and it
    // did. Injecting a credential-shaped value directly into `unavailable`
    // simulates a FUTURE field reaching the README without passing the
    // source seam, which is what the routing actually defends against.
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';

    const entries = buildBundleEntries(
      inputs({ unavailable: { health: `collector rejected token ${jwt}` } }),
    );
    const readme = entries.find((e) => e.name === 'README.md');

    expect(readme?.content).not.toContain(jwt);
    // …and the JSON side was already covered, so both halves hold.
    expect(entries.find((e) => e.name === 'metadata.json')?.content).not.toContain(jwt);
  });

  it('README.md carries no secret on the real credentialed-URL run either', async () => {
    const collected = await collectBundleInputs(
      parseDiagnosticsArgs(['--url', CREDENTIALED_URL]),
    );
    const readme = buildBundleEntries(collected).find((e) => e.name === 'README.md');

    expect(readme?.content).not.toContain(URL_SECRET);
  });
});

describe('sanitizeErrorText', () => {
  it('blanks userinfo but keeps scheme, host and path', () => {
    expect(sanitizeErrorText('failed: http://u:p@example.com:8080/mcp/x')).toBe(
      'failed: http://[REDACTED]@example.com:8080/mcp/x',
    );
  });

  it('drops the query string, where tokens live at least as often', () => {
    expect(sanitizeErrorText('GET https://example.com/a?token=sk_live_zzz')).toBe(
      'GET https://example.com/a',
    );
  });

  it('leaves a credential-free URL intact apart from the query', () => {
    expect(sanitizeErrorText('http://127.0.0.1:1/mcp')).toBe('http://127.0.0.1:1/mcp');
  });

  it('reduces absolute POSIX paths to basenames', () => {
    expect(sanitizeErrorText("open '/tmp/private/a/b/spec.yaml'")).toBe("open 'spec.yaml'");
  });

  it('reduces Windows paths to basenames', () => {
    expect(sanitizeErrorText('open "C:\\Users\\alice\\spec.yaml"')).toBe('open "spec.yaml"');
  });

  it('does not chew a URL up with the path branch', () => {
    // Alternation order is load-bearing: without URLs matching first,
    // http://host/a/b/mcp is reduced to `mcp`.
    expect(sanitizeErrorText('http://host/a/b/mcp')).toContain('http://host');
  });

  it('refuses to emit a URL-shaped string it cannot parse', () => {
    expect(sanitizeErrorText('see http://[not a url')).toContain('[REDACTED:url]');
  });

  it('leaves ordinary prose alone', () => {
    expect(sanitizeErrorText('connection refused')).toBe('connection refused');
  });
});

describe('bundle contents (§13)', () => {
  it('always includes metadata, versions, configuration and the README', () => {
    const names = buildBundleEntries(inputs()).map((entry) => entry.name);

    expect(names).toEqual(
      expect.arrayContaining(['metadata.json', 'versions.json', 'configuration.json', 'README.md']),
    );
  });

  it('omits optional sections that were not collected', () => {
    const names = buildBundleEntries(inputs()).map((entry) => entry.name);

    expect(names).not.toContain('tools.json');
    expect(names).not.toContain('health.json');
  });

  it('includes optional sections that were', () => {
    const names = buildBundleEntries(
      inputs({ tools: [], health: {}, logTail: ['line'] }),
    ).map((entry) => entry.name);

    expect(names).toEqual(expect.arrayContaining(['tools.json', 'health.json', 'logs.txt']));
  });

  it('truncates large schemas by default, with an actionable marker', () => {
    const big = { type: 'object', properties: Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`field${i}`, { type: 'string' }]),
    ) };

    const entry = buildBundleEntries(inputs({ tools: [{ name: 'x', inputSchema: big }] }))
      .find((e) => e.name === 'tools.json');
    const parsed = JSON.parse(entry?.content ?? '[]') as { inputSchema: { truncated?: boolean } }[];

    // A marker, not a clipped blob: a half-JSON object looks like a malformed
    // schema on the server rather than a size decision made by this tool.
    expect(parsed[0]?.inputSchema.truncated).toBe(true);
    expect(entry?.content).toContain('--full-schemas');
  });

  it('keeps schemas whole with --full-schemas', () => {
    const big = { type: 'object', properties: Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`field${i}`, { type: 'string' }]),
    ) };

    const entry = buildBundleEntries(
      inputs({ tools: [{ name: 'x', inputSchema: big }], fullSchemas: true }),
    ).find((e) => e.name === 'tools.json');

    expect(entry?.content).toContain('field59');
  });
});

describe('the README names exactly the files in the archive (QA #162)', () => {
  /** Filenames the README's "Files in THIS bundle" section lists. */
  function readmeFilenames(entries: ReturnType<typeof buildBundleEntries>): string[] {
    const readme = entries.find((e) => e.name === 'README.md')?.content ?? '';
    const section = readme.split('## Files in THIS bundle')[1]?.split('\n##')[0] ?? '';
    return [...section.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1] as string);
  }

  // The assertion QA proved was missing. Tester inserted a fabricated
  // filename into the Files list and all 28 tests still passed — nothing tied
  // the README's claims to the archive's contents. These do, in BOTH
  // directions, so neither an over-claim nor an omission can pass.
  it.each([
    ['minimal run', {}],
    ['live-server run', { tools: [], health: {}, registry: { summary: {} } }],
    ['run with logs', { logTail: ['a line'] }],
    ['run with doctor', { doctor: { score: 90 } }],
    ['everything', {
      tools: [],
      health: {},
      registry: { summary: {} },
      doctor: { score: 90 },
      runtimeState: {},
      logTail: ['x'],
    }],
  ])('%s: README lists every file present, and only those', (_label, overrides) => {
    const entries = buildBundleEntries(inputs(overrides as Partial<BundleInputs>));

    expect(readmeFilenames(entries).sort()).toEqual(entries.map((e) => e.name).sort());
  });

  it('never names a file the archive does not contain', () => {
    // The specific defect: a realistic run emitted 5 files while the README
    // promised all 9 §13 items regardless of what was collected.
    const entries = buildBundleEntries(inputs());
    const listed = readmeFilenames(entries);

    expect(listed).not.toContain('doctor.json');
    expect(listed).not.toContain('tools.json');
    expect(listed).toHaveLength(entries.length);
  });
});

describe('the README tells the truth about this build', () => {
  it('enumerates the redaction guarantees (§50 acceptance)', () => {
    const readme = bundleReadme(inputs());

    expect(readme).toContain('diagnostic-bundle');
    expect(readme).toContain('NAME ONLY');
    expect(readme).toContain('basenames');
  });

  it('states the LIMITS, not just the guarantees', () => {
    // A README that only listed guarantees would leave an operator believing
    // the bundle is safe to forward unread. It is not — see the honest-limit
    // test in #49's suite.
    const readme = bundleReadme(inputs());

    expect(readme).toContain('may NOT be detected');
    expect(readme).toContain('Review this bundle before you send it');
  });

  it('records a reason for EVERY section a real run could not collect', async () => {
    // QA's second finding: registry and doctor were absent with no reason
    // recorded anywhere, unlike the other missing sections. "Silently absent"
    // is the one outcome this bundle's own README forbids.
    const collected = await collectBundleInputs(parseDiagnosticsArgs([]));
    const reasons = collected.unavailable ?? {};

    for (const section of ['tools', 'registry', 'doctor', 'health', 'runtimeState']) {
      expect(typeof reasons[section]).toBe('string');
      expect(reasons[section]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('lists sections that could not be collected, with reasons', () => {
    const readme = bundleReadme(
      inputs({ unavailable: { health: 'connection refused' } }),
    );

    expect(readme).toContain('could not be collected');
    expect(readme).toContain('connection refused');
  });

  it('describes schema truncation matching what this build actually did', () => {
    // Passing the filenames is now required for the schema note to appear at
    // all — it is only relevant when tools.json is genuinely in the bundle.
    // That is the fix working: the README no longer explains a file that is
    // not there.
    const withTools = ['tools.json', 'README.md'];

    expect(bundleReadme(inputs({ fullSchemas: true }), withTools)).toContain('in full');
    expect(bundleReadme(inputs({ fullSchemas: false }), withTools)).toContain('--full-schemas');
  });

  it('omits the schema note entirely when there is no tools.json', () => {
    expect(bundleReadme(inputs({ fullSchemas: false }), ['README.md'])).not.toContain(
      '--full-schemas',
    );
  });
});

describe('tar writer', () => {
  it('produces an archive tar can read: header, content, terminator', () => {
    const raw = gunzipSync(createTarGz([{ name: 'a.txt', content: 'hello' }]));

    // 512 header + 512 padded content + 1024 terminator.
    expect(raw.length).toBe(2048);
    expect(raw.subarray(0, 5).toString()).toBe('a.txt');
    expect(raw.subarray(257, 262).toString()).toBe('ustar');
    expect(raw.subarray(512, 517).toString()).toBe('hello');
    // Terminator is genuinely zeroed.
    expect(raw.subarray(1024).every((byte) => byte === 0)).toBe(true);
  });

  it('writes a checksum tar will accept', () => {
    // Recomputed the way tar does: the checksum field itself read as spaces.
    const raw = gunzipSync(createTarGz([{ name: 'a.txt', content: 'hi' }]));
    const header = Buffer.from(raw.subarray(0, 512));

    const stored = Number.parseInt(header.subarray(148, 154).toString(), 8);
    header.write('        ', 148, 8, 'utf8');
    let sum = 0;
    for (const byte of header) sum += byte;

    expect(stored).toBe(sum);
  });

  it('pins mtime to the epoch, so archives are reproducible', () => {
    // Asserted on the HEADER FIELD, not by comparing two builds.
    //
    // The two-build comparison was the obvious test and it does not work:
    // both archives are built within the same second, so a wall-clock mtime
    // produces identical bytes anyway and the assertion passes either way.
    // Mutation testing caught that — switching to Date.now() left it green.
    const raw = gunzipSync(createTarGz([{ name: 'a.txt', content: 'x' }]));
    const mtime = Number.parseInt(raw.subarray(136, 147).toString(), 8);

    expect(mtime).toBe(0);
  });

  it('is byte-identical for identical input', () => {
    // The consequence of the above: two bundles from the same inputs diff
    // cleanly, rather than every archive being unique for a field nobody reads.
    const once = createTarGz([{ name: 'a.txt', content: 'x' }]);
    const twice = createTarGz([{ name: 'a.txt', content: 'x' }]);

    expect(once.equals(twice)).toBe(true);
  });

  it('refuses a name too long for USTAR rather than truncating it', () => {
    // A silently dropped or renamed file in a support bundle is worse than a
    // failed build — the recipient cannot tell it is missing.
    expect(() => createTarGz([{ name: `${'a'.repeat(101)}.txt`, content: '' }])).toThrow(
      TarNameTooLongError,
    );
  });

  it('pads content to a 512-byte boundary', () => {
    const raw = gunzipSync(createTarGz([{ name: 'a.txt', content: 'x'.repeat(513) }]));

    // 512 header + 1024 padded content + 1024 terminator.
    expect(raw.length).toBe(2560);
  });
});

describe('collection degrades rather than failing', () => {
  it('records why a section is missing instead of omitting it silently', async () => {
    // "Could not check" must never read as "nothing to report" — the same
    // distinction #47 drew for health.
    const collected = await collectBundleInputs(parseDiagnosticsArgs(['--out', 'x.tar.gz']));

    expect(collected.unavailable?.['tools']).toContain('No --url');
    expect(collected.unavailable?.['runtimeState']).toContain('in-process only');
  });

  it('produces a REAL doctor section when --spec is supplied (QA #162)', async () => {
    // The core of the QA finding: `doctor` was declared in the type and
    // promised in every README while NO code path assigned it, so doctor.json
    // could never appear in a CLI-produced bundle. This drives the real
    // loader and the real analyzer against the repo's own example spec.
    const collected = await collectBundleInputs(
      parseDiagnosticsArgs(['--spec', '../../examples/petstore-light/openapi.yaml']),
    );

    expect(collected.doctor).toBeDefined();
    // And it drops out of `unavailable`, rather than being reported both ways.
    expect(collected.unavailable?.['doctor']).toBeUndefined();

    const names = buildBundleEntries(collected).map((entry) => entry.name);
    expect(names).toContain('doctor.json');
  });

  it('records a reason when --spec points at something unreadable', async () => {
    const collected = await collectBundleInputs(
      parseDiagnosticsArgs(['--spec', '/nonexistent/no-such-spec.yaml']),
    );

    expect(collected.doctor).toBeUndefined();
    expect(collected.unavailable?.['doctor']).toBeDefined();
  });

  it('still records a missing log file as unavailable, with the reason', async () => {
    const collected = await collectBundleInputs(
      parseDiagnosticsArgs(['--log-file', '/nonexistent/does-not-exist.log']),
    );

    expect(collected.unavailable?.['logs']).toBeDefined();
    expect(collected.logTail).toBeUndefined();
  });

  it('reads a log tail when the file exists, bounded by --tail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'diag-'));
    const path = join(dir, 'server.log');
    await writeFile(path, Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'), 'utf8');

    const collected = await collectBundleInputs(
      parseDiagnosticsArgs(['--log-file', path, '--tail', '10']),
    );

    expect(collected.logTail).toHaveLength(10);
    expect(collected.logTail?.[9]).toBe('line 49');
  });
});

describe('argument parsing', () => {
  it('defaults the output path and schema behaviour', () => {
    const flags = parseDiagnosticsArgs([]);

    expect(flags.out).toBe('./bundle.tar.gz');
    expect(flags.fullSchemas).toBe(false);
    expect(flags.json).toBe(false);
  });

  it('reads the documented flags', () => {
    const flags = parseDiagnosticsArgs([
      '--url', 'http://localhost:7000/mcp',
      '--out', './b.tar.gz',
      '--full-schemas',
      '--json',
      '--preset', 'production',
    ]);

    expect(flags).toMatchObject({
      url: 'http://localhost:7000/mcp',
      out: './b.tar.gz',
      fullSchemas: true,
      json: true,
      preset: 'production',
    });
  });

  it('ignores an unsupported preset rather than expanding the wrong one', () => {
    // `describePreset` only expands production today; silently treating
    // `--preset light` as production would put a configuration in the bundle
    // that the server is not running.
    expect(parseDiagnosticsArgs(['--preset', 'light']).preset).toBeUndefined();
  });
});

describe('bundle helpers', () => {
  it('reduces paths to basenames', () => {
    expect(pathBasenames(['/a/b/c.ts', 'd.ts'])).toEqual(['c.ts', 'd.ts']);
  });

  it('writes a real file end to end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'diag-out-'));
    const out = join(dir, 'bundle.tar.gz');

    await writeFile(out, createTarGz(buildBundleEntries(inputs())));
    const written = await readFile(out);

    expect(gunzipSync(written).toString('utf8')).toContain('README.md');
  });
});
