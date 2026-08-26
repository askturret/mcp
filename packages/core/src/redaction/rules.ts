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
 * `deserializeSnapshot` verifies it only when the caller lets it: since #347 a
 * mismatch throws, and `{ verifyHash: false }` still reads a hand-edited
 * `snapshot.json` unverified. Both that function and
 * `buildExplorerPanels({ retained })` are public exports, so a caller-supplied
 * string can still reach `snapshots[].hash`, and provenance cannot be the basis.
 *
 * **#347 raised the floor here; it did not remove the need for these entries.**
 * The premise moved from "unverified by documented design" to "verified unless
 * someone passed `{ verifyHash: false }`" — better, because that residual is
 * greppable rather than an open set of construction paths, and still not an
 * invariant a redaction exemption may rest on.
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
 * ## What this does NOT do, corrected (#383 item 4)
 *
 * This comment used to claim the regex "IS the truncation-length guard", on the
 * reasoning that a changed `substring(0, 16)` would stop hashes matching, stop
 * them being exempted, and turn the derived-fixture tests red.
 *
 * **They would not go red.** Under the DEFAULT pipeline nothing redacts a hex
 * string containing letters, at any length: `keyNameRule` does not list `hash`,
 * `bearerRule` needs a prefix, `jwtRule` needs two dots, `pemRule` needs a PEM
 * header, and `creditCardRule` needs 16 DIGITS plus a Luhn check.
 * `highEntropyRule` is the only length-sensitive rule and is deliberately
 * excluded from `BUILTIN_RULES`.
 *
 * So losing the exemption changes nothing observable: the hash survives either
 * way, no rule fires, and an assertion routed through redaction still passes.
 * The mechanism the old comment named was absent at every length, which makes
 * it a claim about a guard rather than a guard.
 *
 * ## What actually guards the length
 *
 * A DIRECT assertion — `SNAPSHOT_HASH.test(createSnapshot(...).hash)` — which
 * is why this regex is exported. It fails immediately if the truncation
 * changes, because nothing mediates it. Routing that question through redaction
 * is what made it vacuous.
 *
 * The regex still does real work here: it BOUNDS the exemption to 16-lowercase
 * hex, so `creditCardRule` stands down on exactly that shape and nothing wider.
 * That is its job; the length guard is the test's.
 */
export const SNAPSHOT_HASH = /^[0-9a-f]{16}$/;

/** The three positions a snapshot hash occupies within a diff view. */
const EXPLORER_HASH_POSITIONS = [
  ['snapshots', '*', 'hash'],
  ['comparing', 'before', 'hash'],
  ['comparing', 'after', 'hash'],
] as const;

/**
 * The roots redaction visits Explorer data at.
 *
 * THREE in-tree sites produce TWO distinct roots: `buildDiffView` redacts at the
 * diff view's own root, while `buildExplorerPanels` and `embedJson` both redact
 * the assembled panels object, where the same value sits under `diff`. Every
 * pass that can see a still-unmasked hash must exempt it — the first pass to
 * miss masks the value, and later passes then have nothing left to exempt — so
 * both roots are listed rather than only the outermost.
 */
const EXPLORER_ROOTS = [[], ['diff']] as const;

