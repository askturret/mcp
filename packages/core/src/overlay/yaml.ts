// SPDX-License-Identifier: Apache-2.0
/**
 * A deliberately small YAML reader for overlay files (#55).
 *
 * ## Why this exists instead of a dependency
 *
 * `@askturret/mcp-core` has ZERO runtime dependencies, and that is a property
 * this repository has held on purpose — it is quoted in the README and is part
 * of why the package is adoptable inside a regulated deployment without a
 * supply-chain review. Adding a YAML parser to core would end it for one config
 * file format.
 *
 * `js-yaml` does exist in the tree today, but only TRANSITIVELY, via
 * swagger-parser inside `sources-openapi`. Reaching for it from core would be a
 * dependency we did not declare and could lose on any unrelated bump.
 *
 * ## The safety property that makes a hand-written parser defensible
 *
 * **It refuses what it does not understand.** Every construct outside the
 * supported subset throws with a line number — anchors, aliases, merge keys,
 * directives, multiple documents, flow mappings (`{a: b}`), nested flow
 * collections (`[[a], [b]]`), tabs. It never guesses.
 *
 * Flow SEQUENCES are the deliberate exception: they are SUPPORTED, one level
 * deep and scalars only, because §55's documented overlay format uses them
 * (`classifications: [financial]`). This list said "flow collections" until
 * #182, which read as refusing the whole category — wrong in the PERMISSIVE
 * direction, since the parser accepts what the claim said it rejected. That is
 * the direction that costs a reader's trust in a safety argument, which is what
 * this paragraph is.
 *
 * That is the whole argument. A partial YAML parser that silently mis-reads an
 * anchor produces an overlay that is subtly not what the adopter wrote, and
 * overlays change what an AGENT is told it may do — a mis-parsed
 * `classifications` is a missing confirmation prompt. Refusing to load is a
 * bad morning; loading the wrong thing is a bad quarter.
 *
 * ## The supported subset
 *
 * Nested block mappings, block sequences (`- item`), plain and quoted scalars,
 * block scalars (`|` and `>`), comments, `null`/`~`/empty, booleans, numbers,
 * and single-level flow sequences of scalars (`[a, b]`).
 * That covers §55's documented overlay format completely.
 *
 * JSON is parsed by `JSON.parse`, not by this — a `.json` overlay never touches
 * this code.
 */

/** Unsupported or malformed YAML. Carries the line so it can be found. */
export class YamlParseError extends Error {
  readonly line: number;

  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`);
    this.name = 'YamlParseError';
    this.line = line;
  }
}

interface Line {
  readonly indent: number;
  readonly content: string;
  readonly number: number;
}

const UNSUPPORTED: readonly { readonly test: RegExp; readonly why: string }[] = [
  // Anchors and aliases are matched in VALUE position as well as at the start
  // of a line — `key: &anchor value` is the common spelling, and an earlier
  // version of this list only caught the line-start form, so the construct it
  // was written to refuse sailed through.
  { test: /(^|:\s|^\s*-\s)&\S/, why: 'anchors are not supported' },
  { test: /(^|:\s|^\s*-\s)\*\S/, why: 'aliases are not supported' },
  { test: /^\s*---/, why: 'multiple documents are not supported' },
  { test: /^\s*%/, why: 'directives are not supported' },
  { test: /^\s*<<\s*:/, why: 'merge keys are not supported' },
];

function scan(text: string): Line[] {
  const lines: Line[] = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    const number = index + 1;

    if (raw.includes('\t')) {
      // YAML forbids tabs for indentation, and a tab that reached here would
      // otherwise be counted as one column and silently reshape the tree.
      throw new YamlParseError(number, 'tabs are not valid YAML indentation; use spaces');
    }

    for (const { test, why } of UNSUPPORTED) {
      if (test.test(raw)) throw new YamlParseError(number, why);
    }

    const withoutComment = stripComment(raw);
    if (withoutComment.trim() === '') return;

    lines.push({
      indent: withoutComment.length - withoutComment.trimStart().length,
      content: withoutComment.trimEnd(),
      number,
    });
  });

  return lines;
}

/** Drop a trailing `#` comment, but not one inside a quoted scalar. */
function stripComment(raw: string): string {
  let quote: string | undefined;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (quote !== undefined) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '#' && (i === 0 || /\s/.test(raw[i - 1] as string))) return raw.slice(0, i);
  }

  return raw;
}

/** Split `a, "b, c", d` on commas that are not inside quotes. */
function splitFlow(inner: string, line: number): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;

  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i] as string;
    if (quote !== undefined) {
      if (char === '\\') {
        current += char + (inner[i + 1] ?? '');
        i += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  if (quote !== undefined) throw new YamlParseError(line, 'unterminated quoted string in flow sequence');
  parts.push(current);

  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

function parseScalar(raw: string, line: number): unknown {
  const text = raw.trim();

  if (text === '' || text === 'null' || text === '~') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;

  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d*\.\d+$/.test(text)) return Number.parseFloat(text);

  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) {
      throw new YamlParseError(line, 'unterminated double-quoted string');
    }
    try {
      return JSON.parse(text) as string;
    } catch {
      throw new YamlParseError(line, 'invalid escape in double-quoted string');
    }
  }

  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) {
      throw new YamlParseError(line, 'unterminated single-quoted string');
    }
    return text.slice(1, -1).replace(/''/g, "'");
  }

  if (text.startsWith('[')) {
    // Flow SEQUENCES are supported, because §55's documented overlay format
    // uses them: `classifications: [financial]`. A parser that refused the
    // format the issue itself shows would be correct-by-construction and
    // useless.
    //
    // Scalars only, one level deep. A nested flow collection is refused rather
    // than half-parsed, which keeps the never-guess property that makes a
    // hand-written reader defensible.
    if (!text.endsWith(']')) throw new YamlParseError(line, 'unterminated flow sequence');

    const inner = text.slice(1, -1).trim();
    if (inner === '') return [];
    if (inner.includes('[') || inner.includes('{')) {
      throw new YamlParseError(line, 'nested flow collections are not supported; use block style');
    }

    return splitFlow(inner, line).map((entry) => parseScalar(entry, line));
  }

  if (text.startsWith('{')) {
    // Flow MAPPINGS stay refused: nothing in the overlay format needs them, so
    // supporting them would widen the parser for no caller.
    throw new YamlParseError(
      line,
      'flow mappings ({a: b}) are not supported; use block style',
    );
  }

  return text;
}

