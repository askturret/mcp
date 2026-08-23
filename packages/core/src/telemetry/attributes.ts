// SPDX-License-Identifier: Apache-2.0
/**
 * Span attribute sanitisation (§9.1 "attributes NEVER emitted",
 * §17 criterion 8 "telemetry passes cardinality and redaction tests").
 *
 * Spans are a second egress path for the same sensitive data logs handle, and
 * they are easier to get wrong: a tracing backend is usually a third party,
 * and span attributes are not reviewed the way log lines are.
 */

import { redactSpanAttributes } from '../redaction/surfaces.js';
import type { SpanAttributeValue, SpanAttributes } from './types.js';

export const REDACTED = '[REDACTED]';

/**
 * Attribute keys that must never be emitted (§9.1).
 *
 * Raw arguments, raw responses, credentials, and principal identifiers. The
 * §9.1 remedy for the last one is `principal.identityHash`, which is
 * explicitly allowed and is why `principalIdentityHash` is not denied here.
 */
export const DENIED_ATTRIBUTE_KEYS: readonly string[] = [
  'arguments',
  'args',
  'arg',
  'input',
  'rawinput',
  'payload',
  'body',
  'response',
  'output',
  'rawoutput',
  'authorization',
  // `auth` and `bearer` are segments in their own right, not just prefixes of
  // `authorization`. Without them, segment matching still lets `auth_header`
  // and `auth.value` through — `auth` is not `authorization`, so neither the
  // whole-key nor the per-segment comparison fires (#39 QA). §9.1 names
  // "Authorization headers" outright, so the segment is denied outright.
  'auth',
  'bearer',
  'credential',
  'credentials',
  'cookie',
  'cookies',
  'token',
  'apikey',
  'password',
  'secret',
  'principal',
  'principalid',
  'userid',
  'email',
];

function normalize(key: string): string {
  return key.toLowerCase().replace(/[_\-.\s]/g, '');
}

const NORMALIZED_DENIED = new Set(DENIED_ATTRIBUTE_KEYS.map(normalize));

/**
 * The one allowed principal-shaped attribute (§9.1).
 *
 * Checked BEFORE the denylist, because `principal.identityHash` normalizes to
 * something containing "principal" and would otherwise be rejected by the very
 * rule that recommends it.
 */
const ALLOWED_PRINCIPAL_ATTR = normalize('principal.identityHash');

/**
 * Split a key into its parts, on separators AND camelCase boundaries.
 *
 * Same shape as `splitLabelParts` in `cardinality.ts`, and deliberately so —
 * these are two denylists doing the same job on two egress paths, and having
 * them disagree about what "matches" means is how one of them ends up weaker
 * than the other without anyone deciding that it should be.
 */
function splitKeyParts(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\-.\s]+/)
    .filter((part) => part.length > 0);
}

/**
 * Is this attribute key denied?
 *
 * Matched on WHOLE NORMALIZED SEGMENTS, not on the whole key alone. Exact-match
 * on the full key was the original rule and it let compound names straight
 * through: `auth_header`, `bearer_token` and `cookie_jar` all normalize to
 * something that is not literally in the list, so none of them were redacted
 * (#39 QA).
 *
 * Nothing was leaking in practice — the dispatcher only ever sets the stable
 * `SPAN_ATTR` constants, none of which contain a denied segment. But this
 * function is exported and is the enforcement point for any attribute an
 * adopter or a future call site sets, so "no current caller passes a bad key"
 * is a property of today's callers, not of the guard.
 *
 * Whole SEGMENTS rather than substrings, for the reason the label guard gives:
 * a substring rule rejects innocuous keys and gets disabled.
 */
export function isDeniedAttributeKey(key: string): boolean {
  const normalized = normalize(key);

  // Checked first: `principal.identityHash` is the §9.1-RECOMMENDED attribute,
  // and it contains the denied segment `principal`. Segment matching makes this
  // ordering load-bearing rather than merely defensive.
  if (normalized === ALLOWED_PRINCIPAL_ATTR) return false;

  if (NORMALIZED_DENIED.has(normalized)) return true;

  return splitKeyParts(key).some((part) => NORMALIZED_DENIED.has(normalize(part)));
}

/**
 * Mask identifiers and query strings out of a URL (§9.1 "raw URLs containing
 * identifiers").
 *
 * Query parameters go entirely — a query string is where tokens and search
 * terms live — and path segments that look like identifiers become `:id`.
 * Keeping the ROUTE SHAPE is the point: `/pets/:id` is what makes the
 * attribute useful for grouping, and it is also what keeps its cardinality
 * bounded. `/pets/8a3f...` would create one series per pet.
 */
export function maskUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not an absolute URL - mask it as a bare path instead of guessing.
    return maskPath(raw.split('?')[0] ?? raw);
  }

  const path = maskPath(url.pathname);
  const query = url.search.length > 0 ? '?<redacted>' : '';
  return `${url.protocol}//${url.host}${path}${query}`;
}

const NUMERIC = /^\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX = /^[0-9a-f]{12,}$/i;
const MIXED_ID = /^(?=.*\d)[A-Za-z0-9_-]{12,}$/;

function maskPath(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => {
      if (segment.length === 0) return segment;
      if (NUMERIC.test(segment)) return ':id';
      if (UUID.test(segment)) return ':id';
      if (LONG_HEX.test(segment)) return ':id';
      if (MIXED_ID.test(segment)) return ':id';
      return segment;
    })
    .join('/');
}

/**
 * Sanitise an attribute set before it reaches a span.
 *
 * Denied keys are MASKED rather than dropped, for the same reason the logging
 * placeholder masks: `payload: '[REDACTED]'` tells a reader that something was
 * removed, whereas an absent key is indistinguishable from one never set. The
 * issue's own redaction test asserts exactly this shape.
 *
 * Any key whose name suggests a URL is masked in place rather than removed —
 * the route shape is genuinely useful telemetry, the identifiers in it are not.
 */
export function sanitizeAttributes(attributes: SpanAttributes): SpanAttributes {
  const out: Record<string, SpanAttributeValue> = {};

  // Surface 2 of §9.4, applied at the ONE function every attribute write
  // funnels through — `setAttribute` deliberately routes a single key through
  // here too, so a one-key set cannot bypass what a bulk set enforces.
  //
  // The span-specific rules below still run: they mask by KEY (§9.1's denied
  // attribute names) and shorten URLs, which is orthogonal to the central
  // pipeline's value-shape rules. Neither subsumes the other.
  const piped = redactSpanAttributes(attributes);

  for (const [key, value] of Object.entries(piped)) {
    if (isDeniedAttributeKey(key)) {
      out[key] = REDACTED;
      continue;
    }

    if (typeof value === 'string' && looksLikeUrlKey(key)) {
      out[key] = maskUrl(value);
      continue;
    }

    out[key] = value;
  }

  return out;
}

function looksLikeUrlKey(key: string): boolean {
  const normalized = normalize(key);
  return normalized.includes('url') || normalized.endsWith('uri') || normalized === 'httptarget';
}
