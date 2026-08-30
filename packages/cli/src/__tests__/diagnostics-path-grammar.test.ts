// SPDX-License-Identifier: Apache-2.0
/**
 * Path sanitiser, over a GENERATED GRAMMAR rather than hand-picked shapes (#301).
 *
 * ## Why this file exists
 *
 * Four rounds in this area each fixed exactly the reported shape and left a
 * sibling with the identical signature — "directory leaked and/or filename
 * corrupted":
 *
 *   #50 (round 3)  quoted paths, spaces
 *   #163           Windows UNC, tab-separated directory names
 *   #286           mixed-separator UNC
 *   #293           consecutive/doubled separators
 *
 * Every one of those fixes was correct. The METHOD was the defect: picking
 * test cases from whatever shape happened to be reported cannot find the shape
 * nobody reported. This enumerates the space instead and asserts ONE
 * invariant — **no directory token survives** — so a new gap surfaces as a
 * named failing case rather than as the next issue.
 *
 * It earned its keep immediately: the trailing-separator leak had been
 * reported for POSIX only, and this showed it across drive, UNC, device and
 * extended-length paths as well. It also found `\dir\file` (Windows
 * root-relative), which no round had touched.
 *
 * ## Exhaustive, not random
 *
 * The grammar is finite, so every combination is enumerated rather than
 * sampled. That is deliberately NOT a property-testing library:
 *
 *   - a failure is reproducible from its name alone, with no seed to record;
 *   - there is no shrinking step to trust, because the inputs are already minimal;
 *   - it adds no dependency, which on this repository means no licence review
 *     and no SBOM entry for a test-only tool.
 *
 * Randomised generation would be the right answer for an infinite space. This
 * space has 105 points.
 */

import { describe, it, expect } from '@jest/globals';

import { sanitizeErrorText, pathBasenames } from '../commands/diagnostics-bundle.js';

/**
 * Distinctive tokens, so "did a directory survive?" is a substring test rather
 * than a judgement call. `SECRET` prefixes make an accidental collision with
 * ordinary output impossible.
 */
const DIR_A = 'SECRETDIRA';
const DIR_B = 'SECRETDIRB';
const HOST = 'SECRETHOST';
const SHARE = 'SECRETSHARE';
const FILE = 'spec.yaml';

/**
 * Each shape is a root prefix plus the directory tokens that follow it.
 *
 * The root is FIXED per shape and never varies with the separator axis:
 * flipping the root of a POSIX path turns it into a different shape
 * (`\dir\file` is Windows root-relative, not POSIX-with-backslashes), and
 * conflating the two would report a finding against the wrong shape.
 */
const SHAPES = {
  posix: { prefix: '/', primary: '/', segments: [DIR_A, DIR_B] },
  relative: { prefix: '', primary: '/', segments: [DIR_A, DIR_B] },
  winRootRelative: { prefix: '\\', primary: '\\', segments: [DIR_A, DIR_B] },
  drive: { prefix: 'C:\\', primary: '\\', segments: [DIR_A, DIR_B] },
  unc: { prefix: '\\\\', primary: '\\', segments: [HOST, SHARE, DIR_A] },
  device: { prefix: '\\\\.\\', primary: '\\', segments: ['C:', DIR_A] },
  extendedLength: { prefix: '\\\\?\\', primary: '\\', segments: ['C:', DIR_A] },
} as const;

type ShapeName = keyof typeof SHAPES;

/** `trailing` ends the path at a separator, so there is no filename at all. */
const SEPARATORS = ['primary', 'alt', 'mixed', 'doubled', 'trailing'] as const;
type SeparatorStyle = (typeof SEPARATORS)[number];

const BLANKS = ['none', 'spaces', 'tabs'] as const;
type BlankStyle = (typeof BLANKS)[number];

/** Insert a blank INSIDE a token, so the token spans a separator-free gap. */
function withBlank(token: string, blanks: BlankStyle): string {
  if (blanks === 'none' || !token.startsWith('SECRET')) return token;
  const gap = blanks === 'spaces' ? ' ' : '\t';
  return `SECRET${gap}${token.slice('SECRET'.length)}`;
}