/** Read a `|` or `>` block scalar starting after `header`. */
function readBlockScalar(
  lines: readonly Line[],
  start: number,
  parentIndent: number,
  header: string,
): { value: string; next: number } {
  const fold = header.startsWith('>');
  const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';

  const collected: string[] = [];
  let index = start;
  let blockIndent: number | undefined;

  while (index < lines.length) {
    const line = lines[index] as Line;
    if (line.indent <= parentIndent) break;
    blockIndent ??= line.indent;
    collected.push(line.content.slice(blockIndent));
    index += 1;
  }

  let value = fold ? collected.join(' ') : collected.join('\n');
  if (chomp === 'clip' && value !== '') value += '\n';
  else if (chomp === 'keep') value += '\n';

  return { value, next: index };
}

interface Parsed {
  value: unknown;
  next: number;
}

function parseBlock(lines: readonly Line[], start: number, indent: number): Parsed {
  if (start >= lines.length) return { value: null, next: start };

  const first = lines[start] as Line;
  return first.content.trimStart().startsWith('- ') || first.content.trim() === '-'
    ? parseSequence(lines, start, indent)
    : parseMapping(lines, start, indent);
}

function parseSequence(lines: readonly Line[], start: number, indent: number): Parsed {
  const items: unknown[] = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index] as Line;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlParseError(line.number, 'unexpected indentation');

    const body = line.content.trimStart();
    if (!body.startsWith('-')) break;

    const rest = body.slice(1).trim();
    index += 1;

    if (rest === '') {
      const nested = parseBlock(lines, index, indent + 1);
      items.push(nested.value);
      index = nested.next;
      continue;
    }

    // `- key: value` starts a mapping nested in the item.
    if (/^[^:\s][^:]*:(\s|$)/.test(rest)) {
      const inner: Record<string, unknown> = {};
      const [key, value] = splitKey(rest, line.number);
      inner[key] = value === '' ? null : parseScalar(value, line.number);

      while (index < lines.length && (lines[index] as Line).indent > indent) {
        const nested = parseMapping(lines, index, (lines[index] as Line).indent);
        Object.assign(inner, nested.value as Record<string, unknown>);
        index = nested.next;
      }
      items.push(inner);
      continue;
    }

    items.push(parseScalar(rest, line.number));
  }

  return { value: items, next: index };
}

function splitKey(content: string, line: number): [string, string] {
  const colon = findKeyColon(content);
  if (colon < 0) throw new YamlParseError(line, `expected 'key: value', got '${content}'`);

  const rawKey = content.slice(0, colon).trim();
  const key =
    (rawKey.startsWith('"') && rawKey.endsWith('"')) ||
    (rawKey.startsWith("'") && rawKey.endsWith("'"))
      ? rawKey.slice(1, -1)
      : rawKey;

  if (key === '') throw new YamlParseError(line, 'empty key');
  return [key, content.slice(colon + 1).trim()];
}

/** Index of the `:` that separates key from value, ignoring quoted regions. */
function findKeyColon(content: string): number {
  let quote: string | undefined;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (quote !== undefined) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ':' && (i + 1 >= content.length || /\s/.test(content[i + 1] as string))) {
      return i;
    }
  }

  return -1;
}

function parseMapping(lines: readonly Line[], start: number, indent: number): Parsed {
  const result: Record<string, unknown> = {};
  let index = start;

  while (index < lines.length) {
    const line = lines[index] as Line;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlParseError(line.number, 'unexpected indentation');

    const [key, rawValue] = splitKey(line.content.trimStart(), line.number);
    index += 1;

    if (rawValue.startsWith('|') || rawValue.startsWith('>')) {
      const block = readBlockScalar(lines, index, indent, rawValue);
      result[key] = block.value;
      index = block.next;
      continue;
    }

    if (rawValue !== '') {
      result[key] = parseScalar(rawValue, line.number);
      continue;
    }

    // Empty value: either a nested block, or an explicit null.
    const nextLine = lines[index];
    if (nextLine !== undefined && nextLine.indent > indent) {
      const nested = parseBlock(lines, index, nextLine.indent);
      result[key] = nested.value;
      index = nested.next;
      continue;
    }

    result[key] = null;
  }

  return { value: result, next: index };
}

/**
 * Parse the supported YAML subset.
 *
 * Throws `YamlParseError` for anything outside it, with a line number.
 */
export function parseYamlSubset(text: string): unknown {
  const lines = scan(text);
  if (lines.length === 0) return null;

  const baseIndent = (lines[0] as Line).indent;
  const { value, next } = parseBlock(lines, 0, baseIndent);

  if (next < lines.length) {
    throw new YamlParseError((lines[next] as Line).number, 'unexpected content after document');
  }

  return value;
}
