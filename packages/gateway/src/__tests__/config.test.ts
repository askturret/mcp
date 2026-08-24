// SPDX-License-Identifier: Apache-2.0
/**
 * CLI flag and config-file tests (#57).
 *
 * The two surfaces are tested against each other rather than separately: §57
 * requires "full config file support in addition to CLI flags", and the thing
 * that can quietly break is not either parser but the RELATIONSHIP between them
 * — precedence, and whether a key means the same thing on both.
 */

import { describe, it, expect } from '@jest/globals';

import {
  GatewayConfigError,
  HELP_TEXT,
  parseArgs,
  parseConfigFile,
  resolveConfig,
} from '../config.js';

describe('CLI flags', () => {
  it('parses the documented invocation from §57', () => {
    const { config } = parseArgs([
      '--spec',
      './openapi.yaml',
      '--overlay',
      './askturret.mcp.yaml',
      '--upstream',
      'https://api.example.com',
      '--port',
      '7000',
    ]);

    expect(config.spec).toBe('./openapi.yaml');
    expect(config.overlay).toEqual(['./askturret.mcp.yaml']);
    expect(config.upstream).toBe('https://api.example.com');
    // Coerced, not left as the string it arrived as — a port that stayed
    // `"7000"` would bind fine and compare wrong everywhere else.
    expect(config.port).toBe(7000);
  });

  it('accepts --key=value as well as --key value', () => {
    const { config } = parseArgs(['--spec=./a.yaml', '--port=8080']);

    expect(config.spec).toBe('./a.yaml');
    expect(config.port).toBe(8080);
  });

  it('accumulates repeated --overlay in order', () => {
    // Overlays COMPOSE (§5.3 applies them in order). A second flag that
    // replaced the first would silently change which fields an agent sees.
    const { config } = parseArgs(['--overlay', 'a.yaml', '--overlay', 'b.yaml']);

    expect(config.overlay).toEqual(['a.yaml', 'b.yaml']);
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['--upstreem', 'x'])).toThrow(GatewayConfigError);
  });

  it('refuses a flag with no value', () => {
    expect(() => parseArgs(['--spec'])).toThrow(/requires a value/);
    // A following flag is not a value — `--spec --port 1` must not set
    // spec to "--port".
    expect(() => parseArgs(['--spec', '--port'])).toThrow(/requires a value/);
  });

  it('refuses an out-of-range preset or sink', () => {
    expect(() => parseArgs(['--preset', 'paranoid'])).toThrow(/must be one of/);
    expect(() => parseArgs(['--audit-sink', 'syslog'])).toThrow(/must be one of/);
  });

  it('documents every value flag it accepts', () => {
    // A flag that works but is absent from --help is a flag nobody finds.
    for (const flag of [
      '--spec',
      '--overlay',
      '--upstream',
      '--port',
      '--host',
      '--base-path',
      '--preset',
      '--audit-sink',
      '--audit-path',
      '--metrics-port',
      '--metrics-path',
      '--verify-evidence',
      '--config',
    ]) {
      expect(HELP_TEXT).toContain(flag);
    }
  });
});