function build(shape: ShapeName, style: SeparatorStyle, blanks: BlankStyle) {
  const { prefix, primary, segments } = SHAPES[shape];
  const alt = primary === '\\' ? '/' : '\\';

  const sep = (index: number): string => {
    switch (style) {
      case 'primary':
        return primary;
      case 'alt':
        return alt;
      case 'mixed':
        return index % 2 === 0 ? primary : alt;
      case 'doubled':
        return primary + primary;
      case 'trailing':
        return primary;
    }
  };

  const tokens = segments.map((segment) => withBlank(segment, blanks));
  const body = tokens.map((token, index) => token + sep(index)).join('');

  // A trailing path stops at the separator; every other style ends in a file.
  const input = prefix + body + (style === 'trailing' ? '' : FILE);

  // `C:` is a drive letter, not an operator secret — it is not asserted absent.
  const secrets = tokens.filter((token) => token.includes('SECRET'));
  return { input, secrets };
}

/**
 * Shapes the tool does NOT guarantee, with the reason and the issue tracking it.
 *
 * These are asserted to STILL LEAK rather than skipped. A skipped case rots
 * silently — this one fails loudly the moment the gap is closed, telling
 * whoever closed it to promote the case. That is the difference between a
 * documented limitation and a Frozen Snapshot (docs/TESTING.md).
 */
const KNOWN_GAPS: Record<string, string> = {
  // #305, FIXED — but these entries STAY, and why they stay is the point.
  //
  // The defect was that relative paths were PARTIALLY reduced:
  // `SECRETDIRA/SECRETDIRB/spec.yaml` became `SECRETDIRAspec.yaml`, leaking a
  // directory AND destroying the filename. The matcher now declines to start
  // mid-token, so these shapes pass through byte for byte.
  //
  // That fixed the CORRUPTION, not the LEAK — relative paths are still not a
  // recognised shape and every directory in them still survives. So
  // `stillLeaks` remains true and none of these entries could be promoted.
  //
  // Worth stating because #305 predicted the opposite: it expected the fix to
  // "remove five of the fifteen relative/* known-gap cases". It removes none.
  // Leaking and being corrupted are independent properties, and only the
  // second one moved — which is exactly why the `survives INTACT` assertion
  // above had to be added rather than relying on this block to witness it.
  'relative/primary': '#305 — relative paths are not a recognised shape',
  'relative/alt': '#305 — relative paths are not a recognised shape',
  'relative/mixed': '#305 — relative paths are not a recognised shape',
  'relative/doubled': '#305 — relative paths are not a recognised shape',
  'relative/trailing': '#305 — relative paths are not a recognised shape',

  // #304. Windows root-relative (`\dir\file`) matches neither runner: the
  // drive-letter and `\\` prefixes anchor WINDOWS_RUN, and POSIX_RUN anchors
  // on `/`. NOT fixed here on purpose — widening the POSIX root to `[\\/]`
  // would also match escape sequences in prose, reducing `\d+\w+` to `w+`.
  // A lone backslash carries no structure to anchor on, so the fix needs a
  // rule rather than a wider character class.
  'winRootRelative/primary': '#304 — Windows root-relative paths are unmatched',
  'winRootRelative/alt': '#304 — Windows root-relative paths are unmatched',
  'winRootRelative/mixed': '#304 — Windows root-relative paths are unmatched',
  'winRootRelative/doubled': '#304 — Windows root-relative paths are unmatched',
  'winRootRelative/trailing': '#304 — Windows root-relative paths are unmatched',
};

