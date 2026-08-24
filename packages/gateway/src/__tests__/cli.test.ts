// SPDX-License-Identifier: Apache-2.0
/**
 * CLI entry-point tests (#57).
 *
 * `runFromArgv` is exercised rather than a spawned child process. Spawning
 * would test the same code through a slower, flakier path and would make a
 * failure show up as "exit code 2 with some stderr" rather than as the typed
 * error that caused it.
 *
 * `main` is covered only where it does not park forever — on success it returns
 * a promise that never resolves by design, because the process stays up until a
 * signal arrives.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
