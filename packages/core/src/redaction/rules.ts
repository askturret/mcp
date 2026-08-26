// SPDX-License-Identifier: Apache-2.0
/**
 * Built-in redaction rules (§9.4).
 *
 * ## These are #38's gap detectors, promoted
 *
 * #38 shipped a key-name matcher plus a set of VALUE-SHAPE classifiers that
 * could only warn. Its own note said the gap list "provides a signal for Epic
 * #3 to design against", and the signal it produced was specific: JWTs,
 * bearer headers, PEM blocks and generated-looking blobs sitting under key
 * names no list would think to include.
 *
 * So the rules below are not a fresh guess at what is sensitive. Each
 * value-shape rule here is a #38 detector that used to raise `redactionGaps`
 * and now redacts instead. The classifiers are imported from that module
 * rather than re-written, so the thing that warned and the thing that acts
 * cannot drift apart.
 */

import { REDACTED, shannonEntropy } from '../logging/redaction.js';
import type { RedactionContext, RedactionRule, RedactionSurface } from './types.js';

// Re-uses #38's constant rather than declaring a second one. Two definitions
// of the mask string is how a surface ends up emitting '[redacted]' while a
// test asserts '[REDACTED]'.
export { REDACTED };

/**
 * Key names whose values are always redacted.
 *
 * #38 deliberately shipped exactly six and refused to grow the list "on a
 * hunch", so that how much of #49 remained undone stayed visible. #49 IS that
 * work, so the list is now the one §9.4 asks for.
 */
export const SENSITIVE_KEY_NAMES: readonly string[] = [
  'password',
  'passwd',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'authorization',
  'auth',
  'secret',
  'clientsecret',
  'credential',
  'credentials',
  'privatekey',
  'ssn',
  'cvv',
  'cvc',
  'pin',
  'cardnumber',
  'sessionid',
  'cookie',
  'setcookie',
];