describe('path grammar — no directory token survives (#301)', () => {
  const cases: Array<[string, ShapeName, SeparatorStyle, BlankStyle]> = [];
  for (const shape of Object.keys(SHAPES) as ShapeName[]) {
    for (const style of SEPARATORS) {
      for (const blanks of BLANKS) {
        cases.push([`${shape}/${style}/${blanks}`, shape, style, blanks]);
      }
    }
  }

  const guaranteed = cases.filter(([, shape, style]) => !(`${shape}/${style}` in KNOWN_GAPS));
  const gaps = cases.filter(([, shape, style]) => `${shape}/${style}` in KNOWN_GAPS);

  it('enumerates the whole grammar, with nothing silently dropped', () => {
    // A coverage claim nobody can check is how a shrinking matrix goes
    // unnoticed. Sizes are asserted, not described in a comment.
    expect(cases).toHaveLength(
      Object.keys(SHAPES).length * SEPARATORS.length * BLANKS.length,
    );
    expect(guaranteed.length + gaps.length).toBe(cases.length);
  });

  it.each(guaranteed)('%s leaks no directory token', (_name, shape, style, blanks) => {
    const { input, secrets } = build(shape, style, blanks);
    const out = sanitizeErrorText(input);

    for (const secret of secrets) {
      // Compare on the blank-free form too: a leak that survives WITH its tab
      // intact is still a leak, and `SECRET\tDIRA` does not contain
      // `SECRETDIRA` as a substring.
      expect(out).not.toContain(secret);
      expect(out.replace(/[^\S\r\n]+/g, '')).not.toContain(secret.replace(/[^\S\r\n]+/g, ''));
    }
  });

  /**
   * WITNESS for #305 — and the reason it is a SEPARATE assertion from the leak.
   *
   * "Still leaks" was true both before and after the #305 fix, so it could not
   * witness that change: refusing to half-match does not stop an unrecognised
   * shape leaking, it stops the shape being CORRUPTED while it leaks. The two
   * are independent properties and only one of them moved.
   *
   * Before the fix, `SECRETDIRA/SECRETDIRB/spec.yaml` became
   * `SECRETDIRAspec.yaml` — a directory still leaked AND the filename was
   * destroyed. That is worse than the input, while the README's LIMITS section
   * promises an unrecognised shape "may survive with its directory layout
   * intact". This asserts the promise literally: byte-for-byte unchanged.
   *
   * It goes RED on the pre-fix tree for every partially-reduced case, which is
   * what makes it a witness rather than a restatement of the line above.
   */
  it.each(gaps)('%s survives INTACT rather than being partially reduced (#305)', (
    _name,
    shape,
    style,
    blanks,
  ) => {
    const { input } = build(shape, style, blanks);
    expect(sanitizeErrorText(input)).toBe(input);
  });

  it.each(gaps)('%s is a KNOWN GAP and still leaks', (name, shape, style, blanks) => {
    const { input, secrets } = build(shape, style, blanks);
    const out = sanitizeErrorText(input);

    const stillLeaks = secrets.some((secret) => out.includes(secret));
    const reason = KNOWN_GAPS[`${shape}/${style}`];

    // Deliberately inverted. If this throws, the gap was FIXED — remove the
    // entry from KNOWN_GAPS so the case joins the guaranteed set and is
    // protected from regressing again.
    //
    // A thrown Error rather than `expect(x, message)`: that two-argument form
    // is Vitest's, and Jest rejects it with "Expect takes at most one
    // argument" — which fails the test for the wrong reason and hides whether
    // the gap actually closed.
    if (!stillLeaks) {
      throw new Error(
        `${name} no longer leaks — the gap tracked by ${reason} appears fixed. ` +
          `Remove '${shape}/${style}' from KNOWN_GAPS so this case is asserted strictly.`,
      );
    }
    expect(stillLeaks).toBe(true);
  });
});

/**
 * CONTROLS for the #305 delimiter allowlist — every case here PASSES on the
 * pre-fix tree.
 *
 * Named as controls deliberately. They cannot witness the #305 fix, because
 * each one was already sanitised correctly before it. What they guard is the
 * fix OVER-REACHING: refusing to half-match required deciding which characters
 * may abut the start of a path without being part of it, and getting that list
 * too narrow would silently stop sanitising paths that appear in ordinary
 * prose or structured output — trading a corruption bug for a leak.
 *
 * That risk is the reason the list is asserted rather than described. An
 * allowlist in a redaction path that nothing exercises is the shape this file's
 * own header is about.
 */
