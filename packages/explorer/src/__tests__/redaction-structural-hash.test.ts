// SPDX-License-Identifier: Apache-2.0
/**
 * The structural-hash exemption on the Explorer surface (#266).
 *
 * A snapshot hash that happens to be 16 all-decimal Luhn-valid digits matched
 * `creditCardRule` and was masked before it reached panel 6, where it renders
 * as a `<select>` option VALUE — so two such snapshots became indistinguishable
 * and `syncWarning`'s comparison could return true for a pair the operator did
 * not select.
 *
 * ## Why these assertions go through `buildExplorerPanels`
 *
 * Redaction runs TWICE over the same value — once inside `buildDiffView` and
 * again over the assembled panels object — so one hash is visited at both
 * `snapshots.<i>.hash` and `diff.snapshots.<i>.hash`. A fix that handles only
 * the outer framing silently half-works: pass 1 masks the value before pass 2
 * ever sees it, and a test that called `buildDiffView` alone would still be
 * green. Asserting on the assembled object is what makes criterion 2 real.
 *
 * ## What the exemption is NOT
 *
 * It is not sound by construction. `[0-9]` is a subset of `[0-9a-f]`, so a
 * 16-digit Luhn-valid PAN still clears the shape gate — and no regex can fix
 * that, because the values criterion 1 requires exempting are precisely
 * 16-character all-decimal hashes, the same string space as a PAN. What the
 * gate buys is a bounded blast radius, and the tests below pin its edges: the
 * neighbouring caller-controlled path stays masked (criterion 3) and a
 * non-hash-shaped value at the exempted path stays masked (criterion 7).
 */

import { describe, it, expect } from '@jest/globals';
import {
  BUILTIN_RULES,
  SNAPSHOT_HASH,
  createRedactionPipeline,
  createSnapshot,
  highEntropyRule,
  redactExplorerModel,
  type RegistrySnapshot,
} from '@askturret/mcp-core';

import { buildExplorerPanels } from '../panels.js';
import { buildExplorerViewModel } from '../view-model.js';

const REDACTED = '[REDACTED]';

/**
 * Two 16-digit, all-decimal, Luhn-valid strings — the collision case.
 *
 * Both are standard test PANs, which is the point: they are simultaneously
 * valid truncated-SHA-256 renderings and valid card numbers, and nothing about
 * the string tells them apart.
 */
const CARD_SHAPED_A = '4242424242424242';
const CARD_SHAPED_B = '4000000000000002';

function snapshotWithHash(version: number, hash: string): RegistrySnapshot {
  return {
    version,
    hash,
    createdAt: new Date(0),
    operations: new Map(),
  } as unknown as RegistrySnapshot;
}

/** Panel 6 as the browser receives it, after BOTH redaction passes. */
function diffPanel(retained: readonly RegistrySnapshot[], report?: unknown) {
  const panels = buildExplorerPanels({
    retained,
    ...(report === undefined ? {} : { diff: report as never }),
  }) as { diff?: { snapshots?: { hash: string }[]; comparing?: { before: { hash: string } } } };
  return panels.diff;
}

// ---------------------------------------------------------------------------
// The truncation length, asserted DIRECTLY (#383 item 4)
//
// This block used to route the question through redaction: take a real compiler
// hash, redact it, assert it survived. That could not fail. Under the DEFAULT
// pipeline nothing redacts a hex string containing letters at ANY length —
// `highEntropyRule` is the only length-sensitive rule and is excluded from
// `BUILTIN_RULES` — so a hash survives whether or not it is exempted, and the
// assertion passes at every truncation length including none at all.
//
// The two jobs are split because ONE assertion cannot do both, and no better
// fixture exists: the truncation job needs a compiler-produced hash, while the
// exemption job needs a value a rule would actually redact — 16 digits, Luhn-
// valid — which the compiler yields roughly 1 in 18,000 times. Searching for
// one would couple the fixture to hash-INPUT stability and redden for reasons
// unrelated to what it tests.
//
// So: this block asserts the regex against a derived hash and nothing else.
// The exemption is asserted separately, with a constructed card-shaped value.
// Each fails for exactly one reason.
// ---------------------------------------------------------------------------

