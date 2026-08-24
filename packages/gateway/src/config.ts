// SPDX-License-Identifier: Apache-2.0
/**
 * Gateway configuration — CLI flags and config file (§11.3, #57).
 *
 * ## Two surfaces, one schema
 *
 * `--upstream https://api.example.com` and `upstream: https://api.example.com`
 * in a config file mean the same thing and land in the same field. They are
 * parsed separately and merged, rather than one being translated into the
 * other, because a translation layer is a second place for a key to be spelled
 * differently.
 *
 * ## Precedence: CLI over file, always
 *
 * A flag typed at the terminal beats the file it names. That is the direction
 * every operator expects — you edit the file for the steady state and override
 * one value to try something — and the reverse would make `--port` silently
 * inert whenever a config file happened to set a port.
 *
 * ## Unknown keys are REFUSED, not ignored
 *
 * A typo in a config file is far likelier than a feature request, and silently
 * ignoring `upsteam:` means the gateway boots pointing at nothing while looking
 * like it worked. Same reasoning core's overlay loader gives for the same
 * decision, and the same reasoning applies harder here: this file chooses which
 * upstream an agent's calls reach.
 */

import { parseYamlSubset } from '@askturret/mcp-core';

/** Presets the gateway accepts, mirroring the library's (§10.2). */
export type GatewayPreset = 'light' | 'production' | 'regulated';

/**
 * Audit sink selection.
 *
 * `stdout` is offered and is the default precisely BECAUSE the Regulated preset
 * refuses it — a gateway that hid the option could not demonstrate the refusal,
 * and an operator moving from Light to Regulated needs to hit that wall at boot
 * rather than discover the rule in prose.
 */
export interface GatewayAuditConfig {
  readonly sink: 'stdout' | 'jsonl' | 'none';
  /** Required when `sink` is `jsonl`. */
  readonly path?: string;
}

export interface GatewayConfig {
  /** OpenAPI spec path or URL. Required — the gateway has nothing to serve without one. */
  readonly spec: string;
  /** Overlay files, applied in order (§5.3). */
  readonly overlay: readonly string[];
  /**
   * Upstream base URL.
   *
   * Optional: a spec whose `servers` array names an absolute URL already says
   * where to go. Supplying it overrides the spec, which is the common case when
   * the spec was written against production and you are pointing at staging.
   */
  readonly upstream?: string;
  readonly port: number;
  readonly host: string;
  readonly basePath: string;
  readonly preset: GatewayPreset;
  readonly audit: GatewayAuditConfig;
  /** Prometheus scrape port. Deliberately separate from `port` — see server.ts. */
  readonly metricsPort: number;
  readonly metricsPath: string;
  /**
   * Module specifier exporting `verifyEvidence`, for the Regulated preset.
   *
   * A path rather than a value because `verifyEvidence` is a FUNCTION, and no
   * config file can hold one. See preset.ts for why the gateway does not
   * substitute a default.
   */
  readonly verifyEvidenceModule?: string;
  /** Regulated's redaction-review signature. Must be true under Regulated. */
  readonly customReviewAcknowledged: boolean;
  /** Operation id → required permissions, for the Production/Regulated policy. */
  readonly permissions: Readonly<Record<string, readonly string[]>>;
  readonly requestMaxBytes?: number;
  readonly responseMaxBytes?: number;
  readonly deadlineMs?: number;
}

/** A configuration the gateway cannot act on. Carries the offending key. */
export class GatewayConfigError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(message);
    this.name = 'GatewayConfigError';
    this.key = key;
  }
}

/**
 * Defaults.
 *
 * `preset: 'light'` matches the library's facade default. `audit.sink: stdout`
 * is the only sink that needs no filesystem, so it is what a `docker run` with
 * no volume gets.
 */
const DEFAULTS = {
  overlay: [] as readonly string[],
  port: 7000,
  host: '0.0.0.0',
  basePath: '/mcp',
  preset: 'light' as GatewayPreset,
  metricsPort: 9464,
  metricsPath: '/metrics',
  customReviewAcknowledged: false,
  permissions: {} as Readonly<Record<string, readonly string[]>>,
} as const;

const PRESETS: readonly string[] = ['light', 'production', 'regulated'];
const SINKS: readonly string[] = ['stdout', 'jsonl', 'none'];

/**
 * Every key a config FILE may set.
 *
 * Kept as data so the unknown-key refusal can name the alternatives rather than
 * just saying no — an operator who typed `upsteam` wants to be shown `upstream`.
 */