describe('paths abutted by a delimiter are still reduced (#305 controls)', () => {
  const DIR = 'SECRETDIR';
  const path = `/srv/${DIR}/spec.yaml`;

  const cases: Array<[string, string]> = [
    ['start of string', path],
    ['space', `failed reading ${path} while starting`],
    ['tab', `path:\t${path}`],
    ['newline', `error:\n${path}`],
    ['double quote', `"${path}"`],
    ['single quote', `'${path}'`],
    ['angle bracket', `<${path}>`],
    ['parenthesis', `(${path})`],
    ['square bracket', `[${path}]`],
    ['brace', `{${path}}`],
    ['comma', `a,${path}`],
    ['semicolon', `a;${path}`],
    ['colon', `spec:${path}`],
    ['equals', `--spec=${path}`],
  ];

  it.each(cases)('CONTROL: a path preceded by %s is still reduced', (_name, input) => {
    const out = sanitizeErrorText(input);
    expect(out).not.toContain(DIR);
    expect(out).toContain('spec.yaml');
  });

  it('CONTROL: a separator is NOT a delimiter, so a doubled one cannot re-anchor', () => {
    // Admitting `/` to the allowlist would let `SECRETDIRA//SECRETDIRB//spec.yaml`
    // match at the SECOND slash and reproduce #305 one character along. This is
    // the case that decides that, so it is asserted rather than commented.
    const input = 'SECRETDIRA//SECRETDIRB//spec.yaml';
    expect(sanitizeErrorText(input)).toBe(input);
  });
});

/**
 * The RESIDUAL of the #305 delimiter allowlist — asserted, not argued.
 *
 * The block is MIXED, and each assertion says which it is. Three are true
 * CONTROLS — a first segment ending in a delimiter was matched mid-token
 * before the fix and still is, so their output is identical on both trees and
 * they witness nothing. Three are WITNESSES, and all three were written as
 * CONTROLS and corrected only after being run against a reverted tree.
 *
 * That mislabelling is worth leaving on the record here rather than quietly
 * fixing, because it is the same error one level down as the one this block
 * exists to correct: a claim about behaviour, asserted from reasoning instead
 * of from a measurement, in a change whose whole subject is a residual that
 * was asserted rather than measured.
 *
 * What the controls buy is a documented limitation that is FALSIFIABLE, which
 * is why the block exists at all.
 *
 * ## What the residual is
 *
 * A lookbehind cannot distinguish a delimiter that PRECEDES a path from one
 * that ENDS a directory name — same character, same position. So the allowlist
 * fails in two directions and only one of them is safe:
 *
 *   ABSENT from the list  -> refusal -> survives intact.            SAFE.
 *   PRESENT, at the end of a directory name -> matches mid-token.   CORRUPTION.
 *
 * The change that introduced the allowlist claimed only the first, and offered
 * `foo(` as an illustration of it. `foo(` is the COUNTEREXAMPLE. QA caught it;
 * these assertions are what stop the claim being re-made, because a residual
 * nobody can test is a residual nobody can disprove — the same "unfalsifiable
 * allowlist in a redaction path" this file's header warns about, one level up.
 *
 * Extending the allowlist would make this WORSE: each character added is
 * another way for a directory name to end.
 *
 * If one of these ever stops corrupting, that is a genuine improvement — and
 * the assertion will fail, which is the point. Update it and re-scope the
 * README LIMITS wording in the same change; the two are a pair, and #305 was
 * filed because they had drifted apart.
 */