/**
 * Normalize a key for comparison.
 *
 * `apiKey`, `api_key`, `API-KEY` and `apikey` are the same field; a list that
 * only matched one spelling would miss the spellings people actually use.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-.\s]/g, '');
}

const NORMALIZED_SENSITIVE = new Set(SENSITIVE_KEY_NAMES.map(normalizeKey));

/**
 * Paths that must survive redaction on the `audit` surface.
 *
 * ## Why this exists, and why it is not paranoia
 *
 * An audit event is mostly hex: `inputDigest` is a 64-char SHA-256,
 * `principalRef` is 32, `registryHash` and `eventId` similar. Every one of
 * those matches the long-hex branch of the generated-string heuristic, so
 * without this list the high-entropy rule would redact an audit record's
 * entire identifying content and leave a row of `[REDACTED]` — destroying
 * both #48's digest-stability guarantee and any ability to correlate records.
 *
 * This is the same trap #38 hit with `registryHash` on the log surface, one
 * layer up. The values are non-sensitive BY CONSTRUCTION: they are digests
 * and pseudonyms produced specifically so the raw value never appears.
 *
 * ## The exception that used to exist here (#129, closed by #218)
 *
 * `registryHash` was server-produced on every path but one: when dispatch
 * failed before stage 1 captured a snapshot hash — which every call naming an
 * unknown operation does — the audit record fell back to
 * `command.registryHash`, the value the CALLER supplied. That string was
 * arbitrary and was preserved here verbatim, in a field a reader will
 * reasonably take for a server-observed digest.
 *
 * #218 removed the fallback. The dispatcher now writes
 * `AUDIT_REGISTRY_HASH_UNRESOLVED` instead, so every value in this field is
 * server-authored and "non-sensitive by construction" is true without
 * qualification.
 *
 * Kept as a note rather than deleted, because it names the property this list
 * DEPENDS on: an exemption from redaction is only sound while nothing
 * caller-controlled can reach the exempted field. Anything added to this list
 * later has to clear that same bar, and the cheapest way to remember is to see
 * what happened the one time it was not met.
 *
 * ## The Explorer entries clear that bar differently — by SHAPE, not provenance
 *
 * Everything above is sound because of where the value comes FROM. The
 * `explorer` entries below cannot be, and saying so is the point of this note
 * (#266). A snapshot hash is server-computed at `freeze-and-hash.ts`, but
 * `deserializeSnapshot` accepts a hand-edited `snapshot.json` WITHOUT
 * recomputing the hash — by documented design — and both it and
 * `buildExplorerPanels({ retained })` are public exports. So a caller-supplied
 * string can reach `snapshots[].hash`, and provenance cannot be the basis.
 *
 * Those entries therefore carry a `valuePattern`, and their soundness is local:
 * it holds whoever supplies the snapshot, and no code added elsewhere can
 * invalidate it.
 *
 * **The residual, stated rather than left to be rediscovered: the card shape.**
 * `[0-9]` is a subset of `[0-9a-f]`, so a 16-digit Luhn-valid PAN still matches
 * `/^[0-9a-f]{16}$/`. That is NOT fixable by tightening the regex — the values
 * this exemption exists to preserve are precisely 16-character all-decimal
 * hashes, which is the same string space as a PAN. Every exemption that keeps
 * those hashes intact necessarily admits PAN-shaped values at these paths.
 *
 * What the pattern buys is a bounded blast radius rather than soundness by
 * construction. Of the four rules that consult this exemption, only
 * `creditCardRule` can match a 16-lowercase-hex value at all — `bearerRule`
 * needs whitespace and a prefix, `jwtRule` needs two dots, `highEntropyRule`
 * needs >= 24 characters. So the gated exemption grants exactly one power:
 * creditCardRule stands down on 16-lowercase-hex at three Explorer paths.
 * Ungated it would be "any string whatsoever at these paths", which is the #129
 * shape again.
 *
 * The remaining channel — 64 bits, shape-pinned, reachable only through an
 * attacker-authored snapshot file the operator chose to open — is closed by
 * #347 verifying the hash on deserialisation. That is a different layer, not a
 * precondition for this.
 */
export const AUDIT_STRUCTURAL_FIELDS: readonly string[] = [
  'eventId',
  'timestamp',
  'requestId',
  'traceId',
  'principalRef',
  'operationId',
  'registryHash',
  'policyDecision',
  'inputDigest',
  'outcome',
  'durationMs',
];

/**
 * One exempted position, with its anchoring and value constraint stated.
 *
 * `anchored` is a required field rather than an inferred default because the
 * two surfaces genuinely need opposite behaviour, so whoever adds the next
 * entry is asked the question rather than inheriting whatever was there.
 */
export interface StructuralPathPattern {
  /** Path segments; `'*'` matches exactly one segment, array indices included. */
  readonly segments: readonly string[];
  /** `true` = must match from the path root; `false` = suffix match. */
  readonly anchored: boolean;
  /** When present, the exemption applies only to a string value matching this. */
  readonly valuePattern?: RegExp;
}

/**
 * A snapshot hash: SHA-256 truncated to 16 hex characters by
 * `compiler/passes/freeze-and-hash.ts`.
 *
 * This regex IS the truncation-length guard (#266 criterion 6). If that
 * `substring(0, 16)` ever changes, real hashes stop matching, stop being
 * exempted, and the tests that derive their fixture from the compiler's own
 * hash path go red. The failure direction is safe and loud: hashes become MORE
 * redacted and the panel-6 dropdown visibly fills with `[REDACTED]`.
 *
 * The guard is only real because those tests derive the hash rather than
 * hard-coding a 16-character literal. A hard-coded fixture would keep passing
 * after the length changed, and this comment would be decorative.
 */
const SNAPSHOT_HASH = /^[0-9a-f]{16}$/;