/**
 * Positions exempt from the value-shape rules, per surface.
 *
 * ## Anchored, and the reason is failure DIRECTION (#383)
 *
 * These entries were suffix-matched, on the reasoning that a root-anchored entry
 * would match the outer path only and silently half-work. That reasoning had the
 * failure direction backwards, and the correction is worth stating because the
 * argument against it was already in this file, twenty lines up.
 *
 * `redactExplorerModel` is PUBLIC API and generic over the root, so the set of
 * roots is genuinely open — enumerating today's call sites cannot close it. At a
 * root nobody enumerated:
 *
 *   - SUFFIX matching exempts, so a hash-shaped value at an unforeseen container
 *     is NOT redacted. Under-redaction, and invisible by construction: nothing
 *     displays a value that should have been masked.
 *   - ANCHORED matching does not exempt, so a hash IS redacted. Over-redaction,
 *     which is at least *visible in principle*: the panel-6 dropdown fills with
 *     `[REDACTED]` where a value used to be.
 *
 * For a redaction control the correct default is fail-closed, and fail-closed
 * here means REDACT. So the exemption applies at exactly seven positions and
 * NOWHERE else, including a `snapshots` container nested inside caller-
 * influenced span attributes.
 *
 * ## How loud, honestly (#383 rework)
 *
 * Not as loud as the paragraph above once claimed. It said the derived-hash
 * tests go red; they do not, and the section twenty lines up says why —
 * NOTHING in the default pipeline redacts a hex string containing letters at
 * any length, so losing an exemption changes nothing observable for an ordinary
 * hash. Both statements cannot be true, and this is the one that was wrong.
 *
 * Over-redaction here manifests ONLY for a hash that is 16 all-decimal
 * Luhn-valid digits — roughly 1 in 18,000 — because that is the only shape a
 * default rule fires on. So the loud failure is real but RARE, and on any given
 * day the likelier symptom of a wrong entry here is nothing at all.
 *
 * That corrects the stated cost, not the conclusion. Fail-closed remains right:
 * the comparison is against SUFFIX matching, whose failure is under-redaction
 * that is invisible *by construction* rather than merely infrequent. A rare
 * visible failure still beats a silent one.
 *
 * ## The consequence for out-of-tree callers, stated rather than discovered
 *
 * An adopter who calls `redactExplorerModel` on a model rooted somewhere this
 * list does not name gets NO exemption, and their snapshot hashes are redacted.
 * That is a deliberate, documented cost of anchoring rather than an oversight.
 * It is the safe direction: they see masked hashes and can say so, where the
 * alternative is an unmasked value nobody ever sees.
 *
 * Generated as a cross-product rather than written out, so the next author reads
 * "two roots x three positions" instead of six near-duplicate lines inviting a
 * tidy-up back into the bug — and so adding a fourth pass at a new root is one
 * line rather than three.
 */
const STRUCTURAL_PATHS: Readonly<Record<RedactionSurface, readonly StructuralPathPattern[]>> = {
  audit: AUDIT_STRUCTURAL_FIELDS.map((name) => ({ segments: [name], anchored: true })),
  explorer: [
    ...EXPLORER_ROOTS.flatMap((root) =>
      EXPLORER_HASH_POSITIONS.map((position) => ({
        segments: [...root, ...position],
        anchored: true,
        valuePattern: SNAPSHOT_HASH,
      })),
    ),
    // The seventh, and NOT part of the cross-product above (#395).
    //
    // `buildExplorerViewModel` assigns the SAME `snapshot.hash` to
    // `header.registryHash` and then redacts at the view-model root, so #266's
    // original complaint was still true at a position neither #266 nor #383
    // enumerated: a card-shaped hash read `[REDACTED]` in the page header while
    // all six positions above survived.
    //
    // Provenance is the same as theirs and was confirmed at the assignment site
    // rather than inherited: the value is the compiler's own snapshot hash, not
    // caller-influenced data. `valuePattern` still bounds it to the hash shape.
    //
    // Listed separately because it is NOT a diff-view position. Adding it to
    // `EXPLORER_HASH_POSITIONS` would also generate `diff.header.registryHash`,
    // which no pass produces — and exempting a path nothing writes is precisely
    // the unjustified widening this entire entry set exists to avoid.
    { segments: ['header', 'registryHash'], anchored: true, valuePattern: SNAPSHOT_HASH },
  ],
  //
  // ## This list is a CLOSED ENUMERATION over an OPEN set of assignment sites
  //
  // Stated here because it is the standing risk, not a solved problem. Every
  // entry above was found by someone reading the code and naming a position —
  // and enumeration is precisely the method that cannot tell you what it
  // missed. #266 enumerated three positions and shipped as fixed; #383 reviewed
  // the anchoring and the completeness of the list and also stopped at three;
  // #395 then found a fourth that had been there the whole time, assigned in
  // `view-model.ts` from the same `snapshot.hash`.
  //
  // Two rounds of design and review both stopped at the positions someone
  // happened to name. A FIFTH assignment site added tomorrow reopens this
  // silently, and in the safe direction — the hash is over-redacted, not
  // leaked — but silently.
  //
  // So: if you add a new place a snapshot hash is written into an Explorer
  // model, it needs an entry here AND an assertion naming it. The tests pin
  // every entry individually for exactly this reason; a position with no
  // assertion is a position nothing observes, which is how the list drifted
  // from the code twice already.
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