describe('#305 residual — a directory name ending in a delimiter starts the run mid-token', () => {
  const DIR = 'SECRETDIR';

  /**
   * These three are CONTROLS for the run still starting mid-token — the
   * delimiter list is untouched (#470), so the prefix is still retained.
   *
   * RE-POINTED BY #519, and the reason matters more than the new strings. They
   * asserted `not.toContain('/spec.yaml')` under the name "still leaks a
   * fragment AND destroys the filename": they pinned the CORRUPTION as the
   * expected outcome, which was honest while nothing could be done about it.
   *
   * #519 removes that half. The reduction is marked, so the retained prefix is
   * no longer glued to the basename and the filename survives intact. What has
   * NOT moved is disclosure — measured across all 105 generated cases, zero
   * changed which secrets survive.
   */
  const residual: Array<[string, string, string]> = [
    // The one that matters: on every Windows machine in existence.
    [
      'Program Files (x86)',
      `Program Files (x86)/${DIR}/spec.yaml`,
      'Program Files (x86)[REDACTED:path]/spec.yaml',
    ],
    ['a build number in brackets', `build[1]/${DIR}/spec.yaml`, 'build[1][REDACTED:path]/spec.yaml'],
    ['a bare trailing paren', `foo(/${DIR}/spec.yaml`, 'foo([REDACTED:path]/spec.yaml'],
  ];

  it.each(residual)(
    'CONTROL: %s still starts the run mid-token; the reduction is now marked',
    (_name, input, expected) => {
      const out = sanitizeErrorText(input);

      // Pinned exactly, so a change in either direction is visible.
      expect(out).toBe(expected);

      // THE PROPERTY THAT MUST NOT MOVE: the secret directory is gone. Asserted
      // first, because it is the half #519 was required to leave alone.
      expect(out).not.toContain(DIR);

      // ...and the half #519 fixes: the filename is intact rather than glued to
      // the retained prefix. This REPLACES `not.toContain('/spec.yaml')`, which
      // asserted the opposite.
      expect(out).toContain('[REDACTED:path]/spec.yaml');
    },
  );

  /**
   * WITNESS, despite sitting in a block about the residual — and it was
   * mislabelled a CONTROL until it was actually run against a reverted tree.
   *
   * Both trees corrupt this input, so it looks like a control. They corrupt it
   * DIFFERENTLY: before the fix the run anchored at the FIRST interior
   * separator and produced `deepspec.yaml`; now it anchors at the delimiter
   * and produces `deep/nested/bar(spec.yaml`. Same verdict, different output,
   * so the assertion reddens on the pre-fix tree.
   *
   * Worth keeping distinct from the three above rather than folded in with
   * them: "still corrupts" and "corrupts in the same way" are different
   * claims, and only the second can witness anything.
   */
  it('WITNESS: the residual bites the deepest delimiter segment, not the first', () => {
    expect(sanitizeErrorText(`deep/nested/bar(/${DIR}/spec.yaml`)).toBe(
      'deep/nested/bar([REDACTED:path]/spec.yaml',
    );
  });

  /**
   * WITNESS — also mislabelled a CONTROL on first writing.
   *
   * This is the half of the original residual claim that WAS correct, and it
   * is a genuine witness: before the fix there was no lookbehind at all, so
   * `|/srv/DIR/spec.yaml` reduced to `|spec.yaml`. Refusal is new behaviour.
   */
  it('WITNESS: a character ABSENT from the list causes a refusal, not a reduction', () => {
    for (const input of [`|/srv/${DIR}/spec.yaml`, `*/srv/${DIR}/spec.yaml`]) {
      expect(sanitizeErrorText(input)).toBe(input);
    }
  });

  /**
   * WITNESS — the third mislabelling, and the one that matters most.
   *
   * This bounds the residual: it needs a delimiter at the END of a name, not
   * merely a relative path. Without it the block above would be equally
   * consistent with "all relative paths corrupt", which is the state #305
   * fixed. It reddens pre-fix, where `plainfoo/DIR/spec.yaml` became
   * `plainfoospec.yaml`.
   */
  it('WITNESS: an ordinary directory name is NOT caught by the residual', () => {
    const input = `plainfoo/${DIR}/spec.yaml`;
    expect(sanitizeErrorText(input)).toBe(input);
  });
});