/**
 * Positions exempt from the value-shape rules, per surface.
 *
 * Explorer entries are SUFFIX-matched because redaction runs TWICE over the
 * same value — once inside `buildDiffView` and again over the assembled panels
 * object — so one hash is visited at both `snapshots.<i>.hash` and
 * `diff.snapshots.<i>.hash`. A root-anchored entry would match the outer path
 * only, and pass 1 would already have masked the value before pass 2 saw it:
 * a fix that silently half-works.
 *
 * They pin the CONTAINER rather than the leaf. Matching on a last segment of
 * `hash` would also exempt `traces.spans.<i>.attributes.hash`, which
 * `buildTraceView` spreads straight from caller-influenced span attributes.
 */
const STRUCTURAL_PATHS: Readonly<Record<RedactionSurface, readonly StructuralPathPattern[]>> = {
  audit: AUDIT_STRUCTURAL_FIELDS.map((name) => ({ segments: [name], anchored: true })),
  explorer: [
    { segments: ['snapshots', '*', 'hash'], anchored: false, valuePattern: SNAPSHOT_HASH },
    { segments: ['comparing', 'before', 'hash'], anchored: false, valuePattern: SNAPSHOT_HASH },
    { segments: ['comparing', 'after', 'hash'], anchored: false, valuePattern: SNAPSHOT_HASH },
  ],
  log: [],
  span: [],
  metric: [],
  error: [],
  'diagnostic-bundle': [],
};

/** Does `path` end with (or, when anchored, exactly equal) `segments`? */
function segmentsMatch(path: readonly string[], pattern: StructuralPathPattern): boolean {
  const { segments, anchored } = pattern;
  if (anchored) {
    if (path.length !== segments.length) return false;
  } else if (path.length < segments.length) {
    return false;
  }

  const offset = anchored ? 0 : path.length - segments.length;
  return segments.every((segment, i) => segment === '*' || segment === path[offset + i]);
}

const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const BEARER = /^(bearer|basic)\s+\S{8,}$/i;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const LONG_HEX = /^[0-9a-f]{32,}$/i;
const CARD_SHAPED = /^[0-9](?:[ -]?[0-9]){11,18}$/;

const ENTROPY_MIN_LENGTH = 24;
const ENTROPY_THRESHOLD = 3.5;

function lastSegment(context: RedactionContext): string {
  return context.path[context.path.length - 1] ?? '';
}

/**
 * Is this a position whose value is a digest or id, not a payload?
 *
 * Takes the VALUE as well as the context because an entry may constrain what
 * it will exempt by shape (see `StructuralPathPattern.valuePattern`). All four
 * call sites already have `value` in scope, so this is a signature widening
 * with no plumbing.
 *
 * A `valuePattern` entry never exempts a non-string: the pattern is a
 * constraint, so a value it cannot be tested against fails it rather than
 * bypassing it.
 */
function isStructural(context: RedactionContext, value: unknown): boolean {
  for (const pattern of STRUCTURAL_PATHS[context.surface]) {
    if (!segmentsMatch(context.path, pattern)) continue;
    if (pattern.valuePattern === undefined) return true;
    if (typeof value === 'string' && pattern.valuePattern.test(value)) return true;
  }
  return false;
}

/**
 * Luhn check, so a card rule does not fire on every long digit string.
 *
 * Without it, order numbers, timestamps in microseconds and phone numbers all
 * match the shape. A redaction rule with a high false-positive rate is not
 * merely noisy: it silently destroys the fields an operator needs to debug,
 * and they cannot tell a redacted value from one that was never there.
 */