describe('the pattern still describes real compiler output (#383 item 4)', () => {
  // DERIVED from the compiler's own hash path, never a hard-coded literal.
  const realHash = createSnapshot([], 1).hash;

  it('SNAPSHOT_HASH matches a hash the compiler actually produced', () => {
    // Unmediated: if `freeze-and-hash.ts` changes its `substring(0, 16)`, this
    // fails immediately. That is the whole of the truncation guard, and it lives
    // here rather than in the regex's own comment, which used to claim it.
    expect(SNAPSHOT_HASH.test(realHash)).toBe(true);
  });

  it('...and the imported regex CORRESPONDS to the one production redacts with', () => {
    // This assertion used to compare `SNAPSHOT_HASH.source` against the literal
    // '^[0-9a-f]{16}$', and it was the fifth satisfied-by-absence defect found
    // in this suite. Deleting the import entirely and re-declaring the regex
    // locally — the exact Transcribed Oracle the export exists to prevent — left
    // it GREEN. It compared a regex against a hardcoded copy of its own text, so
    // it was provenance-blind by construction, and it was itself the thing it
    // warned about: a transcribed literal that agrees with a stale copy forever.
    //
    // The fix is to tie the imported object to production BEHAVIOUR instead of
    // to its own source text. CARD_SHAPED_A is both matched by SNAPSHOT_HASH and
    // card-shaped, so the two halves below must agree: the imported regex
    // accepts it, AND the pipeline lets it through at an exempted path — which
    // only happens if the regex production consults accepts it too.
    //
    // A drifted copy breaks the correspondence rather than agreeing with itself.
    expect(SNAPSHOT_HASH.test(CARD_SHAPED_A)).toBe(true);

    const atRoot = redactExplorerModel({ snapshots: [{ hash: CARD_SHAPED_A }] }) as {
      snapshots: { hash: string }[];
    };
    expect(atRoot.snapshots[0]?.hash).toBe(CARD_SHAPED_A);
  });

  it('the card-shaped fixtures are the same length as a real hash', () => {
    expect(CARD_SHAPED_A).toHaveLength(realHash.length);
    expect(CARD_SHAPED_B).toHaveLength(realHash.length);
  });

  it('the pattern is an EXACT length, not a minimum — a longer card-shaped value is still redacted', () => {
    // The value must be one a rule would otherwise redact, or this cannot fail.
    //
    // An earlier version of this test used a 17-character hex and asserted it
    // SURVIVED. That passed under a `{16,}` widening too, because no rule fires
    // on a 17-char hex in the first place — not card-shaped, no dots, and far
    // short of highEntropyRule's 24-character floor. It was satisfied by the
    // absence of any applicable rule rather than by the exemption's width.
    //
    // A 19-digit Luhn-valid PAN is longer than a hash, is all-decimal (so a
    // `{16,}` pattern WOULD exempt it), and creditCardRule matches 12-19
    // digits. So it discriminates.
    const LONGER_CARD = '4000000000000000006';
    expect(LONGER_CARD.length).toBeGreaterThan(realHash.length);

    const panel = diffPanel([
      snapshotWithHash(1, LONGER_CARD),
      snapshotWithHash(2, CARD_SHAPED_B),
    ]);
    expect(panel?.snapshots?.[0]?.hash).toBe(REDACTED);
  });
});

// ---------------------------------------------------------------------------
// Criteria 1, 2 and 4 — the defect itself
// ---------------------------------------------------------------------------