/**
 * NARROWING the delimiter list is a LEAK, not a fix (#470).
 *
 * #470 proposed removing `)` and `]`, on the reading that it would move
 * `Program Files (x86)` from silent corruption to safe refusal. Measured
 * end-to-end through `sanitizeErrorText` with the two characters removed —
 * both directions, on the real code rather than a rebuilt regex:
 *
 *   Program Files (x86)/SECRETDIR/spec.yaml   -> UNCHANGED. SECRETDIR leaks.
 *   build[1]/SECRETDIR/spec.yaml              -> UNCHANGED. SECRETDIR leaks.
 *   [INFO]/srv/SECRETDIR/spec.yaml            -> UNCHANGED. SECRETDIR leaks.
 *   deep/nested/bar)/SECRETDIR/spec.yaml      -> UNCHANGED. SECRETDIR leaks.
 *   see (foo)/srv/SECRETDIR/spec.yaml         -> UNCHANGED. SECRETDIR leaks.
 *
 * Every row the issue counted as a GAIN leaks the secret directory in full.
 * The issue coded them as "refusal -> survives intact" and read that as good;
 * for a redaction tool, what survives intact is the secret.
 *
 * And it does not even remove the corruption class it targets: `(` and `[`
 * stay in the list, so `foo(/SECRETDIR/spec.yaml` corrupts exactly as before.
 * You would pay in leaks and keep the defect.
 *
 * ## Why a test and not only a comment
 *
 * The residual CONTROLs above assert `not.toContain(DIR)`, so a narrowing does
 * redden them — but only TWO of the three, and which two is the argument.
 * `Program Files (x86)` and `build[1]` end in the characters a narrowing
 * removes; `foo(` ends in `(`, which STAYS, so it corrupts exactly as before
 * and stays green. The count is the paragraph above restated as a measurement:
 * narrowing does not remove the corruption class, it only converts the closing
 * half of it into leaks.
 *
 * The two that do redden are still the wrong instrument, because their NAME
 * says "still leaks a fragment AND destroys the filename" — they are framed as
 * pinning a defect, so the natural reading of that red is *"good, the
 * corruption is gone"*, and the natural repair is to update the expectation,
 * deleting the safety clause with it.
 *
 * These are named for the property instead. If one of them reddens, the
 * message is: you have introduced a leak. That is the #431 lesson applied to a
 * ruling — prose is skimmable, and this ruling has now been derived twice.
 */
describe('narrowing the delimiter list would leak (#470)', () => {
  const DIR = 'SECRETDIR';

  // Rows the residual CONTROLs above do NOT cover, so this adds coverage
  // rather than restating theirs.
  const wouldLeak: Array<[string, string, string]> = [
    ['a log-level prefix', `[INFO]/srv/${DIR}/spec.yaml`, '[INFO][REDACTED:path]/spec.yaml'],
    ['a parenthesised aside in prose', `see (foo)/srv/${DIR}/spec.yaml`, 'see (foo)[REDACTED:path]/spec.yaml'],
    ['a closing paren on a DEEP segment', `deep/nested/bar)/${DIR}/spec.yaml`, 'deep/nested/bar)[REDACTED:path]/spec.yaml'],
  ];

  it.each(wouldLeak)(
    'the secret directory is removed today: %s',
    (_name, input, expected) => {
      const out = sanitizeErrorText(input);

      // THE SAFETY PROPERTY, stated first because it is the one that matters.
      // Removing `)` or `]` from PATH_DELIM turns each of these into the input
      // verbatim, secret included.
      expect(out).not.toContain(DIR);
      expect(out).toBe(expected);
    },
  );

  /**
   * WHY NO PATTERN CAN DECIDE THIS — the two rows that settle it.
   *
   * A discriminator would have to tell a `)` that ENDS a directory name from
   * one that PRECEDES a path. These two are byte-identical in shape —
   * `<word><space>(<token>)/<path>` — and require OPPOSITE readings:
   *
   *   Program Files (x86)/DIR/spec.yaml   `(x86)` is IN the path
   *   see (foo)/srv/DIR/spec.yaml         `(foo)` is prose BEFORE the path
   *
   * Bracket balance does not separate them (both balanced), and neither does
   * "is the prefix path-like" (both are a word then a space). The difference
   * is knowing that `Program Files (x86)` is a directory name and `see (foo)`
   * is English — which is not in the input.
   *
   * That is the whole answer to "should this be a pattern rather than a list".
   * It is the OPPOSITE of #454, where the engine already computed the view
   * that answered the question and simply was not consulting it. Same question,
   * and the two answers are worth holding side by side.
   *
   * The current design does not need to tell them apart — it treats both
   * safely, which is exactly what this asserts. Narrowing forces a distinction
   * the input cannot support, which is why it loses on both.
   */
  it('the two shapes are INDISTINGUISHABLE, and both are safe today', () => {
    const asPath = sanitizeErrorText(`Program Files (x86)/${DIR}/spec.yaml`);
    const asProse = sanitizeErrorText(`see (foo)/srv/${DIR}/spec.yaml`);

    expect(asPath).not.toContain(DIR);
    expect(asProse).not.toContain(DIR);

    // Same treatment, from the same rule, with no attempt to tell them apart:
    // prefix kept verbatim, secret removed, basename intact, separator lost.
    expect(asPath).toBe('Program Files (x86)[REDACTED:path]/spec.yaml');
    expect(asProse).toBe('see (foo)[REDACTED:path]/spec.yaml');
  });

  /**
   * The corrupting case needs a path with NO drive letter — narrower than the
   * issue's "on every Windows machine", and narrower than the ruling too.
   *
   * `WINDOWS_RUN` anchors on the drive letter and never consults the
   * lookbehind, so BOTH the native and the mixed-separator forms reduce
   * correctly. The ruling said the mixed form was the corrupting case; it is
   * not. Measured, then asserted here so the corrected premise cannot decay
   * back into the original claim.
   */
  it.each([
    ['native separators', `C:\\Program Files (x86)\\${DIR}\\spec.yaml`],
    ['mixed separators, as WSL and Node produce', `C:/Program Files (x86)/${DIR}/spec.yaml`],
  ])('a drive-letter path reduces cleanly — %s', (_name, input) => {
    expect(sanitizeErrorText(input)).toBe('[REDACTED:path]/spec.yaml');
  });
});

