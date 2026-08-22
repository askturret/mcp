// SPDX-License-Identifier: Apache-2.0
/**
 * Licence policy for #24 / architecture §19.7.
 *
 * Three verdicts:
 *   allowed  — permissive and compatible with Apache-2.0; no action needed.
 *   denied   — copyleft, source-available, or undeclared. Blocks unless an
 *              exception is recorded in LICENSE_EXCEPTIONS.md.
 *   review   — anything this policy does not recognise. Also blocks, because an
 *              unrecognised licence is an unread licence; the fix is either to
 *              add it to the permissive list in a reviewed change, or to record
 *              an exception. Defaulting these to "allowed" would quietly let a
 *              new licence family in, which is the failure this gate exists to
 *              prevent.
 */

/** Permissive and Apache-2.0-compatible. Auto-approved. */
export const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'Zlib',
]);

/**
 * Families that block by policy. Matched by prefix so version variants and
 * `-only` / `-or-later` suffixes are covered without listing every id.
 */
export const DENIED_PREFIXES = ['AGPL', 'GPL', 'LGPL', 'SSPL', 'BUSL', 'Commons-Clause', 'Elastic'];

/** Non-SPDX strings npm packages use to mean "no usable licence". */
const UNDECLARED = new Set(['UNLICENSED', 'UNKNOWN', 'NONE', 'SEE LICENSE IN', 'CUSTOM']);

/**
 * Classify a single SPDX identifier (no operators).
 * @returns {'allowed'|'denied'|'review'}
 */
export function classifyId(id) {
  const trimmed = String(id ?? '').trim().replace(/^\((.*)\)$/, '$1').trim();
  if (!trimmed) return 'denied';

  const upper = trimmed.toUpperCase();
  if (UNDECLARED.has(upper) || upper.startsWith('SEE LICENSE IN')) return 'denied';

  // Prefix match, but anchored at a token boundary so "GPL" does not swallow
  // unrelated ids. LGPL is listed explicitly, so ordering does not matter.
  for (const prefix of DENIED_PREFIXES) {
    if (upper === prefix.toUpperCase() || upper.startsWith(`${prefix.toUpperCase()}-`)) {
      return 'denied';
    }
  }

  if (ALLOWED.has(trimmed)) return 'allowed';

  // SPDX "+" suffix (e.g. Apache-2.0+) means "or later" of the same family.
  if (trimmed.endsWith('+') && ALLOWED.has(trimmed.slice(0, -1))) return 'allowed';

  return 'review';
}

/**
 * Evaluate a full SPDX expression.
 *
 * OR: the consumer may pick a disjunct, so allowed if ANY operand is allowed.
 * AND: all terms bind, so allowed only if EVERY operand is allowed, and the
 * worst verdict wins otherwise.
 *
 * @returns {'allowed'|'denied'|'review'}
 */
export function classifyExpression(expression) {
  if (expression === null || expression === undefined || String(expression).trim() === '') {
    return 'denied';
  }

  const raw = String(expression).trim();

  // "SEE LICENSE IN <file>" and friends are whole-string npm idioms meaning
  // "no SPDX grant here", not expressions. Tokenizing them would split the
  // phrase into unrecognised words and report the milder "review" verdict —
  // still blocking, but for the wrong stated reason.
  const upper = raw.toUpperCase();
  if (upper.startsWith('SEE LICENSE IN') || upper.startsWith('SEE LICENCE IN')) return 'denied';

  const tokens = tokenize(raw);
  if (tokens.length === 0) return 'denied';

  try {
    const { verdict, index } = parseOr(tokens, 0);
    // Trailing junk means we did not understand the expression — do not guess.
    return index === tokens.length ? verdict : 'review';
  } catch {
    return 'review';
  }
}

function tokenize(expr) {
  return expr
    .replace(/\(/g, ' ( ')
    .replace(/\)/g, ' ) ')
    .split(/\s+/)
    .filter(Boolean);
}

const worse = (a, b) => {
  const rank = { allowed: 0, review: 1, denied: 2 };
  return rank[a] >= rank[b] ? a : b;
};

const better = (a, b) => {
  const rank = { allowed: 0, review: 1, denied: 2 };
  return rank[a] <= rank[b] ? a : b;
};

function parseOr(tokens, index) {
  let { verdict, index: next } = parseAnd(tokens, index);
  while (next < tokens.length && tokens[next].toUpperCase() === 'OR') {
    const right = parseAnd(tokens, next + 1);
    verdict = better(verdict, right.verdict);
    next = right.index;
  }
  return { verdict, index: next };
}

function parseAnd(tokens, index) {
  let { verdict, index: next } = parseTerm(tokens, index);
  while (next < tokens.length && tokens[next].toUpperCase() === 'AND') {
    const right = parseTerm(tokens, next + 1);
    verdict = worse(verdict, right.verdict);
    next = right.index;
  }
  return { verdict, index: next };
}

function parseTerm(tokens, index) {
  if (index >= tokens.length) throw new Error('unexpected end of licence expression');

  if (tokens[index] === '(') {
    const inner = parseOr(tokens, index + 1);
    if (tokens[inner.index] !== ')') throw new Error('unbalanced parenthesis');
    return { verdict: inner.verdict, index: inner.index + 1 };
  }

  // A bare id. Consume trailing "WITH <exception>" as part of the same term.
  let id = tokens[index];
  let next = index + 1;
  if (next < tokens.length && tokens[next].toUpperCase() === 'WITH') {
    id = `${id} WITH ${tokens[next + 1] ?? ''}`.trim();
    next += 2;
  }

  // A licence-with-exception is not the bare licence; require explicit review.
  if (id.toUpperCase().includes(' WITH ')) {
    const base = id.split(/\s+WITH\s+/i)[0];
    return { verdict: worse(classifyId(base), 'review'), index: next };
  }

  return { verdict: classifyId(id), index: next };
}