const FILE_KEYS: readonly string[] = [
  'spec',
  'overlay',
  'upstream',
  'port',
  'host',
  'basePath',
  'preset',
  'audit',
  'metricsPort',
  'metricsPath',
  'verifyEvidenceModule',
  'customReviewAcknowledged',
  'permissions',
  'requestMaxBytes',
  'responseMaxBytes',
  'deadlineMs',
];

/** Partial config, as produced by either surface before merging. */
export type PartialGatewayConfig = Partial<Omit<GatewayConfig, 'audit'>> & {
  readonly audit?: Partial<GatewayAuditConfig>;
};

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

/** Flags that take a value, mapped to the config key they set. */
const VALUE_FLAGS: Readonly<Record<string, string>> = {
  '--spec': 'spec',
  '--overlay': 'overlay',
  '--upstream': 'upstream',
  '--port': 'port',
  '--host': 'host',
  '--base-path': 'basePath',
  '--preset': 'preset',
  '--audit-sink': 'auditSink',
  '--audit-path': 'auditPath',
  '--metrics-port': 'metricsPort',
  '--metrics-path': 'metricsPath',
  '--verify-evidence': 'verifyEvidenceModule',
  '--config': 'config',
};

export interface ParsedArgs {
  readonly config: PartialGatewayConfig;
  /** `--config <path>`, handled by the caller because it selects the file. */
  readonly configPath?: string;
  readonly help: boolean;
  readonly version: boolean;
}

/**
 * Parse `process.argv.slice(2)`.
 *
 * Hand-written rather than a flag library: this package's dependency list is
 * four workspace packages and nothing else, and core's zero-dependency stance
 * is part of why the whole thing is adoptable without a supply-chain review.
 * The grammar here is small enough that a parser is cheaper than the argument.
 *
 * `--overlay` REPEATS rather than replacing, because overlays compose — §5.3
 * applies them in order, and a second `--overlay` that silently dropped the
 * first would change which fields an agent sees.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: Record<string, unknown> = {};
  const overlays: string[] = [];
  let help = false;
  let version = false;
  let configPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;

    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--version' || arg === '-V') {
      version = true;
      continue;
    }
    if (arg === '--acknowledge-redaction-review') {
      out['customReviewAcknowledged'] = true;
      continue;
    }

    // `--key=value` and `--key value` both work; operators use both and a
    // parser that accepted only one would reject a correct command line.
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

    const key = VALUE_FLAGS[flag];
    if (key === undefined) {
      throw new GatewayConfigError(
        flag,
        `Unknown flag '${flag}'. Run with --help for the supported flags.`,
      );
    }

    let value = inlineValue;
    if (value === undefined) {
      value = argv[i + 1];
      i += 1;
    }
    if (value === undefined || value.startsWith('--')) {
      throw new GatewayConfigError(flag, `Flag '${flag}' requires a value.`);
    }

    if (key === 'config') {
      configPath = value;
    } else if (key === 'overlay') {
      overlays.push(value);
    } else {
      out[key] = value;
    }
  }

  if (overlays.length > 0) out['overlay'] = overlays;

  return {
    config: coerceFlags(out),
    ...(configPath === undefined ? {} : { configPath }),
    help,
    version,
  };
}

/**
 * Turn flag strings into typed values.
 *
 * Every flag arrives as a string; a port silently staying `"7000"` would bind
 * fine and then compare wrong everywhere else.
 */
function coerceFlags(raw: Record<string, unknown>): PartialGatewayConfig {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case 'port':
      case 'metricsPort':
      case 'requestMaxBytes':
      case 'responseMaxBytes':
      case 'deadlineMs':
        out[key] = requireInteger(`--${key}`, value);
        break;
      case 'auditSink':
      case 'auditPath':
        break; // folded into `audit` below
      default:
        out[key] = value;
    }
  }

  const sink = raw['auditSink'];
  const path = raw['auditPath'];
  if (sink !== undefined || path !== undefined) {
    out['audit'] = {
      ...(sink === undefined ? {} : { sink: requireSink('--audit-sink', sink) }),
      ...(path === undefined ? {} : { path: String(path) }),
    };
  }

  if (out['preset'] !== undefined) {
    out['preset'] = requirePreset('--preset', out['preset']);
  }

  return out as PartialGatewayConfig;
}

// ---------------------------------------------------------------------------
// Config file
// ---------------------------------------------------------------------------