/**
 * The reduction is MARKED rather than silent (#519).
 *
 * `lastPathSegment` returned a bare basename, so a reduction left no trace and
 * a retained prefix was joined straight onto the filename. The marker is the
 * same principle `sanitizeUrlText` already applies to userinfo — "replaced with
 * a marker rather than dropped silently" — and this function was the exception.
 *
 * ## Disclosure is UNCHANGED, and that is measured rather than asserted here
 *
 * The claim is about EVERY path shape the tool handles, not about the fixtures
 * below, so the check belongs where the shapes are enumerated: the generated
 * grammar above runs all 105 and asserts which tokens survive. Before merging
 * this, every one of those was dumped before and after the change and compared:
 * 60 outputs changed FORM, and ZERO changed which secrets survive.
 *
 * That is the acceptance item most likely to be assumed. A marker that widens
 * what survives would be strictly worse than the corruption it fixes, and no
 * count of hand-written fixtures could rule it out.
 */
describe('a reduction is marked, not silent (#519)', () => {
  const DIR = 'SECRETDIR';

  it('marks a reduced POSIX path', () => {
    expect(sanitizeErrorText(`/srv/${DIR}/spec.yaml`)).toBe('[REDACTED:path]/spec.yaml');
  });

  it('marks a reduced Windows path', () => {
    expect(sanitizeErrorText(`C:\\Users\\${DIR}\\spec.yaml`)).toBe('[REDACTED:path]/spec.yaml');
  });

  /**
   * THE NEGATIVE, and it is what stops the marker becoming a lie in the other
   * direction. A single-segment value had no directory to strip, so claiming a
   * reduction there would be the inverse defect — a marker asserting that
   * something was removed when nothing was.
   */
  it('does NOT mark a value with nothing to reduce', () => {
    expect(pathBasenames(['spec.yaml'])).toEqual(['spec.yaml']);
  });

  /**
   * A trailing separator has no basename at all, so the whole value is the
   * marker and there is nothing to append. Unchanged by #519, asserted so the
   * two marker shapes are not confused for each other.
   */
  it('a trailing-separator path is still the bare marker', () => {
    expect(sanitizeErrorText(`/srv/${DIR}/`)).toBe('[REDACTED:path]');
  });

  /**
   * THE ASSERTION THAT CAN TELL MARKED FROM UNMARKED (#540's lesson).
   *
   * `toContain('spec.yaml')` would pass against the OLD output too — the
   * unmarked `spec.yaml` contains it. So the discriminator is the marker
   * IMMEDIATELY BEFORE the basename, plus the absence of the glued form that
   * the old code produced.
   */
  it('the marked form is distinguishable from the unmarked one', () => {
    const out = sanitizeErrorText(`Program Files (x86)/${DIR}/spec.yaml`);

    expect(out).toContain('[REDACTED:path]/spec.yaml');
    // The old output, asserted ABSENT rather than the new one asserted present:
    // the glued form is the harm, and it is what must not come back.
    expect(out).not.toContain('(x86)spec.yaml');
    // ...and disclosure is untouched in the same breath.
    expect(out).not.toContain(DIR);
  });
});
