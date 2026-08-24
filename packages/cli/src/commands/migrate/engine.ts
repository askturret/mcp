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
 * Where an occurrence sits syntactically. Drives rewrite-or-refuse (#193).
 *
 * Only the first two are rewritten. Everything else is reported, because in
 * those positions the identifier is either not the import at all, or renaming
 * it would change something other than a reference to the import.
 */
type OccurrenceKind =
  | 'import-specifier'
  | 'reference'
  | 'property-access'
  | 'object-key'
  | 'shorthand'
  | 'binding';

const REFUSAL_REASON: Readonly<Record<string, string>> = {
  'property-access': 'property access — the object may be the adopter\'s own',
  'object-key': 'object key — renaming it changes the emitted data shape',
  shorthand: 'object shorthand — renaming it changes the emitted key',
  binding: 'local binding — the tool does not edit adopter logic',
};

/** Innermost unclosed bracket at each index, so `{` can be told from `(`. */
function bracketContexts(masked: string): readonly (string | null)[] {
  const out: (string | null)[] = new Array(masked.length).fill(null);
  const stack: string[] = [];

  for (let k = 0; k < masked.length; k += 1) {
    out[k] = stack.length > 0 ? (stack[stack.length - 1] as string) : null;
    const c = masked[k];
    if (c === '{' || c === '(' || c === '[') stack.push(c);
    else if (c === '}' || c === ')' || c === ']') stack.pop();
  }

  return out;
}

function prevNonSpace(s: string, index: number): string {
  for (let k = index - 1; k >= 0; k -= 1) {
    if (!/\s/.test(s[k] as string)) return s[k] as string;
  }
  return '';
}

function nextNonSpace(s: string, index: number): string {
  for (let k = index; k < s.length; k += 1) {
    if (!/\s/.test(s[k] as string)) return s[k] as string;
  }
  return '';
}

/** The identifier immediately preceding `index`, if any. */
function precedingWord(s: string, index: number): string {
  const m = /([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(s.slice(0, index));
  return m?.[1] ?? '';
}

const BINDING_KEYWORDS = new Set(['const', 'let', 'var', 'function', 'class']);

/**
 * Byte ranges of `import … from '…'` statements.
 *
 * Matched against the ORIGINAL text because the mask blanks string literals,
 * which is where the module specifier lives. Each hit is then confirmed against
 * the mask, so an `import` appearing inside a comment or a string is not
 * mistaken for a statement.
 */
function importRanges(contents: string, masked: string): ReadonlyArray<readonly [number, number]> {
  const ranges: [number, number][] = [];
  const re = /\bimport\b[^;]*?\bfrom\b\s*['"][^'"]+['"]/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(contents)) !== null) {
    if (/\s/.test(masked[m.index] as string)) continue; // the keyword was masked
    ranges.push([m.index, m.index + m[0].length]);
  }

  return ranges;
}

function classifyOccurrence(
  masked: string,
  index: number,
  length: number,
  brackets: readonly (string | null)[],
  imports: ReadonlyArray<readonly [number, number]>,
): OccurrenceKind {
  // The import specifier is the one occurrence we can positively identify, and
  // the whole point of the rule. Checked first because it also has the SHAPE of
  // shorthand — `import { durability }` — and would otherwise be refused.
  if (imports.some(([start, end]) => index >= start && index < end)) return 'import-specifier';

  const prev = prevNonSpace(masked, index);
  const next = nextNonSpace(masked, index + length);

  // `cfg.durability` — `cfg` may be the adopter's own object, and nothing here
  // can establish that it is not. This is #193's worst case: it type-checks.
  if (prev === '.') return 'property-access';

  // `{ durability: … }` — the key. Renaming it changes the data shape.
  // Also catches type members. Over-refuses a ternary's `? durability :`,
  // which is a false refusal in the safe direction and is reported.
  if (next === ':') return 'object-key';

  // `{ durability }` / `{ a, durability }` — shorthand, whose emitted key is
  // the identifier itself. The bracket context is what separates this from
  // `f(a, durability, b)` and `[a, durability, b]`, which are plain references.
  if (brackets[index] === '{' && (prev === '{' || prev === ',') && (next === '}' || next === ',')) {
    return 'shorthand';
  }

  if (BINDING_KEYWORDS.has(precedingWord(masked, index))) return 'binding';

  return 'reference';
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
 *
 * ## Syntactic position, not just whole-word (#193)
 *
 * The file gate above is sound, but it was the ONLY gate: once a file imported
 * the identifier, every whole-word occurrence in it was rewritten regardless of
 * where it sat. QA found two cases that corrupt adopter code AND COMPILE, so
 * the compile-error backstop this design leans on does not see them:
 *
 *   const cfg = { durability: 'required' };
 *   console.log(cfg.durability);          // → cfg.durable — a different object
 *
 *   const o = { durability };             // → { durable } — a different key
 *
 * The second is the more instructive one. `{ durability }` has key
 * `"durability"`; the correct rename is `{ durability: durable }`, not
 * `{ durable }`. Producing the wrong one silently is exactly what "reports what
 * it cannot establish" promised not to do.
 *
 * So each occurrence is now classified before it is touched, and only two
 * positions are rewritten: the import specifier, and a plain reference.
 * Everything else becomes a `manual` finding with its line number.
 *
 * ## What refusing costs, and why it is still right
 *
 * If a refused occurrence really WAS the import — `{ durability }` where
 * `durability` is the imported symbol — the import is renamed and this is not,
 * so the file stops compiling and the adopter is told. That is the same failure
 * mode #191 accepted for template literals, and the same one this whole design
 * prefers: loud and wrong-way-safe rather than quiet and plausible.
 *
 * ## Known gap, stated rather than implied
 *
 * A shadowing PARAMETER — `function f(durability) { return durability; }` — is
 * still rewritten. Distinguishing a parameter list from a call's argument list
 * needs to look back past the `(` for a `function` keyword or forward past the
 * `)` for `=>`, and doing it partially would be worse than not doing it: it
 * would refuse some shadowed parameters and rewrite others, with nothing to
 * tell them apart in the output. The rename stays consistent within the scope,
 * so behaviour is unchanged — which is why #193 rates it lower severity and
 * explicitly out of remit. Declaration bindings (`const durability = …`) ARE
 * refused, because those are cheap to establish and unambiguous.
 */
function rewriteSource(
  contents: string,
  rule: SourceRule,
  file: string,
): { contents: string; findings: readonly Finding[]; changed: boolean } {
  const importsIt = new RegExp(
    `import[^;]*\\b${rule.from}\\b[^;]*from\\s*['"]${rule.module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  ).test(contents);

  if (!importsIt) return { contents, findings: [], changed: false };

  if (rule.to === undefined) {
    return {
      contents,
      findings: [
        {
          ruleId: rule.id,
          kind: 'source',
          file,
          action: 'manual',
          detail: `'${rule.from}' was removed from ${rule.module}. ${rule.reason}`,
        },
      ],
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

  if (indices.length === 0) return { contents, findings: [], changed: false };

  const brackets = bracketContexts(masked);
  const imports = importRanges(contents, masked);
  const lineOf = (index: number): number => contents.slice(0, index).split('\n').length;

  const rewritable: number[] = [];
  const refused: { line: number; kind: OccurrenceKind }[] = [];

  for (const index of indices) {
    const kind = classifyOccurrence(masked, index, rule.from.length, brackets, imports);
    if (kind === 'import-specifier' || kind === 'reference') rewritable.push(index);
    else refused.push({ line: lineOf(index), kind });
  }

  // Reverse order so an earlier replacement cannot shift a later index.
  let out = contents;
  for (const index of [...rewritable].reverse()) {
    out = out.slice(0, index) + rule.to + out.slice(index + rule.from.length);
  }

  const findings: Finding[] = [];

  if (rewritable.length > 0) {
    findings.push({
      ruleId: rule.id,
      kind: 'source',
      file,
      action: 'rewrite',
      detail: `${String(rewritable.length)} occurrence(s) of '${rule.from}' → '${rule.to}'. ${rule.reason}`,
    });
  }

  if (refused.length > 0) {
    // Grouped by position kind, with line numbers: an adopter needs to know
    // WHICH occurrences were left and why, or the finding is just an apology.
    const byKind = new Map<OccurrenceKind, number[]>();
    for (const r of refused) {
      const lines = byKind.get(r.kind) ?? [];
      lines.push(r.line);
      byKind.set(r.kind, lines);
    }

    const described = [...byKind.entries()]
      .map(([kind, lines]) => `line(s) ${lines.join(', ')}: ${REFUSAL_REASON[kind] ?? kind}`)
      .join('; ');

    findings.push({
      ruleId: rule.id,
      kind: 'source',
      file,
      action: 'manual',
      detail:
        `${String(refused.length)} occurrence(s) of '${rule.from}' left alone because renaming ` +
        `them could change something other than a reference to the import — ${described}. ` +
        `Check each and rename by hand where it is the import. ${rule.reason}`,
    });
  }

  return { contents: out, findings, changed: rewritable.length > 0 };
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
          // Plural since #193: one file can now yield a `rewrite` for the
          // occurrences it could establish AND a `manual` for the ones it
          // refused, and dropping either would misreport what happened.
          findings.push(...result.findings);
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
