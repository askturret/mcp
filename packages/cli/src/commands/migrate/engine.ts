// SPDX-License-Identifier: Apache-2.0
/**
 * The migration engine (#62).
 *
 * Applies a migration's rules to a project. Pure with respect to the
 * filesystem: it takes files in and returns files out, so `--check` and the
 * real run are the SAME code path with one difference — whether the caller
 * writes the result. A dry-run implemented as a separate branch is a dry-run
 * that eventually disagrees with the thing it is previewing.
 */

import type {
  ConfigRule,
  Finding,
  Migration,
  MigrationResult,
  OutputRule,
  OverlayRule,
  SourceRule,
} from './types.js';

/** A file the engine was given, and may hand back changed. */
export interface ProjectFile {
  /** Repo-relative path, used in findings. */
  readonly path: string;
  readonly contents: string;
}

export interface ApplyOptions {
  readonly files: readonly ProjectFile[];
  readonly migrations: readonly Migration[];
}

// ---------------------------------------------------------------------------
// Dotted-path helpers
// ---------------------------------------------------------------------------

function getPath(root: unknown, path: string): { found: boolean; value: unknown } {
  let node: unknown = root;
  for (const segment of path.split('.')) {
    if (node === null || typeof node !== 'object' || !(segment in (node as object))) {
      return { found: false, value: undefined };
    }
    node = (node as Record<string, unknown>)[segment];
  }
  return { found: true, value: node };
}

function deletePath(root: unknown, path: string): void {
  const segments = path.split('.');
  const last = segments.pop() as string;
  let node: unknown = root;
  for (const segment of segments) {
    if (node === null || typeof node !== 'object') return;
    node = (node as Record<string, unknown>)[segment];
  }
  if (node !== null && typeof node === 'object') {
    delete (node as Record<string, unknown>)[last];
  }
}

function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  const last = segments.pop() as string;
  let node: Record<string, unknown> = root;
  for (const segment of segments) {
    const next = node[segment];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      node[segment] = {};
    }
    node = node[segment] as Record<string, unknown>;
  }
  node[last] = value;
}

// ---------------------------------------------------------------------------
// Rule application
// ---------------------------------------------------------------------------

/**
 * Move or report one dotted key inside a parsed JSON document.
 *
 * Shared by the config and overlay rules because the operation is identical —
 * only the file selection and the path root differ. Two copies would be two
 * places for "removed means report, never delete" to drift.
 */
function moveKey(
  document: Record<string, unknown>,
  rule: ConfigRule | OverlayRule,
  file: string,
  root = '',
): { finding: Finding | null; changed: boolean } {
  const from = root === '' ? rule.from : `${root}.${rule.from}`;
  const { found, value } = getPath(document, from);
  if (!found) return { finding: null, changed: false };

  if (rule.to === undefined) {
    // REMOVED. Reported, never deleted: the setting is something the adopter
    // wrote on purpose, and dropping it silently would change their runtime
    // behaviour in a commit that claimed to be a mechanical migration.
    return {
      finding: {
        ruleId: rule.id,
        kind: rule.kind,
        file,
        action: 'manual',
        detail: `'${from}' no longer exists. ${rule.reason} Remove it yourself once you have decided what replaces it.`,
      },
      changed: false,
    };
  }

  const to = root === '' ? rule.to : `${root}.${rule.to}`;
  const next = rule.value === undefined ? value : rule.value(value);
  deletePath(document, from);
  setPath(document, to, next);

  return {
    finding: {
      ruleId: rule.id,
      kind: rule.kind,
      file,
      action: 'rewrite',
      detail: `'${from}' → '${to}'. ${rule.reason}`,
    },
    changed: true,
  };
}

/**
 * Rewrite a renamed export at its import site and its call sites.
 *
 * ## Not an AST codemod, deliberately
 *
 * §62 suggests jscodeshift. This does not use one, and the reason is a cost the
 * issue could not see: adding a codemod toolchain is a RUNTIME dependency in a
 * repository that runs a licence gate, an SBOM and a NOTICE obligation, for a
 * job that is renaming identifiers.
 *
 * So the rewrite is conservative and knows it. It only acts on a file that
 * imports the identifier from the declaring module — so an unrelated local
 * called `Server` is never touched — and it rewrites whole-word occurrences
 * outside strings and comments. Anything it cannot establish, it REPORTS.
 *
 * The failure modes are opposite and unequal: a missed rename is a compile
 * error the adopter sees immediately, and a wrong rewrite is a silent edit to
 * their source. Erring toward reporting is the only defensible direction.
 */
