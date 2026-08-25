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
import { MCP_PROTOCOL_VERSION } from '@askturret/mcp-core';
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

  // Tester's round-4 cases, verbatim. Each leaked before the matcher was
  // rewritten; the first did worse than leak — it mangled
  // `/srv/Acme Holdings/private/spec.yaml` into `Acme Holdingsspec.yaml`,
  // exposing the directory name AND corrupting the filename.
  it.each([
    ["ENOENT: no such file or directory, open '/srv/Acme Holdings/private/spec.yaml'", 'Acme Holdings'],
    ['Error opening file "/srv/Acme Holdings/private/spec.yaml"', 'Acme Holdings'],
    ['cannot read /srv/Acme Holdings/private/spec.yaml', 'Acme Holdings'],
    ["ENOENT: open 'C:\\Program Files\\Acme Corp\\spec.yaml'", 'Program Files'],
    ['cannot read C:\\Program Files\\Acme Corp\\spec.yaml', 'Program Files'],
    ['failed for file:///srv/customer-acme/private/spec.yaml', 'customer-acme'],
  ])('strips the directory from %s', (message, leaked) => {
    const out = sanitizeErrorText(message);

    expect(out).not.toContain(leaked);
    // …and the basename survives, so the failure stays diagnosable.
    expect(out).toContain('spec.yaml');
  });

  it('never emits the literal "null" for a file: URL', () => {
    // `url.origin` is the string "null" for file:, so building from it
    // produced `null/srv/customer-acme/private/spec.yaml` — the full path,
    // leaked, with a stray "null" in front.
    expect(sanitizeErrorText('failed for file:///srv/customer-acme/x.log')).not.toContain('null');
  });

  it('handles a quoted path whose FILENAME contains spaces', () => {
    // This comment described a dedicated "quoted path" pass, which was deleted
    // in #50 round 4 for adding no coverage — so it documented code that no
    // longer existed (#163).
    //
    // What actually happens: quote characters are excluded from the path
    // character classes, so the unquoted rules match up to `my`, and the
    // remaining ` spec file.yaml` is already-safe trailing text. The directory
    // is stripped either way, which is what the guarantee is about.
    const out = sanitizeErrorText("open '/srv/private-client/my spec file.yaml'");

    expect(out).not.toContain('private-client');
    expect(out).toBe("open 'my spec file.yaml'");
  });

  it('does not swallow the prose after a path', () => {
    // Blanks are permitted only in segments FOLLOWED by a separator, so the run
    // ends at the filename.
    //
    // Note what actually protects this, per #163: allowing blanks in the final
    // segment too is an EQUIVALENT MUTANT — `lastPathSegment` discards
    // everything before the last separator however far the match ran. The
    // helper keeps the prose safe; the segment boundary is tidiness. The
    // assertion is still worth having, it just does not test what its old
    // rationale claimed.
    expect(sanitizeErrorText('/srv/x/spec.yaml is missing and the server is unhappy')).toBe(
      'spec.yaml is missing and the server is unhappy',
    );
  });

  it('reduces a Windows path regardless of the host OS', () => {
    // node:path's basename is platform-bound; this must not depend on where
    // the tool happens to run.
    expect(sanitizeErrorText('open "C:\\Users\\First Last\\spec.yaml"')).toBe(
      'open "spec.yaml"',
    );
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

  // ---------------------------------------------------------------------------
  // Shapes that still leaked after #50 round 4 (#163)
  // ---------------------------------------------------------------------------

  it('reduces a Windows UNC path, which the drive-letter matcher never saw', () => {
    // The consequential one. `[A-Za-z]:\\` cannot match `\\server\share\...`, so
    // the file-server hostname, the share name and the layout all shipped in the
    // bundle. Reachable any time --spec or --log-file points at a network share.
    const out = sanitizeErrorText('open \\\\fileserver\\acme-share\\private\\spec.yaml failed');

    expect(out).toBe('open spec.yaml failed');
    expect(out).not.toContain('fileserver');
    expect(out).not.toContain('acme-share');
    expect(out).not.toContain('private');
  });

  it('reduces a UNC path whose share or directory contains spaces', () => {
    // `Program Files`-style names are the norm on Windows; a UNC matcher that
    // stopped at a space would fire almost never, which is how the drive-letter
    // form originally failed.
    const out = sanitizeErrorText('open \\\\file server\\Acme Holdings\\private\\spec.yaml');

    expect(out).toBe('open spec.yaml');
    expect(out).not.toContain('Acme Holdings');
  });

  it('reduces a path whose directory name contains a TAB', () => {
    // Reproduced the original round-3 defect exactly: directory leaked AND
    // filename corrupted, because the allowance was a literal space.
    const out = sanitizeErrorText("open '/srv/Acme\tHoldings/private/spec.yaml'");

    expect(out).toBe("open 'spec.yaml'");
    expect(out).not.toContain('Acme');
    expect(out).not.toContain('Holdings');
  });

  it('reduces a Windows path whose directory name contains a TAB', () => {
    const out = sanitizeErrorText('open "C:\\Acme\tHoldings\\private\\spec.yaml"');

    expect(out).toBe('open "spec.yaml"');
    expect(out).not.toContain('Holdings');
  });

  it('still does not run across a newline', () => {
    // `[^\S\r\n]+` rather than `\s+`: a path run must not join two lines, or a
    // stack trace would collapse into one mangled token.
    const out = sanitizeErrorText('/srv/a/spec.yaml\n/srv/b/other.yaml');

    expect(out).toBe('spec.yaml\nother.yaml');
  });

  it('keeps the drive-letter form working', () => {
    // The UNC alternative is added ALONGSIDE the drive-letter form. Pinned so a
    // future edit to the alternation cannot trade one for the other.
    expect(sanitizeErrorText('open "C:\\Program Files\\acme\\spec.yaml"')).toBe(
      'open "spec.yaml"',
    );
  });

  // ---------------------------------------------------------------------------
  // Either separator, at every position (#286)
  //
  // Windows accepts `/` and `\` interchangeably and real paths mix them. #163
  // hard-coded `\` as the separator, so a mixed path matched only up to its
  // first forward slash: WINDOWS_RUN took the backslash prefix, POSIX_RUN took
  // the tail, and the two reductions landed adjacent —
  // `\\HOST\SHARE/DIR/spec.yaml` -> `SHAREspec.yaml`. Share name leaked, filename
  // corrupted; the round-3 shape one separator along.
  // ---------------------------------------------------------------------------

  it.each([
    ['backslash then forward (the issue repro)', 'open \\\\SECRETHOST\\SECRETSHARE/SECRETDIR/spec.yaml failed'],
    ['forward then backslash', 'open \\\\SECRETHOST/SECRETSHARE\\SECRETDIR\\spec.yaml failed'],
    ['all forward slashes after the prefix', 'open \\\\SECRETHOST/SECRETSHARE/SECRETDIR/spec.yaml failed'],
  ])('reduces a mixed-separator UNC path: %s', (_label, input) => {
    const out = sanitizeErrorText(input);

    // The acceptance criterion, stated as three separate absences rather than
    // one equality: a future partial match could still produce a string that
    // happens to contain "spec.yaml" while leaking a component.
    expect(out).not.toContain('SECRETHOST');
    expect(out).not.toContain('SECRETSHARE');
    expect(out).not.toContain('SECRETDIR');
    expect(out).toContain('spec.yaml');
  });

  it('reduces a mixed-separator UNC path to exactly the basename', () => {
    expect(
      sanitizeErrorText('open \\\\SECRETHOST\\SECRETSHARE/SECRETDIR/spec.yaml failed'),
    ).toBe('open spec.yaml failed');
  });

  it('handles blanks in a mixed-separator UNC path', () => {
    // Both #163 fixes have to survive the #286 change: spaces are the norm in
    // Windows names, and the tab case was its own leak.
    expect(sanitizeErrorText('open \\\\file server\\Acme Holdings/private/spec.yaml')).toBe(
      'open spec.yaml',
    );
    expect(sanitizeErrorText('open \\\\host\\Acme\tHoldings/private/spec.yaml')).toBe(
      'open spec.yaml',
    );
  });

  it('reduces a drive-letter path written with forward slashes', () => {
    // NOT in #286, found while reproducing it: the drive prefix required a
    // backslash, so POSIX_RUN took the tail and left `C:spec.yaml`. No directory
    // leaked, but the filename was corrupted — same root cause, same fix.
    expect(sanitizeErrorText('open "C:/Program Files/acme/spec.yaml"')).toBe('open "spec.yaml"');
    expect(sanitizeErrorText('open "C:\\Program Files/acme\\spec.yaml"')).toBe('open "spec.yaml"');
  });

  it('does not read a letter inside a longer token as a drive', () => {
    // Accepting `/` after the drive letter makes `p:/` in `http:/…` look like a
    // drive path. The lookbehind is what prevents that; without it the match
    // would start mid-word and eat the scheme.
    expect(sanitizeErrorText('see http://host/a/b/mcp')).toContain('http://host');
  });

  it('still does not run across a newline, with either separator', () => {
    expect(sanitizeErrorText('\\\\host\\a/spec.yaml\n\\\\host\\b/other.yaml')).toBe(
      'spec.yaml\nother.yaml',
    );
  });

  // ---------------------------------------------------------------------------
  // Consecutive separators (#293)
  //
  // `SEG` requires >=1 non-separator character, so `(?:SEG SEP)+` could not
  // traverse an empty segment. A doubled separator broke the run: the match
  // either failed outright (everything leaked) or restarted mid-path, landing
  // a partial reduction next to the unmatched head — the round-3 signature,
  // directory leaked AND filename corrupted, for the fourth time (#50, #163,
  // #286, this).
  //
  // The five inputs below are the issue's acceptance criterion verbatim.
  // ---------------------------------------------------------------------------

  it.each([
    ['doubled backslashes throughout', 'C:\\\\DIR\\\\SUB\\\\spec.yaml', ['DIR', 'SUB']],
    ['doubled forward slashes throughout', '/srv//DIR//spec.yaml', ['srv', 'DIR']],
    ['one doubled backslash mid-path', 'C:\\DIR\\\\SUB\\spec.yaml', ['DIR', 'SUB']],
    ['doubled backslash after the UNC prefix', '\\\\HOST\\\\SHARE\\spec.yaml', ['HOST', 'SHARE']],
    ['one doubled forward slash mid-path', '/srv/DIR//SUB/spec.yaml', ['srv', 'DIR', 'SUB']],
  ])('reduces a path with consecutive separators: %s', (_label, input, leaked) => {
    const out = sanitizeErrorText(input);

    // Stated as absences AND an equality: a partial match can still produce a
    // string containing "spec.yaml" while leaking a component, which is exactly
    // how every previous round in this area passed its own new assertions.
    for (const token of leaked as string[]) {
      expect(out).not.toContain(token);
    }
    expect(out).toBe('spec.yaml');
  });

  it('reduces a JSON-stringified UNC path, where every backslash is doubled', () => {
    // The motivating shape. Bundles are largely serialized error payloads, and
    // `JSON.stringify('\\HOST\SHARE\spec.yaml')` prints a FOUR-backslash prefix.
    // With a prefix of exactly two, the match started at the third backslash and
    // left `\\` stranded in front of the basename.
    const out = sanitizeErrorText('\\\\\\\\HOST\\\\SHARE\\\\spec.yaml');

    expect(out).not.toContain('HOST');
    expect(out).not.toContain('SHARE');
    expect(out).toBe('spec.yaml');
  });

  it('still does not swallow the prose after a doubled-separator path', () => {
    // Quantifying the separator must not let the run walk past the filename.
    expect(sanitizeErrorText('/srv//x//spec.yaml is missing')).toBe('spec.yaml is missing');
    expect(sanitizeErrorText('open "C:\\\\a\\\\spec.yaml" failed')).toBe('open "spec.yaml" failed');
  });

  it('still does not run across a newline when separators are doubled', () => {
    // A blank line between two paths is two newlines, not a separator run.
    expect(sanitizeErrorText('/srv//a/spec.yaml\n/srv//b/other.yaml')).toBe(
      'spec.yaml\nother.yaml',
    );
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

  it('stamps the protocol version this build announces, not a local literal', async () => {
    // #61/#190: this field carried a hardcoded '2025-06-18' — a version nothing
    // in the system has ever spoken — while core announced '2024-11-05'. The
    // bundle is what someone reads while already debugging a version problem,
    // so a wrong value here is worse than an absent one.
    //
    // Asserted against core's exported constant rather than a literal, so the
    // test tracks the source of truth instead of pinning a second copy of it —
    // a copy here would be the very thing the fix removed.
    const collected = await collectBundleInputs(parseDiagnosticsArgs([]));

    expect(collected.versions.mcpProtocol).toBe(MCP_PROTOCOL_VERSION);
    expect(collected.versions.mcpProtocol).not.toBe('2025-06-18');
  });

  it('carries that version into versions.json in the finished archive', async () => {
    // The value being right in the collected object is not the deliverable —
    // reaching the file an operator opens is. Asserted on the archive bytes,
    // matching how the rest of this suite treats the bundle.
    const collected = await collectBundleInputs(parseDiagnosticsArgs([]));
    const versionsFile = buildBundleEntries(collected).find((e) => e.name === 'versions.json');

    expect(versionsFile?.content).toContain(MCP_PROTOCOL_VERSION);
    expect(versionsFile?.content).not.toContain('2025-06-18');
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

describe('--regulated bundle (§52)', () => {
  it('is off by default, so existing bundles are unchanged', () => {
    expect(parseDiagnosticsArgs([]).regulated).toBe(false);
    expect(parseDiagnosticsArgs(['--full-schemas']).fullSchemas).toBe(true);
  });

  it('withholds config paths, and says so rather than emitting an ambiguous empty list', async () => {
    const collected = await collectBundleInputs(
      parseDiagnosticsArgs(['--regulated', '--config', '/etc/askturret/config.json']),
    );

    expect(collected.paths).toEqual([]);
    // The load-bearing half. An empty `paths` meaning both "none supplied" and
    // "deliberately removed" is exactly the ambiguity this bundle's contract
    // forbids, so the reason has to be stated.
    expect(collected.unavailable?.['paths']).toMatch(/withheld by --regulated/i);
  });

  it('still reports paths normally without the flag', async () => {
    const collected = await collectBundleInputs(
      parseDiagnosticsArgs(['--config', '/etc/askturret/config.json']),
    );

    expect(collected.paths).toEqual(['/etc/askturret/config.json']);
    expect(collected.unavailable?.['paths']).toBeUndefined();
  });

  it('forces --full-schemas off, so the narrower flag wins a contradiction', async () => {
    const flags = parseDiagnosticsArgs(['--regulated', '--full-schemas']);
    expect(flags.fullSchemas).toBe(false);

    // …and in the other order. This must not be last-flag-wins: the safe
    // resolution of a contradiction about disclosure is the narrower one.
    expect(parseDiagnosticsArgs(['--full-schemas', '--regulated']).fullSchemas).toBe(false);

    const collected = await collectBundleInputs(flags);
    expect(collected.fullSchemas).toBe(false);
    expect(collected.unavailable?.['schemas']).toMatch(/withheld by --regulated/i);
  });
});

describe('bundle helpers', () => {
  it('reduces paths to basenames, both separator styles', () => {
    expect(pathBasenames(['/a/b/c.ts', 'd.ts', 'C:\\Program Files\\x\\e.ts'])).toEqual([
      'c.ts',
      'd.ts',
      'e.ts',
    ]);
  });

  it('writes a real file end to end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'diag-out-'));
    const out = join(dir, 'bundle.tar.gz');

    await writeFile(out, createTarGz(buildBundleEntries(inputs())));
    const written = await readFile(out);

    expect(gunzipSync(written).toString('utf8')).toContain('README.md');
  });
});
