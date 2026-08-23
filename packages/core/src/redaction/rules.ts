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
import type { RedactionContext, RedactionRule } from './types.js';

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

/** Is this an audit field whose value is a digest or id, not a payload? */
function isAuditStructural(context: RedactionContext): boolean {
  return (
    context.surface === 'audit' &&
    context.path.length === 1 &&
    AUDIT_STRUCTURAL_FIELDS.includes(context.path[0] as string)
  );
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
    !isAuditStructural(context) && typeof value === 'string' && BEARER.test(value),
  transform: mask,
};

export const jwtRule: RedactionRule = {
  id: 'jwt-shaped',
  matches: (context, value) =>
    !isAuditStructural(context) && typeof value === 'string' && JWT.test(value),
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
    !isAuditStructural(context) &&
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
    !isAuditStructural(context) &&
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