describe('a Luhn-valid snapshot hash survives both redaction passes (#266 criteria 1, 2)', () => {
  it('renders intact at snapshots[].hash', () => {
    const panel = diffPanel([
      snapshotWithHash(2, CARD_SHAPED_A),
      snapshotWithHash(1, CARD_SHAPED_B),
    ]);

    expect(panel?.snapshots?.[0]?.hash).toBe(CARD_SHAPED_A);
    expect(panel?.snapshots?.[1]?.hash).toBe(CARD_SHAPED_B);
  });

  it('renders intact at comparing.before.hash, which is a different path', () => {
    const panel = diffPanel(
      [snapshotWithHash(2, CARD_SHAPED_A), snapshotWithHash(1, CARD_SHAPED_B)],
      {
        before: { version: 1, hash: CARD_SHAPED_B },
        after: { version: 2, hash: CARD_SHAPED_A },
        changes: [],
        summary: { added: 0, removed: 0, changed: 0 },
      },
    );

    expect(panel?.comparing?.before.hash).toBe(CARD_SHAPED_B);
  });

  it('two colliding hashes remain DISTINGUISHABLE, which is what panel 6 needs (#266 criterion 4)', () => {
    const panel = diffPanel([
      snapshotWithHash(2, CARD_SHAPED_A),
      snapshotWithHash(1, CARD_SHAPED_B),
    ]);

    const [first, second] = panel?.snapshots ?? [];
    // The defect was not "a hash is masked" but "two DIFFERENT hashes become
    // equal", which is what let syncWarning compare a mismatched pair as equal.
    expect(first?.hash).not.toBe(second?.hash);
    expect(first?.hash).not.toBe(REDACTED);
    expect(second?.hash).not.toBe(REDACTED);
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 — the soundness guard, which matters MORE than criterion 1
// ---------------------------------------------------------------------------

describe('the exemption pins the container, not the leaf (#266 criterion 3)', () => {
  it('a caller-controlled attributes.hash on the traces panel is STILL redacted', () => {
    // `buildTraceView` spreads caller-influenced span attributes straight into
    // the model. A last-segment match on `hash` would exempt this, which is the
    // #129 shape: a caller-controlled value reaching an exempted field.
    const panels = buildExplorerPanels({
      spans: [
        {
          name: 'op',
          startedAt: 0,
          durationMs: 1,
          attributes: { hash: CARD_SHAPED_A },
        } as never,
      ],
    }) as { traces?: { spans?: { attributes?: Record<string, unknown> }[] } };

    expect(panels.traces?.spans?.[0]?.attributes?.hash).toBe(REDACTED);
  });

  it('a card-shaped value at a NESTED snapshots container is still redacted (#383 item 1)', () => {
    // THE ANCHORING ASSERTION. `anchored: true` is a data flag, and a flag no
    // test observes is one the next author flips while the suite stays green.
    //
    // This path — snapshots[].hash nested inside caller-influenced span
    // attributes — is exempt under SUFFIX matching and NOT exempt under
    // anchored. So flipping the explorer entries back to `anchored: false`
    // turns this red, which is the only thing keeping the ruling in force.
    const nested = redactExplorerModel({
      traces: { spans: [{ attributes: { snapshots: [{ hash: CARD_SHAPED_A }] } }] },
    }) as { traces: { spans: { attributes: { snapshots: { hash: string }[] } }[] } };

    expect(nested.traces.spans[0]?.attributes.snapshots[0]?.hash).toBe(REDACTED);
  });

  // The paired positive, over EVERY generated position (#383 rework).
  //
  // It used to cover `snapshots[].hash` at both roots and nothing else. That
  // left the same defect this PR exists to fix, one field over: M3 pins the
  // ROOTS, so dropping a root reddens five tests — but NOTHING pinned the
  // POSITIONS. Dropping ['comparing','after','hash'], making the cross-product
  // 2x2 instead of 2x3, left core 863/863 and explorer 87/87 fully green.
  //
  // Measured consequence of that survivable mutation: comparing.after.hash
  // reads [REDACTED] at both roots, so real "after" hashes start being masked
  // and nothing says so. `anchored: true` was a data flag nothing observed;
  // `EXPLORER_HASH_POSITIONS` had become an input list nothing observed.
  //
  // Each case below is one generated entry, so a dropped position reddens the
  // row named for it rather than reducing an aggregate count.
  describe('...while the same value at every REAL exempted position survives', () => {
    const positions: readonly (readonly [string, () => unknown, (m: never) => unknown])[] = [
      [
        'snapshots[].hash',
        () => ({ snapshots: [{ hash: CARD_SHAPED_A }] }),
        (m: never) => (m as { snapshots: { hash: string }[] }).snapshots[0]?.hash,
      ],
      [
        'comparing.before.hash',
        () => ({ comparing: { before: { hash: CARD_SHAPED_A } } }),
        (m: never) => (m as { comparing: { before: { hash: string } } }).comparing.before.hash,
      ],
      [
        'comparing.after.hash',
        () => ({ comparing: { after: { hash: CARD_SHAPED_A } } }),
        (m: never) => (m as { comparing: { after: { hash: string } } }).comparing.after.hash,
      ],
    ];

    it.each(positions)('%s survives at the model root', (_label, build, read) => {
      const out = redactExplorerModel(build()) as never;
      expect(read(out)).toBe(CARD_SHAPED_A);
    });

    it.each(positions)('%s survives under the diff root', (_label, build, read) => {
      const out = redactExplorerModel({ diff: build() }) as { diff: never };
      expect(read(out.diff)).toBe(CARD_SHAPED_A);
    });
  });

  it('a hash-shaped value at an UNRELATED explorer path is still redacted', () => {
    // Guards against the suffix match being widened into "anywhere on the
    // explorer surface". Asserted through the pipeline rather than the panels,
    // because no panel puts a bare `hash` at the root today — and a test that
    // could only be written via a panel would stop covering this the moment
    // one did.
    const redacted = redactExplorerModel({ hash: CARD_SHAPED_A }) as { hash: string };
    expect(redacted.hash).toBe(REDACTED);
  });
});

// ---------------------------------------------------------------------------
// The seventh position — the page header (#395)
//
// `buildExplorerViewModel` assigns the SAME `snapshot.hash` to
// `header.registryHash` and redacts at the view-model root. Neither #266 nor
// #383 enumerated that position, so #266's original complaint stayed true
// there: a card-shaped hash read [REDACTED] in the header while all six diff
// positions survived.
//
// Provenance is confirmed HERE, at the assignment site, rather than inherited
// from the other six. Inheritance-by-assertion is the mistake this suite has
// already disproved once — asserting a property of one path and assuming it of
// a neighbour is how the position went missing in the first place.
// ---------------------------------------------------------------------------

describe('the header registry hash is the compiler\'s own, and survives (#395)', () => {
  it('buildExplorerViewModel assigns snapshot.hash to header.registryHash', () => {
    // THE PROVENANCE ASSERTION, and it is deliberately NOT routed through the
    // exemption. A real compiler hash contains letters, so no default rule
    // fires on it and it survives whether or not the position is exempt —
    // asserting its survival would be satisfied by absence.
    //
    // What this DOES observe is the assignment: the value at header.registryHash
    // is the snapshot's own hash. That is what makes exempting the position
    // legitimate — the value is compiler-derived, never caller-influenced — and
    // it goes red if the assignment is ever repointed at something else.
    const snapshot = createSnapshot([], 1);
    const model = buildExplorerViewModel(snapshot, '/mcp');

    expect(model.header.registryHash).toBe(snapshot.hash);
    expect(SNAPSHOT_HASH.test(model.header.registryHash)).toBe(true);
  });

  it('a card-shaped hash survives at header.registryHash', () => {
    // The case that could actually fail, and the one #395 reported. Before the
    // seventh entry existed this read [REDACTED].
    const model = buildExplorerViewModel(
      snapshotWithHash(1, CARD_SHAPED_A),
      '/mcp',
    );

    expect(model.header.registryHash).toBe(CARD_SHAPED_A);
  });

  it('...but the exemption is the two-segment PATH, not the leaf name', () => {
    // The paired negative. Without it, an entry matching `registryHash`
    // anywhere would satisfy the assertion above — the suffix-matching bug
    // this PR removed, reintroduced at a new position.
    const bare = redactExplorerModel({ registryHash: CARD_SHAPED_A }) as { registryHash: string };
    const nested = redactExplorerModel({
      traces: { spans: [{ attributes: { header: { registryHash: CARD_SHAPED_A } } }] },
    }) as { traces: { spans: { attributes: { header: { registryHash: string } } }[] } };

    expect(bare.registryHash).toBe(REDACTED);
    expect(nested.traces.spans[0]?.attributes.header.registryHash).toBe(REDACTED);
  });

  it('...and a NEIGHBOURING field in the same header object is still redacted', () => {
    // The exemption is one field, not the `header` container. Asserted with
    // both fields in ONE object so the pair is decisive: the same value, the
    // same parent, redacted at one key and exempt at the other. That can only
    // be the entry's segments doing the work.
    const out = redactExplorerModel({
      header: { registryHash: CARD_SHAPED_A, previousHash: CARD_SHAPED_A },
    }) as { header: { registryHash: string; previousHash: string } };

    expect(out.header.registryHash).toBe(CARD_SHAPED_A);
    expect(out.header.previousHash).toBe(REDACTED);
  });
});

// ---------------------------------------------------------------------------
// Criterion 7 — what pins option 2's actual guarantee
// ---------------------------------------------------------------------------

describe('a non-hash-shaped value at the exempted path is still redacted (#266 criterion 7)', () => {
  // Each of these reaches snapshots[].hash — the EXEMPTED path — and must be
  // masked anyway, because the exemption is gated on value shape. This is the
  // test that fails if someone later "simplifies" the valuePattern away, and
  // without it the gate is unverified.
  const cases: readonly (readonly [string, string])[] = [
    ['a JWT', 'eyJhbGciOi.eyJzdWIiOiI.SflKxwRJSMeK'],
    ['a bearer token', 'Bearer abcdefghijklmnop'],
  ];

  it.each(cases)('%s at snapshots[].hash is redacted', (_label, value) => {
    const panel = diffPanel([snapshotWithHash(2, value), snapshotWithHash(1, CARD_SHAPED_B)]);
    expect(panel?.snapshots?.[0]?.hash).toBe(REDACTED);
  });

  it('a 40-character hex digest is redacted at the exempted path, with highEntropyRule enabled', () => {
    // `highEntropyRule` is deliberately NOT a built-in, so a 40-char hex is not
    // redacted by the default pipeline at all — asserting it through
    // `buildExplorerPanels` would pass whether or not the exemption applied.
    // Enabling the rule is what makes this case able to fail.
    // A REAL 40-char digest, not a repeated character: `highEntropyRule` also
    // gates on Shannon entropy >= 3.5, and 'a'.repeat(40) has an entropy of
    // zero — it would fail the rule for a reason that has nothing to do with
    // the exemption, and the test would then prove nothing.
    const pipeline = createRedactionPipeline({ rules: [...BUILTIN_RULES, highEntropyRule] });
    const model = { snapshots: [{ hash: 'da39a3ee5e6b4b0d3255bfef95601890afd80709' }] };

    const out = redactExplorerModel(model, pipeline) as { snapshots: { hash: string }[] };
    expect(out.snapshots[0]?.hash).toBe(REDACTED);
  });

  // NOT asserted, and the reason is the point: a 16-character UPPERCASE hex is
  // outside `valuePattern` (which is lowercase-only), but NO rule can fire on
  // it — it is not card-shaped, has no dots, no bearer prefix, and is far short
  // of highEntropyRule's 24-character floor. So an "it is still redacted"
  // assertion would pass identically whether or not the exemption covered it,
  // and an "it survives" assertion would pass even if the pattern were widened
  // to accept uppercase.
  //
  // Either direction is satisfied by the absence of any applicable rule rather
  // than by the behaviour under test. The lowercase-only property is real but
  // unobservable at this length, so it is recorded here instead of pinned by a
  // test that could not fail.

  it('...while the hash-shaped sibling in the same object survives', () => {
    // The pair matters: it shows the redaction above is the VALUE being
    // rejected, not the path having lost its exemption.
    const panel = diffPanel([
      snapshotWithHash(2, 'Bearer abcdefghijklmnop'),
      snapshotWithHash(1, CARD_SHAPED_B),
    ]);

    expect(panel?.snapshots?.[0]?.hash).toBe(REDACTED);
    expect(panel?.snapshots?.[1]?.hash).toBe(CARD_SHAPED_B);
  });
});