describe('config file', () => {
  it('reads the same settings from YAML that the flags set', () => {
    const parsed = parseConfigFile(
      [
        'spec: ./openapi.yaml',
        'upstream: https://api.example.com',
        'port: 7000',
        'preset: production',
        'audit:',
        '  sink: jsonl',
        '  path: ./audit.jsonl',
      ].join('\n'),
      'askturret.gateway.yaml',
    );

    expect(parsed.spec).toBe('./openapi.yaml');
    expect(parsed.port).toBe(7000);
    expect(parsed.preset).toBe('production');
    expect(parsed.audit).toEqual({ sink: 'jsonl', path: './audit.jsonl' });
  });

  it('reads JSON too', () => {
    const parsed = parseConfigFile('{"spec":"./a.json","port":9000}', 'gateway.json');

    expect(parsed.spec).toBe('./a.json');
    expect(parsed.port).toBe(9000);
  });

  it('refuses an unknown setting and lists the known ones', () => {
    // A typo boots a gateway that looks configured and is not. The message
    // names the alternatives because an operator who typed `upsteam` wants to
    // be shown `upstream`, not just told no.
    expect(() => parseConfigFile('upsteam: https://x', 'g.yaml')).toThrow(/Unknown setting 'upsteam'/);
    expect(() => parseConfigFile('upsteam: https://x', 'g.yaml')).toThrow(/upstream/);
  });

  it('refuses an unknown key inside audit', () => {
    expect(() => parseConfigFile('audit:\n  sync: jsonl', 'g.yaml')).toThrow(/audit.sync/);
  });

  it('refuses a top-level list or scalar', () => {
    expect(() => parseConfigFile('- a\n- b', 'g.yaml')).toThrow(/mapping of settings/);
  });

  it('reports the file name when the YAML itself will not parse', () => {
    // core's parser refuses what it does not understand rather than guessing;
    // the gateway's job is to say WHICH FILE it was reading, since an operator
    // may have passed several and the parser only knows about text.
    //
    // An anchor is used because it is genuinely refused. Note that core's
    // yaml.ts header also lists "flow collections" as refused and they are in
    // fact parsed (`spec: [a, b]` yields an array) — a stale comment in core
    // rather than a gateway problem, but worth not encoding here.
    expect(() => parseConfigFile('spec: &anchor value', 'weird.yaml')).toThrow(/weird.yaml/);
    expect(() => parseConfigFile('spec: &anchor value', 'weird.yaml')).toThrow(GatewayConfigError);
  });

  it('accepts a single overlay as a bare string', () => {
    expect(parseConfigFile('overlay: ./one.yaml', 'g.yaml').overlay).toEqual(['./one.yaml']);
  });

  it('reads permissions as operation id to permission names', () => {
    const parsed = parseConfigFile(
      ['permissions:', '  listPets:', '    - pets:read', '    - pets:list'].join('\n'),
      'g.yaml',
    );

    expect(parsed.permissions).toEqual({ listPets: ['pets:read', 'pets:list'] });
  });
});

describe('precedence and validation', () => {
  it('lets a CLI flag beat the config file', () => {
    // The direction every operator expects: edit the file for the steady state,
    // override one value to try something.
    const merged = resolveConfig({ spec: './a.yaml', port: 7000 }, { port: 8080 });

    expect(merged.port).toBe(8080);
    expect(merged.spec).toBe('./a.yaml');
  });

  it('merges audit field-wise, so a flag does not erase the file’s sink', () => {
    // A shallow object replace would drop `sink` here, leaving a gateway
    // auditing to stdout while the file said jsonl.
    const merged = resolveConfig(
      { spec: './a.yaml', audit: { sink: 'jsonl', path: './from-file.jsonl' } },
      { audit: { path: './from-flag.jsonl' } },
    );

    expect(merged.audit).toEqual({ sink: 'jsonl', path: './from-flag.jsonl' });
  });

  it('refuses a config with no spec', () => {
    expect(() => resolveConfig({}, {})).toThrow(/No OpenAPI spec supplied/);
  });

  it('refuses jsonl with no path', () => {
    expect(() => resolveConfig({}, { spec: './a.yaml', audit: { sink: 'jsonl' } })).toThrow(
      /needs a path/,
    );
  });

  it('refuses the MCP port and the metrics port being the same', () => {
    // Otherwise the failure surfaces as EADDRINUSE from whichever bound
    // second — a message naming neither setting.
    expect(() => resolveConfig({}, { spec: './a.yaml', port: 9464, metricsPort: 9464 })).toThrow(
      /different ports/,
    );
  });

  it('allows both ports to be 0, because the OS assigns two different ones', () => {
    expect(() => resolveConfig({}, { spec: './a.yaml', port: 0, metricsPort: 0 })).not.toThrow();
  });

  it('refuses a base path that is not rooted', () => {
    expect(() => resolveConfig({}, { spec: './a.yaml', basePath: 'mcp' })).toThrow(/must start with/);
  });

  it('defaults to the §57 invocation’s shape', () => {
    const merged = resolveConfig({}, { spec: './a.yaml' });

    expect(merged.port).toBe(7000);
    expect(merged.basePath).toBe('/mcp');
    expect(merged.preset).toBe('light');
    expect(merged.audit.sink).toBe('stdout');
    expect(merged.metricsPort).toBe(9464);
  });
});