export function passesLuhn(digits: string): boolean {
  const clean = digits.replace(/[ -]/g, '');
  if (!/^[0-9]+$/.test(clean)) return false;

  let sum = 0;
  let double = false;
  for (let i = clean.length - 1; i >= 0; i -= 1) {
    let digit = clean.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Shape test from #38: generated secrets have no whitespace and mix classes. */
function looksGenerated(value: string): boolean {
  if (/\s/.test(value)) return false;
  if (LONG_HEX.test(value)) return true;

  const classes =
    (/[a-z]/.test(value) ? 1 : 0) +
    (/[A-Z]/.test(value) ? 1 : 0) +
    (/[0-9]/.test(value) ? 1 : 0);

  return classes === 3;
}

const mask = (): unknown => REDACTED;

/** Values are redacted by key name, whatever they contain. */
export const keyNameRule: RedactionRule = {
  id: 'key-name',
  matches: (context) => NORMALIZED_SENSITIVE.has(normalizeKey(lastSegment(context))),
  transform: mask,
};

/** `Authorization: Bearer …` and `Basic …` values (§9.4 header patterns). */
export const bearerRule: RedactionRule = {
  id: 'bearer-prefixed',
  matches: (context, value) =>
    !isStructural(context, value) && typeof value === 'string' && BEARER.test(value),
  transform: mask,
};

export const jwtRule: RedactionRule = {
  id: 'jwt-shaped',
  matches: (context, value) =>
    !isStructural(context, value) && typeof value === 'string' && JWT.test(value),
  transform: mask,
};

export const pemRule: RedactionRule = {
  id: 'pem-block',
  matches: (_context, value) => typeof value === 'string' && PEM.test(value),
  transform: mask,
};

export const creditCardRule: RedactionRule = {
  id: 'credit-card',
  matches: (context, value) =>
    !isStructural(context, value) &&
    typeof value === 'string' &&
    CARD_SHAPED.test(value) &&
    passesLuhn(value),
  transform: mask,
};

/**
 * #38's `high-entropy-string` gap detector — available, but NOT a built-in.
 *
 * ## Why this one is opt-in when the other four are not
 *
 * §9.4 names four kinds of built-in rule: key names, header values,
 * structured-value patterns (card-shaped, JWT-shaped), and surface-specific
 * PII. Entropy is not among them. It came from #38, which used it ONLY to
 * raise a warning, and said so explicitly: "a false positive costs a log
 * line, not data."
 *
 * Promoting it to a redacting rule inverts that trade. A false positive now
 * costs DATA — and it is not hypothetical. Enabling it by default broke a
 * pre-existing span test: `https://api.example.com/pets/99?apiKey=leak` has
 * no whitespace, mixes upper/lower/digits (the `K` in `apiKey` is enough) and
 * clears the entropy floor, so the whole URL was replaced with `[REDACTED]`
 * — destroying the route shape that `maskUrl` exists to preserve, and which
 * the span layer already redacts correctly and precisely.
 *
 * So the heuristic keeps doing what #38 built it for: it still WARNS on the
 * log surface through `redactWithGaps`, and the signal keeps flowing. An
 * adopter who wants it to act can `pipeline.add(highEntropyRule)` and accept
 * the trade knowingly. Flagged for QA — this is the one place #49 declines to
 * promote a #38 detector, and the reason is evidence rather than caution.
 */
export const highEntropyRule: RedactionRule = {
  id: 'high-entropy',
  matches: (context, value) =>
    !isStructural(context, value) &&
    typeof value === 'string' &&
    value.length >= ENTROPY_MIN_LENGTH &&
    looksGenerated(value) &&
    shannonEntropy(value) >= ENTROPY_THRESHOLD,
  transform: mask,
};

/**
 * Built-ins in evaluation order. First match wins.
 *
 * The key-name rule leads because it is the only one that does not depend on
 * the value's shape, so it catches an empty or oddly-encoded secret that every
 * shape test would miss. `highEntropyRule` is deliberately absent — see its
 * own note.
 */
export const BUILTIN_RULES: readonly RedactionRule[] = [
  keyNameRule,
  pemRule,
  bearerRule,
  jwtRule,
  creditCardRule,
];
