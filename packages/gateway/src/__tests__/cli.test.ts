// SPDX-License-Identifier: Apache-2.0
/**
 * CLI entry-point tests (#57, extended by #128).
 *
 * Two layers, and the second exists because the first was not enough.
 *
 * **In-process** — most of this file imports `runFromArgv` / `main` directly.
 * Fast, and a failure surfaces as the typed error that caused it rather than as
 * "exit code 2 with some stderr".
 *
 * **Spawned** — the last block runs the BUILT `dist/cli.js` as a real process.
 * Importing the module can never exercise its own auto-invoke branch, and that
 * blind spot shipped a dead entrypoint in #57: the container started, printed
 * nothing, and exited 0. Everything in the first layer passed throughout.
 *
 * `main` is covered only where it does not park forever — on success it returns
 * a promise that never resolves by design, because the process stays up until a
 * signal arrives.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runFromArgv, main } from '../cli.js';
import { GATEWAY_VERSION } from '../version.js';
import type { RunningGateway } from '../server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PETSTORE = join(__dirname, '../../../sources-openapi/src/__tests__/fixtures/petstore.json');

const running: RunningGateway[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((g) => g.close()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempFile(name: string, contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-cli-'));
  dirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, contents, 'utf8');
  return path;
}

describe('runFromArgv', () => {
  it('starts a gateway from flags alone', async () => {
    const gateway = await runFromArgv([
      '--spec',
      PETSTORE,
      '--port',
      '0',
      '--metrics-port',
      '0',
      '--audit-sink',
      'none',
    ]);
    running.push(gateway);

    expect(gateway.operationCount).toBe(3);
    expect(gateway.port).toBeGreaterThan(0);
    expect(gateway.preset.name).toBe('light');
  });

  it('starts a gateway from a config file', async () => {
    const config = await tempFile(
      'askturret.gateway.yaml',
      ['spec: ' + PETSTORE, 'port: 0', 'metricsPort: 0', 'audit:', '  sink: none'].join('\n'),
    );

    const gateway = await runFromArgv(['--config', config]);
    running.push(gateway);

    expect(gateway.operationCount).toBe(3);
  });

  it('lets a flag override the config file it was given', async () => {
    const config = await tempFile(
      'g.yaml',
      ['spec: ' + PETSTORE, 'port: 0', 'metricsPort: 0', 'preset: light', 'audit:', '  sink: none'].join('\n'),
    );

    const gateway = await runFromArgv(['--config', config, '--preset', 'production']);
    running.push(gateway);

    expect(gateway.preset.name).toBe('production');
  });

  it('propagates the library’s Regulated refusal rather than starting', async () => {
    const config = await tempFile(
      'g.yaml',
      ['spec: ' + PETSTORE, 'port: 0', 'metricsPort: 0', 'preset: regulated', 'audit:', '  sink: stdout'].join('\n'),
    );

    await expect(runFromArgv(['--config', config])).rejects.toMatchObject({
      name: 'RegulatedPresetRefusal',
      control: 'audit.durability',
    });
  });
});

describe('main', () => {
  it('prints help and exits 0', async () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (chunk: string) => {
      written.push(String(chunk));
      return true;
    };

    const code = await main(['--help']);

    (process.stdout as { write: unknown }).write = original;
    expect(code).toBe(0);
    expect(written.join('')).toContain('--spec');
  });

  it('prints the version and exits 0', async () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (chunk: string) => {
      written.push(String(chunk));
      return true;
    };

    const code = await main(['--version']);

    (process.stdout as { write: unknown }).write = original;
    expect(code).toBe(0);
    expect(written.join('')).toContain(GATEWAY_VERSION);
  });

  it('exits 2 — not 1 — on a bad flag', async () => {
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = () => true;

    const code = await main(['--nope']);

    (process.stderr as { write: unknown }).write = original;
    // 2 distinguishes "you typed something wrong" from "it started and died",
    // which a single failure code collapses for anyone scripting a deployment.
    expect(code).toBe(2);
  });

  it('exits 2 when the configuration is incomplete', async () => {
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = () => true;

    const code = await main([]);

    (process.stderr as { write: unknown }).write = original;
    expect(code).toBe(2);
  });

  it('exits 1 — not 2 — when a preset refuses the boot', async () => {
    // A refusal is not a typo: the operator's config parsed fine and §10.2
    // rejected it. Reporting that as a usage error would send them looking for
    // a misspelled flag.
    const messages: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: string) => {
      messages.push(String(chunk));
      return true;
    };

    const code = await main([
      '--spec',
      PETSTORE,
      '--port',
      '0',
      '--metrics-port',
      '0',
      '--preset',
      'regulated',
      '--audit-sink',
      'stdout',
    ]);

    (process.stderr as { write: unknown }).write = original;
    expect(code).toBe(1);
    // The library's message reaches the operator verbatim — it already names
    // the control and the fix better than a paraphrase would.
    expect(messages.join('')).toContain('RegulatedPresetRefusal');
    expect(messages.join('')).toContain('durable audit sink');
  });
});

describe('the built binary, invoked as a process', () => {
  /**
   * Everything above imports `main` / `runFromArgv` directly, which is fast and
   * gives typed failures — but it means the module's own auto-invoke branch is
   * NEVER the thing under test.
   *
   * That gap shipped a broken entrypoint in #57: `invokedDirectly` compared
   * `import.meta.url` against a hand-built `file://${process.argv[1]}`, which
   * never matches a path containing a space, nor one reached through a symlink
   * — `import.meta.url` percent-encodes and resolves symlinks, the template
   * literal does neither. The module loads, the branch is skipped, and the
   * process exits 0 having done nothing.
   *
   * NOT because argv[1] is relative. An earlier version of this comment said so
   * and #184 disproved it: node resolves argv[1] to an absolute path, so the
   * Dockerfile's `ENTRYPOINT` form compares EQUAL even under the old idiom.
   * `/app` carries no space and no symlink either, so the shipped container was
   * not dead — a rebuilt pre-fix image runs fine. The real exposure is a
   * checkout path containing a space, which is how this surfaced.
   *
   * So these spawn the real built file the way a container and an `npx` shim
   * actually do. They need `dist/`, and skip rather than fail when it is absent
   * — a missing build is a different problem, and failing here would report it
   * as this one.
   */
  const DIST_CLI = join(__dirname, '../../dist/cli.js');

  function runBuilt(args: string[], cwd: string) {
    return spawnSync(process.execPath, [args[0] as string, ...args.slice(1)], {
      cwd,
      encoding: 'utf-8',
    });
  }

  it('prints its version when invoked by RELATIVE path, as the Dockerfile does', () => {
    if (!existsSync(DIST_CLI)) return;

    // `node packages/gateway/dist/cli.js --version`, run from the repo root —
    // byte for byte the ENTRYPOINT's shape.
    const repoRoot = join(__dirname, '../../../..');
    const result = runBuilt(['packages/gateway/dist/cli.js', '--version'], repoRoot);

    expect(result.status).toBe(0);
    // The assertion that matters: it produced OUTPUT. A dead entrypoint also
    // exits 0, so a status check alone would have passed on the broken build.
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('prints help when invoked by ABSOLUTE path', () => {
    if (!existsSync(DIST_CLI)) return;

    const result = runBuilt([DIST_CLI, '--help'], tmpdir());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--spec');
  });

  it('exits non-zero with a message when given no spec', () => {
    if (!existsSync(DIST_CLI)) return;

    const result = runBuilt([DIST_CLI], tmpdir());

    // A dead entrypoint exits 0 silently, so this pins that failures are real.
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('No OpenAPI spec supplied');
  });
});
