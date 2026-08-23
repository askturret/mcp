// SPDX-License-Identifier: Apache-2.0
/**
 * v0.2 placeholder redaction (§9.4).
 *
 * This is a SEAM, not a redaction implementation. It strips a fixed list of
 * known credential-ish key names and nothing else. The central pipeline that
 * actually reasons about sensitive data ships in Epic #3 (#49), and the
 * Production preset continues to list `redaction` as a pending control until
 * it does.
 *
 * Saying so plainly matters more than it looks: a placeholder that is mistaken
 * for a real control is worse than no control, because it stops people looking.
 */

import type { LogFields, JsonSerializable, RedactionFn } from './types.js';

/**
 * The replacement value. Chosen over DELETING the key deliberately.
 *
 * #38 contains a genuine contradiction here (flagged for QA): the "Output
 * format" section says credentials must NEVER be included, while the redaction
 * test requires the emitted line to contain `{ password: '[REDACTED]' }` - the
 * key present, the value masked.
 *
 * Masking is implemented, because the test states the observable outcome
 * exactly and because masking is strictly more debuggable: "a password field
 * was present and we removed it" is actionable, whereas a silently dropped key
 * is indistinguishable from one that was never sent.
 */
export const REDACTED = '[REDACTED]';

/**
 * Key names redacted at RUNTIME (§ Redaction hook, v0.2 stub).
 *
 * Exactly the six the issue names. Deliberately NOT extended on a hunch: this
 * list is a documented placeholder, and quietly growing it would blur how much
 * of #49's job is actually done.
 *
 * Compared case-insensitively, since `Authorization` and `authorization` are
 * the same header and a case-sensitive list would miss the commonest spelling.
 */
export const DEFAULT_REDACTED_KEYS: readonly string[] = [
  'password',
  'token',
  'apiKey',
  'authorization',
  'secret',
  'ssn',
];

/**
 * A value the placeholder did NOT redact but which looks sensitive.
 *
 * The signal Epic #3 is meant to design against: every entry is a case where
 * key-name matching was not enough.
 */
export interface RedactionGap {
  /** Dotted path to the value, e.g. `headers.proxyAuth`. */
  readonly path: string;

  /** Which heuristic fired. */
  readonly reason:
    | 'jwt-shaped'
    | 'bearer-prefixed'
    | 'pem-block'
    | 'high-entropy-string';
}

export interface RedactionResult {
  readonly fields: LogFields;
  readonly gaps: readonly RedactionGap[];
}

const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const BEARER = /^(bearer|basic)\s+\S{8,}$/i;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const LONG_HEX = /^[0-9a-f]{32,}$/i;

/** Minimum length before entropy is even considered. */
const ENTROPY_MIN_LENGTH = 24;

/** Shannon bits/char above which a string reads as a key rather than prose. */
const ENTROPY_THRESHOLD = 3.5;

/**
 * Canonical field names whose values are non-sensitive by construction
 * (§ Output format), exempt from gap heuristics.
 *
 * Without this, `registryHash` is a live hazard: it is a hex digest emitted on
 * EVERY log line, so the moment it grows past the hex threshold - today it is
 * 16 chars, one length bump from 32 - every record would carry a gap warning.
 * A warning that fires on every line is not a signal, it is a reason to switch
 * warnings off, which would cost #49 the data this heuristic exists to collect.
 */
const NON_SENSITIVE_KEYS: readonly string[] = [
  'traceId',
  'requestId',
  'operationId',
  'registryHash',
  'outcome',
  'stage',
  'stageName',
  'level',
  'time',
  'msg',
];

function isRedactedKey(key: string): boolean {
  const lower = key.toLowerCase();
  return DEFAULT_REDACTED_KEYS.some((k) => k.toLowerCase() === lower);
}

/**
 * Shannon entropy in bits per character.
 *
 * English prose sits near 2.5-3.2; base64 and hex secrets sit well above.
 * The threshold is a heuristic and is only ever used to RAISE A WARNING -
 * never to decide whether something is emitted - so a false positive costs a
 * log line, not data.
 */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }

  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Does the string mix character classes the way a generated secret does?
 *
 * Entropy alone is a POOR discriminator at these lengths, and getting this
 * wrong once already produced a false positive on the sentence "the operation
 * completed successfully after a retry". The reason is structural: Shannon
 * entropy per character is capped at `log2(length)`, so a 24-char secret and a
 * 49-char English sentence land in the same band. Prose is not low-entropy —
 * it is just as varied per character as a short key.
 *
 * What actually separates them is SHAPE: generated secrets carry no
 * whitespace and mix upper, lower and digits (or are long hex). Prose has
 * spaces; camelCase identifiers have no digits; lowercase URLs have neither
 * upper nor digits. Entropy is kept only as a secondary floor.
 */
function looksGenerated(value: string): boolean {
  if (/\s/.test(value)) return false;
  if (LONG_HEX.test(value)) return true;

  const classes =
    (/[a-z]/.test(value) ? 1 : 0) +
    (/[A-Z]/.test(value) ? 1 : 0) +
    (/[0-9]/.test(value) ? 1 : 0);

  return classes === 3;
}

function classify(value: string): RedactionGap['reason'] | null {
  if (PEM.test(value)) return 'pem-block';
  if (BEARER.test(value)) return 'bearer-prefixed';
  if (JWT.test(value)) return 'jwt-shaped';
  if (
    value.length >= ENTROPY_MIN_LENGTH &&
    looksGenerated(value) &&
    shannonEntropy(value) >= ENTROPY_THRESHOLD
  ) {
    return 'high-entropy-string';
  }
  return null;
}

/**
 * Walk fields, masking known keys and collecting everything suspicious that
 * the key list did NOT catch.
 *
 * ## On "emit warnings when the placeholder would need to strip more"
 *
 * The issue asks for this but does not say how a key-name matcher could know
 * what it is missing - by construction it cannot. Flagged for QA; the reading
 * implemented is VALUE-SHAPE detection: strings that look like credentials
 * (JWTs, bearer/basic headers, PEM blocks, high-entropy blobs) sitting under
 * keys the list does not cover.
 *
 * That produces a concrete, reviewable signal - "this key held a JWT and we
 * did not redact it" - which is what #49 needs in order to design a real
 * pipeline. The alternative readings (warn on every unknown key; warn never)
 * are respectively useless and vacuous.
 */
export function redactWithGaps(fields: LogFields): RedactionResult {
  const gaps: RedactionGap[] = [];

  const walk = (value: JsonSerializable, path: string, keyName: string): JsonSerializable => {
    if (isRedactedKey(keyName)) {
      return REDACTED;
    }

    if (typeof value === 'string') {
      if (!NON_SENSITIVE_KEYS.includes(keyName)) {
        const reason = classify(value);
        if (reason !== null) {
          gaps.push({ path, reason });
        }
      }
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item, index) => walk(item, `${path}[${index}]`, keyName));
    }

    if (value !== null && typeof value === 'object') {
      const out: Record<string, JsonSerializable> = {};
      for (const [key, nested] of Object.entries(value as Record<string, JsonSerializable>)) {
        out[key] = walk(nested, path === '' ? key : `${path}.${key}`, key);
      }
      return out;
    }

    return value;
  };

  const out: Record<string, JsonSerializable> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = walk(value, key, key);
  }

  return { fields: out, gaps };
}

/**
 * The default `RedactionFn` - masking only, gaps discarded.
 *
 * `createLogger` uses `redactWithGaps` directly so it can emit the gap warning;
 * this export exists for callers composing their own pipeline.
 */
export const defaultRedaction: RedactionFn = (fields) => redactWithGaps(fields).fields;