function rewriteSource(
  contents: string,
  rule: SourceRule,
  file: string,
): { contents: string; finding: Finding | null; changed: boolean } {
  const importsIt = new RegExp(
    `import[^;]*\\b${rule.from}\\b[^;]*from\\s*['"]${rule.module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  ).test(contents);

  if (!importsIt) return { contents, finding: null, changed: false };

  if (rule.to === undefined) {
    return {
      contents,
      finding: {
        ruleId: rule.id,
        kind: 'source',
        file,
        action: 'manual',
        detail: `'${rule.from}' was removed from ${rule.module}. ${rule.reason}`,
      },
      changed: false,
    };
  }

  // Mask strings and comments so an occurrence inside either is left alone,
  // then map replacements back onto the original text by index.
  const masked = contents
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, (m) => ' '.repeat(m.length));

  const word = new RegExp(`\\b${rule.from}\\b`, 'g');
  const indices: number[] = [];
  let match;
  while ((match = word.exec(masked)) !== null) indices.push(match.index);

  if (indices.length === 0) return { contents, finding: null, changed: false };

  let out = contents;
  for (const index of [...indices].reverse()) {
    out = out.slice(0, index) + rule.to + out.slice(index + rule.from.length);
  }

  return {
    contents: out,
    finding: {
      ruleId: rule.id,
      kind: 'source',
      file,
      action: 'rewrite',
      detail: `${String(indices.length)} occurrence(s) of '${rule.from}' → '${rule.to}'. ${rule.reason}`,
    },
    changed: true,
  };
}

/**
 * Report a machine-readable output whose shape moved.
 *
 * Always `manual`. The consumer is the adopter's own script or dashboard —
 * §62 puts adopter logic explicitly out of scope, and a tool that edited a
 * jq expression it found in a YAML file would be guessing at intent.
 */
function reportOutput(rule: OutputRule): Finding {
  return {
    ruleId: rule.id,
    kind: 'output',
    file: rule.surface,
    action: 'manual',
    // `file` already carries the surface, and the printer prefixes it — so the
    // detail must not repeat it or the line reads "describePreset():
    // describePreset(): …".
    detail:
      rule.to === undefined
        ? `'${rule.from}' was removed. ${rule.reason}`
        : `'${rule.from}' → '${rule.to}'. ${rule.reason}`,
  };
}

// ---------------------------------------------------------------------------

/**
 * Which files each rule kind is allowed to touch.
 *
 * OVERLAY is tested FIRST and CONFIG excludes it, because the two patterns
 * genuinely overlap: `askturret.mcp.json` is an overlay, and it also looks like
 * an `askturret*.json` config. Without the exclusion a config rule would
 * happily rewrite a dotted path inside an overlay document — silently, since
 * both are JSON and both parse.
 */
const OVERLAY_FILE = /(^|\/)(askturret\.mcp|[\w.-]*overlay[\w.-]*)\.(json|ya?ml)$/;
const CONFIG_FILE = /(^|\/)askturret[.\w-]*\.(json|ya?ml)$/;
const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function isOverlayPath(path: string): boolean {
  return OVERLAY_FILE.test(path);
}

function isConfigPath(path: string): boolean {
  return CONFIG_FILE.test(path) && !isOverlayPath(path);
}

/** JSON only — YAML is reported rather than rewritten. See the note below. */
function parseJson(contents: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(contents);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Apply every rule of every migration to every file.
 *
 * Returns the changed files rather than writing them, so `--check` and the real
 * run share this exactly.
 */
export function applyMigrations(options: ApplyOptions): MigrationResult & {
  readonly files: readonly ProjectFile[];
} {
  const findings: Finding[] = [];
  const changed = new Set<string>();
  const files = options.files.map((f) => ({ ...f }));

  for (const migration of options.migrations) {
    for (const rule of migration.rules) {
      if (rule.kind === 'output') {
        findings.push(reportOutput(rule));
        continue;
      }

      for (const file of files) {
        const isConfig = rule.kind === 'config' && isConfigPath(file.path);
        const isOverlay = rule.kind === 'overlay' && isOverlayPath(file.path);
        const isSource = rule.kind === 'source' && SOURCE_FILE.test(file.path);

        if (isSource) {
          const result = rewriteSource(file.contents, rule, file.path);
          if (result.finding) findings.push(result.finding);
          if (result.changed) {
            (file as { contents: string }).contents = result.contents;
            changed.add(file.path);
          }
          continue;
        }

        if (!isConfig && !isOverlay) continue;

        const document = parseJson(file.contents);
        if (document === null) {
          // A YAML config the engine will not rewrite. Reported so it is
          // visibly out of scope rather than silently skipped — a migration
          // that quietly ignored half an adopter's files would be worse than
          // one that admits its limit.
          if (file.contents.includes(rule.from.split('.')[0] as string)) {
            findings.push({
              ruleId: rule.id,
              kind: rule.kind,
              file: file.path,
              action: 'manual',
              detail:
                `Not rewritten: only JSON config and overlay files are edited automatically. ` +
                `Apply '${rule.from}' → '${rule.to ?? '(removed)'}' by hand. ${rule.reason}`,
            });
          }
          continue;
        }

        // Whether THIS rule changed THIS document. Deliberately not the global
        // `changed` set: keying re-serialisation on that would write a document
        // back whenever the file had been touched by any earlier rule —
        // including one that returned `changed: false` after mutating nothing
        // it intended to keep. Scoping it here means a rule that reports
        // instead of rewriting cannot have its parse persisted by accident.
        let ruleChangedThisFile = false;

        // Overlay rules address a path inside each operation patch, not the
        // document root — `effects.classifications` means "on every operation".
        if (isOverlay) {
          const operations = document['operations'];
          if (operations === null || typeof operations !== 'object') continue;
          for (const operationId of Object.keys(operations as Record<string, unknown>)) {
            const result = moveKey(
              document,
              rule as OverlayRule,
              file.path,
              `operations.${operationId}`,
            );
            if (result.finding) findings.push(result.finding);
            if (result.changed) ruleChangedThisFile = true;
          }
        } else {
          const result = moveKey(document, rule as ConfigRule, file.path);
          if (result.finding) findings.push(result.finding);
          if (result.changed) ruleChangedThisFile = true;
        }

        if (ruleChangedThisFile) {
          changed.add(file.path);
          (file as { contents: string }).contents = `${JSON.stringify(document, null, 2)}\n`;
        }
      }
    }
  }

  return {
    migrations: options.migrations,
    findings,
    changed: [...changed],
    // Only a rewrite counts. A `manual` finding needs a human but is not
    // something `migrate` would have written, so it must not make an
    // already-migrated project fail `--check` forever.
    changesNeeded: changed.size > 0,
    files,
  };
}