/**
 * Parse a config file's TEXT into a partial config.
 *
 * Takes text rather than a path so the caller owns the filesystem read — that
 * keeps this module pure and testable without fixtures on disk.
 *
 * YAML goes through core's `parseYamlSubset`, which REFUSES what it does not
 * understand rather than guessing. That property is the whole reason it is
 * reused here instead of adding a YAML dependency: a mis-parsed `upstream` is a
 * gateway proxying somewhere nobody asked for.
 */
export function parseConfigFile(text: string, location: string): PartialGatewayConfig {
  const isJson = location.endsWith('.json');
  let parsed: unknown;

  try {
    parsed = isJson ? JSON.parse(text) : parseYamlSubset(text);
  } catch (error) {
    throw new GatewayConfigError(
      location,
      `Could not parse config file '${location}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GatewayConfigError(
      location,
      `Config file '${location}' must contain a mapping of settings at the top level.`,
    );
  }

  const raw = parsed as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (FILE_KEYS.includes(key)) continue;
    throw new GatewayConfigError(
      key,
      `Unknown setting '${key}' in '${location}'. Known settings: ${FILE_KEYS.join(', ')}. ` +
        `Unknown keys are refused rather than ignored — a typo here would boot a gateway ` +
        `that looks configured and is not.`,
    );
  }

  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case 'port':
      case 'metricsPort':
      case 'requestMaxBytes':
      case 'responseMaxBytes':
      case 'deadlineMs':
        out[key] = requireInteger(key, value);
        break;
      case 'preset':
        out[key] = requirePreset(key, value);
        break;
      case 'overlay':
        out[key] = requireStringArray(key, value);
        break;
      case 'customReviewAcknowledged':
        out[key] = requireBoolean(key, value);
        break;
      case 'audit':
        out[key] = parseAuditSection(value);
        break;
      case 'permissions':
        out[key] = parsePermissions(value);
        break;
      default:
        out[key] = requireString(key, value);
    }
  }

  return out as PartialGatewayConfig;
}

function parseAuditSection(value: unknown): Partial<GatewayAuditConfig> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayConfigError('audit', `'audit' must be a mapping, e.g. { sink: jsonl, path: ./audit.jsonl }.`);
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key === 'sink' || key === 'path') continue;
    throw new GatewayConfigError(`audit.${key}`, `Unknown setting 'audit.${key}'. Known: sink, path.`);
  }
  return {
    ...(raw['sink'] === undefined ? {} : { sink: requireSink('audit.sink', raw['sink']) }),
    ...(raw['path'] === undefined ? {} : { path: requireString('audit.path', raw['path']) }),
  };
}

function parsePermissions(value: unknown): Readonly<Record<string, readonly string[]>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayConfigError(
      'permissions',
      `'permissions' must be a mapping of operation id to a list of permission names.`,
    );
  }
  const out: Record<string, readonly string[]> = {};
  for (const [operationId, granted] of Object.entries(value as Record<string, unknown>)) {
    out[operationId] = requireStringArray(`permissions.${operationId}`, granted);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merge + validate
// ---------------------------------------------------------------------------

/**
 * Merge file and CLI layers over the defaults, then validate.
 *
 * The order is defaults → file → CLI, so a flag always wins. `audit` merges
 * FIELD-WISE rather than wholesale: `--audit-path` on the command line must not
 * erase `audit.sink` from the file, which a shallow object replace would do.
 */
export function resolveConfig(
  file: PartialGatewayConfig,
  cli: PartialGatewayConfig,
): GatewayConfig {
  const merged: Record<string, unknown> = {
    ...DEFAULTS,
    ...stripUndefined(file),
    ...stripUndefined(cli),
  };

  merged['audit'] = {
    sink: cli.audit?.sink ?? file.audit?.sink ?? 'stdout',
    ...(cli.audit?.path ?? file.audit?.path ? { path: cli.audit?.path ?? file.audit?.path } : {}),
  };

  const config = merged as unknown as GatewayConfig;

  if (config.spec === undefined || config.spec === '') {
    throw new GatewayConfigError(
      'spec',
      `No OpenAPI spec supplied. Pass --spec ./openapi.yaml or set 'spec' in the config file — ` +
        `the gateway derives its entire tool surface from it and has nothing to serve without one.`,
    );
  }

  if (config.audit.sink === 'jsonl' && (config.audit.path === undefined || config.audit.path === '')) {
    throw new GatewayConfigError(
      'audit.path',
      `audit.sink 'jsonl' needs a path. Pass --audit-path ./audit.jsonl or set 'audit.path'.`,
    );
  }

  assertPort('port', config.port);
  assertPort('metricsPort', config.metricsPort);

  // Two listeners cannot share a port, and the failure would otherwise surface
  // as EADDRINUSE from whichever bound second — a message that names neither
  // setting and sends an operator looking for another process.
  //
  // Port 0 is EXEMPT, and not as a special case for tests: 0 means "let the OS
  // assign one", so two zeros produce two different ports rather than a clash.
  // Refusing it would be refusing the only configuration that is guaranteed not
  // to collide.
  if (config.port !== 0 && config.port === config.metricsPort) {
    throw new GatewayConfigError(
      'metricsPort',
      `port and metricsPort are both ${config.port}. The metrics endpoint listens separately so ` +
        `it can stay on an internal interface while the MCP port is exposed; give them different ports.`,
    );
  }

  if (!config.basePath.startsWith('/')) {
    throw new GatewayConfigError('basePath', `basePath must start with '/', got '${config.basePath}'.`);
  }

  return config;
}

/**
 * 0 is ALLOWED and means "let the OS assign an ephemeral port".
 *
 * That is the standard bind idiom, and it is genuinely useful in deployment —
 * a container with dynamic port mapping, or a sidecar that publishes whatever
 * it got. Rejecting it would refuse a correct configuration for the sake of a
 * tidier range check.
 */
function assertPort(key: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new GatewayConfigError(
      key,
      `${key} must be an integer between 0 and 65535 (0 = OS-assigned), got ${String(value)}.`,
    );
  }
}

function stripUndefined(value: PartialGatewayConfig): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key, v]) => v !== undefined && key !== 'audit'),
  );
}

// ---------------------------------------------------------------------------
// Coercion helpers — each names the key, because "expected a number" without
// one sends an operator reading the whole file.
// ---------------------------------------------------------------------------

function requireInteger(key: string, value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n)) {
    throw new GatewayConfigError(key, `'${key}' must be an integer, got '${String(value)}'.`);
  }
  return n;
}

function requireString(key: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new GatewayConfigError(key, `'${key}' must be a string, got ${typeof value}.`);
  }
  return value;
}

function requireBoolean(key: string, value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  throw new GatewayConfigError(key, `'${key}' must be true or false, got '${String(value)}'.`);
}

function requireStringArray(key: string, value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new GatewayConfigError(key, `'${key}' must be a string or a list of strings.`);
  }
  return value as readonly string[];
}

function requirePreset(key: string, value: unknown): GatewayPreset {
  const text = String(value);
  if (!PRESETS.includes(text)) {
    throw new GatewayConfigError(key, `'${key}' must be one of ${PRESETS.join(', ')}, got '${text}'.`);
  }
  return text as GatewayPreset;
}

function requireSink(key: string, value: unknown): GatewayAuditConfig['sink'] {
  const text = String(value);
  if (!SINKS.includes(text)) {
    throw new GatewayConfigError(key, `'${key}' must be one of ${SINKS.join(', ')}, got '${text}'.`);
  }
  return text as GatewayAuditConfig['sink'];
}

/** `--help` text. Exported so a test can assert every flag is documented. */
export const HELP_TEXT = `askturret-mcp-gateway — standalone MCP compatibility gateway

  npx @askturret/mcp-gateway --spec ./openapi.yaml --upstream https://api.example.com

Options:
  --spec <path|url>          OpenAPI 3.x specification (required)
  --overlay <path>           MCP overlay; repeat to apply several in order
  --upstream <url>           Upstream base URL (overrides the spec's servers)
  --port <n>                 MCP listen port (default 7000)
  --host <addr>              Listen address (default 0.0.0.0)
  --base-path <path>         MCP base path (default /mcp)
  --preset <name>            light | production | regulated (default light)
  --audit-sink <name>        stdout | jsonl | none (default stdout)
  --audit-path <path>        Audit file, required when --audit-sink jsonl
  --metrics-port <n>         Prometheus scrape port (default 9464)
  --metrics-path <path>      Prometheus scrape path (default /metrics)
  --verify-evidence <mod>    Module exporting verifyEvidence (Regulated only)
  --acknowledge-redaction-review
                             Regulated: record that redaction rules were reviewed
  --config <path>            YAML or JSON config file; flags override it
  --help, -h                 Show this message
  --version, -V              Show the gateway version
`;
