// SPDX-License-Identifier: Apache-2.0
/**
 * Building the support bundle (§13).
 *
 * Everything that reaches an entry goes through #49's central pipeline at
 * `surface: 'diagnostic-bundle'`. Nothing here implements redaction of its
 * own — #49 exists to be the single point of truth for what leaves the
 * process, and a support bundle growing a second, parallel implementation is
 * precisely how that claim stops being true.
 */

import { redactValue } from '@askturret/mcp-core';

import type { TarEntry } from './diagnostics-tar.js';

/** How much of each schema survives without `--full-schemas`. */
export const SCHEMA_TRUNCATE_CHARS = 400;

export interface BundleInputs {
  readonly generatedAt: string;
  readonly versions: Record<string, string>;
  /** Preset expansion, if a preset was named. */
  readonly preset?: unknown;
  readonly registry?: { readonly hash?: string; readonly summary?: unknown };
  readonly tools?: readonly unknown[];
  readonly health?: unknown;
  readonly doctor?: unknown;
  readonly runtimeState?: unknown;
  readonly logTail?: readonly string[];
  /** Absolute paths seen; only basenames are emitted. */
  readonly paths?: readonly string[];
  /** Environment variable NAMES. Values are never accepted here. */
  readonly envNames?: readonly string[];
  readonly fullSchemas?: boolean;
  /** Sections that could not be collected, and why. */
  readonly unavailable?: Record<string, string>;
}

/**
 * Redact for the bundle surface.
 *
 * A named wrapper rather than an inline call at eight sites: it is the one
 * place the surface id is written, so it cannot be typo'd into a surface with
 * different rules at one call site and not another.
 */
export function redactForBundle<T>(value: T): T {
  return redactValue('diagnostic-bundle', value) as T;
}

/**
 * Credential-shaped SUBSTRINGS, for free-text lines.
 *
 * ## Why this exists alongside #49 rather than inside it
 *
 * #49 matches whole VALUES: a field either is a JWT or it is not. That is the
 * right semantics for structured data, and deliberately so — a substring
 * matcher over structured values is how you end up redacting half a URL.
 *
 * A log LINE is not structured. `GET /pets auth=eyJhbGci...` is one string
 * whose credential sits in the middle, so a whole-value rule cannot see it,
 * and §13 asks specifically for the tail to be scrubbed of "residual
 * leakage". Applying substring matching to free text only — never to the
 * structured sections — keeps both properties.
 *
 * Only the ANCHORED, high-precision patterns are used. The entropy heuristic
 * is deliberately absent for the reason #49 documented: as a substring rule
 * it would eat ordinary log content.
 */
const FREE_TEXT_PATTERNS: readonly RegExp[] = [
  // JWTs.
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Authorization headers, however they are spelled in a log line.
  /\b(bearer|basic)\s+\S{8,}/gi,
  // PEM blocks.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/**
 * Mask credential-shaped substrings, preserving the rest of the line.
 *
 * In-place masking rather than dropping the line: a support engineer needs
 * the surrounding request context, and a line replaced wholesale tells them
 * nothing about what was happening when it was written.
 */
export function scrubFreeText(line: string): string {
  let out = line;
  for (const pattern of FREE_TEXT_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

/**
 * Strip operator secrets out of text THIS TOOL constructed.
 *
 * ## Why this is ours to fix and not #49's
 *
 * Node embeds the raw input in its own error strings: a credentialed URL
 * comes back as `Request cannot be constructed from a URL that includes
 * credentials: http://user:sk_live_...@host/mcp`, and a bad path comes back
 * as an ENOENT naming the operator's full absolute path, OS username and all.
 * Both then travelled into `unavailable`, and from there into metadata.json
 * and README.md.
 *
 * #49 matches whole VALUES, and a credential in the middle of a sentence is
 * the documented limitation it cannot generically catch. But this prose is
 * built by US out of input the operator typed, so the sensitive part is
 * knowable at the source — which makes it our job to sanitise here rather
 * than a gap to report upstream.
 *
 * URLs are matched FIRST in the alternation so a URL is consumed as a URL and
 * never chewed up by the path branch, which would otherwise reduce
 * `http://host/a/b/mcp` to `mcp`.
 */
const URL_RUN = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"<>]+/;

/**
 * An absolute path, ALLOWING SPACES in directory names.
 *
 * The previous character class stopped at any whitespace, so
 * `/srv/Acme Holdings/private/spec.yaml` was not merely missed — it was
 * mangled into `Acme Holdingsspec.yaml`, leaking the directory name while
 * corrupting the filename. On Windows spaces are the NORMAL shape
 * (`Program Files`), so the matcher essentially never fired there.
 *
 * Blanks are allowed only in INTERMEDIATE segments — those followed by a
 * separator. The final segment stays blank-free, so in `/srv/x/spec.yaml is
 * missing` the match ends at `spec.yaml`.
 *
 * That boundary is NOT what keeps the trailing prose safe, despite what this
 * comment claimed until #163. Mutation testing settled it: allowing blanks in
 * the final segment is an EQUIVALENT MUTANT — byte-identical output across 18
 * probe cases — because `lastPathSegment` discards everything before the last
 * separator regardless of how far the match ran. The helper is what protects
 * the prose; the boundary is merely tidy. Recorded because a comment asserting
 * the wrong load-bearing part is how the next reader "simplifies" the thing
 * that actually matters.
 *
 * A filename that itself contains blanks is therefore only partly consumed —
 * `/srv/private/my spec.yaml` reduces to `my spec.yaml`. Every DIRECTORY is
 * still stripped, which is what the guarantee is about; the residue is the
 * filename the operator already knows.
 *
 * ## Blanks, not spaces (#163)
 *
 * The allowance was a literal ` +`, so a TAB inside a directory name
 * reproduced the original defect exactly — directory leaked AND filename
 * corrupted (`/srv/Acme\tHoldings/private/spec.yaml` → `Acme\tHoldingsspec.yaml`).
 * `[^\S\r\n]+` covers tab and the other horizontal blanks while still refusing
 * to cross a line, which a bare `\s` would not.
 */
const BLANK = String.raw`[^\S\r\n]`;
/**
 * A POSIX segment excludes BOTH separators (#301).
 *
 * It used to exclude only `/`, so a backslash appearing after a `/` root was
 * not a separator but an ordinary character INSIDE a segment:
 *
 *   /SECRETDIRA\SECRETDIRB\spec.yaml        -> unchanged, both leaked
 *   /SECRET DIRA/SECRET DIRB\spec.yaml      -> "SECRET DIRB\spec.yaml"
 *
 * The second is the nastier one and needed blanks to show up: the run ended at
 * the blank-free final segment `SECRET`, so the output began with a fragment
 * of the very token that leaked. #286 made the WINDOWS matcher accept either
 * separator at every position; this is the same fix on the POSIX side, which
 * was missed because no reported shape happened to combine a `/` root with a
 * later `\`.
 *
 * Note what is deliberately NOT changed: the ROOT still requires `/`. Allowing
 * a bare leading `\` would also match escape sequences in ordinary prose —
 * `\d+\w+` would reduce to `w+` — and there is no anchor to prevent it, unlike
 * the drive-letter and `\\` prefixes that anchor WINDOWS_RUN. That leaves
 * `\dir\file` (Windows root-relative) unhandled; tracked as #304 rather than
 * fixed by widening this.
 *
 * ## This class change is an EQUIVALENT MUTANT for output — kept anyway
 *
 * Measured, not assumed: reverting THIS line while keeping the separator class
 * in `POSIX_RUN` leaves all 105 grammar cases green. Backtracking finds the
 * same split, because `[\\/]+` can claim the backslash even when `SEG` is also
 * allowed to. Nor is it a performance fix — a 20,000-segment input matches in
 * ~0.2ms either way, since the optional final segment means the match always
 * succeeds and never backtracks exhaustively.
 *
 * It is kept for a narrower reason: the #293 comment above states that `SEG`
 * and `SEP` are DISJOINT, "so there is exactly one way to split any input
 * between them". Widening `POSIX_RUN`'s separator to `[\\/]` while leaving `\`
 * inside `SEG` would make that sentence FALSE for this matcher. This file has
 * already been bitten by a comment asserting the wrong load-bearing part, so
 * the choice is between changing the class and rewriting that claim — and the
 * class is the cheaper truth to preserve.
 */
const POSIX_SEG = String.raw`[^\s\\/'"<>]+(?:${BLANK}+[^\s\\/'"<>]+)*`;
const WIN_SEG = String.raw`[^\s\\/'"<>]+(?:${BLANK}+[^\s\\/'"<>]+)*`;

/**
 * ## A separator is a RUN of separators, not one character (#293)
 *
 * Every separator position below quantifies with `+`. `SEG` requires at least
 * one non-separator character, so `(?:SEG SEP)+` cannot traverse an EMPTY
 * segment: a doubled separator broke the run and the match either failed
 * outright or restarted mid-path, which is the round-3 signature — directory
 * leaked AND filename corrupted — for the fourth time:
 *
 *   C:\\DIR\\SUB\\spec.yaml   unchanged, everything leaked
 *   /srv//DIR//spec.yaml      unchanged, everything leaked
 *   C:\DIR\\SUB\spec.yaml  -> `C:\DIRspec.yaml`
 *   \\HOST\\SHARE\spec.yaml -> `\\HOSTspec.yaml`
 *   /srv/DIR//SUB/spec.yaml -> `DIR/spec.yaml`
 *
 * Not exotic: a JSON-stringified Windows path prints every backslash doubled,
 * and a diagnostics bundle is largely serialized error payloads. The JSON form
 * of `\\HOST\SHARE\spec.yaml` is `\\\\HOST\\SHARE\\spec.yaml` — a FOUR-backslash
 * UNC prefix, which is why the prefix accepts `\\{2,}` rather than exactly two.
 * With exactly two it matched from the third backslash, leaving `\\` stranded in
 * front of the basename: no leak, but a corrupted-looking result.
 *
 * Quantifying the separator cannot backtrack catastrophically: `SEG` and `SEP`
 * are DISJOINT character classes (SEG excludes `\` and `/`; SEP is only those),
 * so there is exactly one way to split any input between them.
 */
/**
 * ## The final segment is OPTIONAL, so a trailing separator is consumed (#301)
 *
 * A path ending in a separator has no filename. With the final segment
 * REQUIRED, the match stopped at the last COMPLETE segment — which is a
 * directory — and `lastPathSegment` then faithfully handed it back:
 *
 *   /SECRETDIRA/SECRETDIRB/    ->  "SECRETDIRB/"
 *   C:\SECRETDIRA\SECRETDIRB\  ->  "SECRETDIRB\"
 *   \\SECRETHOST\SECRETSHARE\  ->  "SECRETSHARE\"
 *
 * Optional lets the run consume the trailing separators, so the match ENDS
 * with one — and `lastPathSegment` refuses that shape outright rather than
 * returning the deepest directory.
 *
 * It was reported for POSIX only. The #301 grammar showed it across EVERY
 * guaranteed shape at once — drive, UNC, device and extended-length all had
 * it — which is the difference between enumerating a grammar and fixing the
 * one shape somebody happened to notice.
 */
// The separator class is written out rather than reusing `WIN_SEP`, which is
// declared below this line and would be in its temporal dead zone here.
const POSIX_RUN = new RegExp(String.raw`\/+(?:${POSIX_SEG}[\\/]+)+(?:[^\s\\/'"<>]+)?`);

/**
 * Drive-letter AND UNC paths (#163), with EITHER separator at every position (#286).
 *
 * `[A-Za-z]:\\` alone never matched a UNC path, so
 * `\\fileserver\acme-share\private\spec.yaml` passed through untouched —
 * leaking the file-server hostname, the share name and the layout. Reachable
 * whenever an operator points `--spec` or `--log-file` at a network share,
 * which is ordinary in the enterprise Windows environments the Regulated
 * preset targets.
 *
 * ## Why a single separator was not enough (#286)
 *
 * Windows accepts `/` and `\` interchangeably, and real paths mix them — a
 * config file written on one platform, an argument pasted from another. The
 * #163 version hard-coded `\\` as the separator and `WIN_SEG` excludes `/`, so
 * a mixed path was matched only up to its first forward slash:
 *
 *   \\SECRETHOST\SECRETSHARE/SECRETDIR/spec.yaml
 *   └── WINDOWS_RUN ───────┘└── POSIX_RUN ─────┘
 *
 * Two independent matches, each correctly reduced to its own last segment, the
 * results landing adjacent: `SECRETSHAREspec.yaml`. The share name survives and
 * the filename is corrupted — the round-3 shape yet again, one separator along.
 *
 * #163 did improve it: before that fix nothing matched and the HOSTNAME
 * survived too. Partial credit is still a leak, which is why the README wording
 * is corrected alongside this rather than left to imply the shape was covered.
 *
 * The same defect hit `C:/Program Files/acme/spec.yaml`, which is NOT in the
 * issue — the drive prefix required a backslash, so POSIX_RUN took the tail and
 * left `C:spec.yaml`. Accepting either separator in both positions fixes both.
 *
 * The lookbehind stops the drive-letter branch matching a single letter inside
 * a longer token: without it, the `p` of `http:/host/a` would read as a drive.
 * (That string is still mangled by POSIX_RUN, as it was before — a malformed
 * URL is out of this matcher's remit, and it is noted rather than silently
 * changed.)
 *
 * `lastPathSegment` needed no change: it already splits on both separators, and
 * drops the empty leading fields the `\\` prefix produces.
 */
const WIN_SEP = String.raw`[\\/]`;
const WINDOWS_RUN = new RegExp(
  String.raw`(?:(?<![A-Za-z])[A-Za-z]:${WIN_SEP}+|\\{2,})(?:${WIN_SEG}${WIN_SEP}+)+(?:[^\s\\/'"<>]+)?`,
);

/**
 * A run must START a path token. Refuse to half-match (#305).
 *
 * `POSIX_RUN` anchors on `/` because a leading `/` is a ROOT. On a RELATIVE
 * path there is no root, so it anchored on the first INTERIOR separator
 * instead — consuming the tail, reducing that to its basename, and stranding
 * everything before it:
 *
 *   SECRETDIRA/SECRETDIRB/spec.yaml   ->  "SECRETDIRAspec.yaml"
 *
 * Worse than the input in two ways at once: a directory still leaks, AND the
 * filename a support engineer needs is destroyed. The README's LIMITS section
 * promises an unrecognised shape "may survive with its directory layout
 * intact", which a reader takes as "no worse than the input" — and this is
 * worse. Same leak-and-corrupt signature as #50 round 3, #163, #286 and #293.
 *
 * Refusing turns that into the outcome the docs already describe: the path
 * survives intact. It does NOT stop relative paths leaking — nothing here
 * claims to handle them — so their `KNOWN_GAPS` entries stay. What changes is
 * that the leak is no longer accompanied by corruption.
 *
 * ## Why a delimiter list rather than "not a segment character"
 *
 * The obvious rule — refuse when the preceding character is a segment
 * character — is too strict, because `SEG` is `[^\s\\/'"<>]` and therefore
 * admits punctuation. A path in ordinary prose is routinely abutted by it:
 *
 *   (/srv/SECRETDIR/spec.yaml)      parenthesised
 *   path=/srv/SECRETDIR/spec.yaml   key=value output
 *
 * Under the strict rule both would be REFUSED and would leak in full — a
 * security regression traded for a corruption fix. The permissiveness of `SEG`
 * is deliberate (it is what catches directory names containing odd
 * characters), so the narrowing has to happen here instead.
 *
 * The list below is therefore characters that may ABUT the start of a path
 * without being part of it. Every entry is asserted in the self-test rather
 * than assumed, because an unfalsifiable allowlist in a redaction path is the
 * thing this file has been bitten by before.
 *
 * ## The list fails in BOTH directions, and only one of them is safe
 *
 * An earlier version of this comment claimed the residual was one-directional
 * — that a character missing from the list could only cause a refusal, and a
 * refusal leaves input untouched. Half of that is right, and the half that is
 * wrong named its own counterexample as an illustration:
 *
 *   character ABSENT from the list
 *     -> lookbehind fails -> refusal -> survives intact.  SAFE.
 *     Measured: `|/srv/DIR/spec.yaml`, `*\/srv/DIR/spec.yaml` pass through.
 *
 *   character PRESENT, but sitting at the END OF A DIRECTORY NAME
 *     -> lookbehind PASSES -> the run matches mid-token after all.  CORRUPTION.
 *     Measured: `Program Files (x86)/SECRETDIR/spec.yaml`
 *                 -> `Program Files (x86)spec.yaml`
 *               `build[1]/SECRETDIR/spec.yaml` -> `build[1]spec.yaml`
 *
 * So `foo(` is the COUNTEREXAMPLE, not an example of the safe direction.
 * `Program Files (x86)` is not contrived — it is on every Windows machine —
 * and the outcome is the #305 signature itself, directory leaked AND filename
 * destroyed, produced by the guard written to stop producing it.
 *
 * It is ANY segment, not merely the first:
 * `deep/nested/bar(/DIR/spec.yaml` -> `deep/nested/bar(spec.yaml`.
 *
 * The root cause is that a lookbehind cannot distinguish a delimiter that
 * PRECEDES a path from one that ENDS a directory name. They are the same
 * character in the same position.
 *
 * ## Why the list is NOT extended to cover it
 *
 * The instinct is to add characters. That is backwards: every character added
 * is a new way for a directory name to END, so extending the list WIDENS the
 * corruption surface while narrowing the refusal one. The residual is
 * therefore documented and ASSERTED — see the `Program Files (x86)` case in
 * the self-test — rather than argued away. A residual nobody can test is a
 * residual nobody can disprove, which is how the wrong claim above survived
 * review in the first place.
 *
 * Separators are absent from the list for a different reason. Admitting `/`
 * would let a doubled separator supply the anchor this fix removes:
 * `SECRETDIRA//SECRETDIRB//spec.yaml` would match at the SECOND slash and
 * reproduce the defect one character along.
 */
const PATH_DELIM = String.raw`\s'"<>()\[\]{},;:=`;
const AT_PATH_START = String.raw`(?<![^${PATH_DELIM}])`;

const UNQUOTED = new RegExp(
  `${AT_PATH_START}(?:(${URL_RUN.source})|(${POSIX_RUN.source})|(${WINDOWS_RUN.source}))`,
  'g',
);

/**
 * Last path segment, for BOTH separator styles.
 *
 * Not `node:path`'s `basename`, which is platform-bound: on POSIX it treats a
 * backslash as an ordinary character, so a Windows-shaped path arrives back
 * unchanged.
 *
 * To be accurate about how much this one buys: on a real Windows run
 * `node:path` IS the win32 implementation, so separators would have been
 * handled there anyway. The gap that actually bit was SPACES in the matcher
 * above, not the separator. This helper is the cheaper-to-reason-about choice
 * rather than a second bug fixed — it makes the result independent of which
 * OS the tool happens to run on, which matters because a path string can
 * reach us from a config file or an error message written elsewhere.
 */
function lastPathSegment(value: string): string {
  // A path ending in a separator has NO basename: every token left in it is a
  // DIRECTORY. Filtering the empty trailing field and taking the last part
  // would hand back the deepest directory name — exactly what this function
  // exists to strip — so the shape is refused outright (#301).
  //
  // Placed here rather than at the call site so it holds for every consumer at
  // once: the error-text matchers, `pathBasenames`, and `file:` URLs, which
  // would otherwise disagree about what a basename is.
  if (/[/\\]$/.test(value)) return '[REDACTED:path]';

  const parts = value.split(/[/\\]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? '[REDACTED:path]';
}

/**
 * Reduce a URL to scheme, host and path.
 *
 * Userinfo is replaced with a marker rather than dropped silently: "there
 * were credentials here and we removed them" is useful to whoever reads the
 * bundle, whereas a URL that quietly lost its userinfo looks like the
 * operator never supplied any. The query string goes too — tokens live there
 * at least as often as in userinfo.
 *
 * ## `url.origin` is "null" for every NON-SPECIAL scheme (#294)
 *
 * Not just `file:`. The WHATWG special set is exactly `http`, `https`, `ws`,
 * `wss`, `ftp` and `file`; for anything else — `redis:`, `s3:`, `postgres:`,
 * `mongodb:`, `amqp:`, `git+ssh:` — `url.origin` is the literal string
 * `"null"`, so `${origin}${pathname}` emitted `null/DB`, `null/DIR/spec.yaml`,
 * `null/ORG/repo.git`.
 *
 * The `file:` case above was fixed for the right reason but scoped to one
 * scheme, while the property is general — and the pinning test was named
 * "never emits the literal null for a FILE: URL", narrow enough that the
 * general case stayed invisible. So the branch below tests the PROPERTY
 * (`origin === 'null'`) rather than a scheme name.
 *
 * Two consequences beyond the stray "null", both fixed here: the path
 * survived (database, bucket, vhost and org all leaked), and the
 * `[REDACTED]@` marker silently failed to fire, because `clean` had no
 * `"://"` for the replace to match. Credential VALUES were never emitted —
 * they are not in `url.origin` either — but the marker exists to say
 * "credentials were here", and that is precisely what stopped working.
 *
 * ## Why host AND path both go, rather than a basename
 *
 * There is no scheme-agnostic rule that keeps either one safely, because
 * which component carries the secret VARIES BY SCHEME:
 *
 *   s3://BUCKET/DIR/spec.yaml     — the bucket is the HOST
 *   redis://HOST:6379/DB          — the database is the ENTIRE PATH
 *
 * So keeping the host leaks the bucket, and reducing the path to a basename
 * leaks the database name (`lastPathSegment('/DB')` is `DB`). Only dropping
 * both satisfies every case without teaching this function a list of schemes,
 * which is the coupling that produced the bug in the first place.
 *
 * The scheme is KEPT because it is the diagnostic part — "the redis URL was
 * unreachable" is the useful sentence — and it is not operator-specific. The
 * cost is real and worth naming: for `s3://BUCKET/DIR/spec.yaml` the filename
 * is lost too, where `file:` would have kept it. That asymmetry is deliberate;
 * a `file:` pathname is known to be a filesystem path, whereas a non-special
 * scheme's path is opaque and may be the identifier itself.
 */
function sanitizeUrlText(raw: string): string {
  try {
    const url = new URL(raw);

    const hadCredentials = url.username !== '' || url.password !== '';
    const credentialMarker = hadCredentials ? '[REDACTED]@' : '';

    // A file URL is a path wearing a scheme, so it gets the path treatment.
    // Checked before the general non-special branch below: `file:` also has a
    // "null" origin, but its pathname is known to be a filesystem path, which
    // is the one case where a basename is both safe and useful.
    if (url.protocol === 'file:') return lastPathSegment(decodeURIComponent(url.pathname));

    if (url.origin === 'null') return `${url.protocol}//${credentialMarker}[REDACTED:host]`;

    url.username = '';
    url.password = '';
    const clean = `${url.origin}${url.pathname}`;
    return hadCredentials ? clean.replace('://', `://${credentialMarker}`) : clean;
  } catch {
    // Unparseable but URL-shaped: refuse to emit it at all rather than guess
    // which part was the secret.
    return '[REDACTED:url]';
  }
}

/**
 * ## There is deliberately no separate "quoted path" pass
 *
 * I wrote one — quotes delimit unambiguously, so it looked like the way to
 * handle a path whose FILENAME contains spaces. Then I mutated it away and
 * every test still passed, including the one written for that exact case.
 *
 * The reason is that quote characters are excluded from the path character
 * classes, so a quoted path is matched by the unquoted rules anyway, and the
 * directory segments are stripped either way. For `'/srv/private/my spec.yaml'`
 * both routes produce `'my spec.yaml'` — the run simply stops at `my` and the
 * remaining ` spec.yaml` is already-safe trailing text.
 *
 * So it added no security and no observable behaviour. Deleted rather than
 * kept with a comment asserting it was load-bearing: an unfalsifiable branch
 * in a security-relevant path is worse than none, because the next reader
 * assumes it is doing something.
 */
export function sanitizeErrorText(text: string): string {
  // URLs are matched FIRST in the alternation so a URL is consumed as a URL
  // and never chewed up by the path branch, which would otherwise reduce
  // `http://host/a/b/mcp` to `mcp`.
  return text.replace(UNQUOTED, (match, url: string, posix: string, win: string) => {
    if (url !== undefined) return sanitizeUrlText(url);
    if (posix !== undefined) return lastPathSegment(posix);
    if (win !== undefined) return lastPathSegment(win);
    return match;
  });
}

/**
 * Environment variables, by NAME only.
 *
 * The values are never read — not read-then-redacted, never read. §13 asks
 * for names only, and the difference matters: a redaction rule can be wrong,
 * whereas a value that was never loaded cannot leak however wrong the rules
 * are. This is the one place in the bundle that does not rely on #49 being
 * correct.
 */
export function environmentNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).sort();
}

/** Paths appear as basenames — directory layout is an information leak of its own. */
export function pathBasenames(paths: readonly string[]): string[] {
  // Same helper as the error sanitiser, so the `paths` field and error text
  // cannot disagree about what a basename is.
  return paths.map((path) => lastPathSegment(path));
}

function truncateSchemas(tools: readonly unknown[], full: boolean): unknown[] {
  if (full) return [...tools];

  return tools.map((tool) => {
    if (tool === null || typeof tool !== 'object') return tool;
    const record = { ...(tool as Record<string, unknown>) };

    for (const key of ['inputSchema', 'outputSchema']) {
      const schema = record[key];
      if (schema === undefined) continue;

      const serialized = JSON.stringify(schema);
      if (serialized !== undefined && serialized.length > SCHEMA_TRUNCATE_CHARS) {
        // Replaced with a NOTE, not silently shortened. A truncated JSON blob
        // that no longer parses is worse than an honest marker: a support
        // engineer who sees this knows to ask for --full-schemas, whereas a
        // clipped object looks like a malformed schema on the server.
        record[key] = {
          truncated: true,
          originalBytes: serialized.length,
          note: 'Schema omitted for size. Re-run with --full-schemas to include it.',
        };
      }
    }
    return record;
  });
}

/**
 * One-line description per bundle file, keyed by the filename itself.
 *
 * Data rather than prose so the README can be generated FROM the entries a
 * run actually produced. See `bundleReadme` for why that matters.
 */
const FILE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'metadata.json': 'generation time, tool versions, what was collected.',
  'versions.json': 'package, Node, OS/arch and MCP protocol versions.',
  'configuration.json': 'expanded preset, env var names, path basenames.',
  'registry.json': 'registry hash and operation summary.',
  'tools.json': 'tool definitions as `tools/list` returns them, principal-agnostic.',
  'health.json': 'live/ready endpoint responses.',
  'doctor.json': 'readiness analysis against the supplied OpenAPI spec.',
  'runtime-state.json': 'breaker and bulkhead state.',
  'logs.txt': 'tail of the supplied log file, re-redacted.',
  'README.md': 'this file.',
};

/**
 * The bundle's own README (§13, acceptance).
 *
 * ## The Files list is generated from the ACTUAL entries
 *
 * It used to be a static enumeration of all nine §13 items, printed whatever
 * a run produced. QA caught it: a realistic run emits five files while the
 * README promised nine, which contradicted this bundle's own line three
 * paragraphs down — "an absent section should never be mistaken for an empty
 * one" — and #47's rule that "could not check" must never read as "nothing to
 * report".
 *
 * It also falsified the claim this doc-comment used to make. Taking the
 * filenames from `entries` is what makes "what it claims and what is present
 * cannot drift" true rather than merely stated: the list cannot mention a
 * file the archive does not contain, because it is derived from the archive.
 */
export function bundleReadme(inputs: BundleInputs, filenames: readonly string[] = []): string {
  const unavailable = Object.entries(inputs.unavailable ?? {});

  return [
    '# AskTurret MCP diagnostic bundle',
    '',
    `Generated: ${inputs.generatedAt}`,
    '',
    '## What this bundle IS',
    '',
    'A point-in-time snapshot, produced locally, intended to be attached to a',
    'support request. Nothing was uploaded anywhere: this tool does not call home.',
    '',
    '## Redaction guarantees',
    '',
    '- Every string in every file below was passed through the central redaction',
    "  pipeline at `surface: 'diagnostic-bundle'` — the same pipeline that guards",
    '  logs, spans, metrics, audit records, the Explorer and serialized errors.',
    '- Environment variables appear by NAME ONLY. Their values are never read by',
    '  this tool, so they cannot leak even if a redaction rule is wrong.',
    '- File paths appear as basenames. Directory layout is not included for any',
    '  path shape this tool recognises: POSIX, Windows drive-letter, Windows UNC',
    '  (`\\\\server\\share\\...`) and `file://` URLs — with `/` and `\\` accepted',
    '  interchangeably, and including names containing spaces or tabs.',
    '- URLs keep their scheme. For schemes with a real origin (`http`, `https`,',
    '  `ws`, `wss`, `ftp`) the host and path are kept as well, since they are the',
    '  diagnostic part. For every OTHER scheme — connection URLs such as `redis`,',
    '  `postgres`, `mongodb`, `amqp`, `s3` and `git+ssh` — host and path are both',
    '  removed, because which of the two carries the secret varies by scheme: the',
    '  bucket is the host, whereas the database or vhost is the path.',
    '- Where a URL carried credentials, a `[REDACTED]@` marker is emitted in their',
    '  place, for every scheme, so the bundle says that credentials were present',
    '  rather than looking as though none were supplied.',
    '',
    '## Redaction LIMITS — please read before sharing',
    '',
    '- Redaction matches known key names and credential-shaped values. A secret',
    '  with no recognisable name and no recognisable shape (for example a short',
    '  opaque token under a field called `note`) may NOT be detected.',
    '- Path reduction is pattern-based, over the shapes listed above. A path',
    '  written in some other notation is USUALLY passed through unchanged —',
    '  unreduced, but not altered either. This was stated as an unconditional',
    '  guarantee until such shapes were found — UNC, tab-separated names, and',
    '  mixed `/` and `\\` separators, all now covered. The wording is scoped so',
    '  the claim matches what the code can actually do, and each round of',
    '  scoping followed a real finding.',
    '- "Usually", and here is the exception, because it is common on Windows.',
    '  If one of the path\'s own directory names ENDS in a bracket, quote,',
    '  comma, semicolon, colon or equals sign, the reduction can still start in',
    '  the middle of the path. The everyday case is a Program Files (x86)',
    '  path, which comes back as `Program Files (x86)spec.yaml` — a directory',
    '  fragment joined straight onto the filename. Deeper names do the same:',
    '  `build[1]/private/spec.yaml` becomes `build[1]spec.yaml`.',
    '- Two consequences, stated separately because they are different risks.',
    '  An unrecognised path LEAKS its directory names whether or not it is',
    '  reduced — none of this section is a redaction guarantee. And in the',
    '  exception above the filename is DESTROYED as well, so if a bundle shows',
    '  you a filename that looks glued to a directory fragment, that is what',
    '  happened and the real filename is not recoverable from the bundle.',
    '- A bare host reference with no path (`\\\\SERVER` on its own) is NOT',
    '  reduced. Basename reduction cannot help: the host IS the last segment, so',
    '  redacting it needs a different rule than the one this section describes.',
    '- **Review this bundle before you send it.** These guarantees reduce risk;',
    '  they do not replace a look.',
    '',
    '## What is NOT included',
    '',
    '- Request or response payloads.',
    '- Audit records — those stay in their sink.',
    '- Any live capture of traffic. This is a snapshot, not a packet trace.',
    '- Environment variable values (see above).',
    '',
    '## Files in THIS bundle',
    '',
    ...filenames.map(
      (name) => `- \`${name}\` — ${FILE_DESCRIPTIONS[name] ?? 'see contents.'}`,
    ),
    ...(filenames.includes('tools.json')
      ? [
          inputs.fullSchemas === true
            ? '  Schemas are included in full (`--full-schemas`).'
            : `  Schemas over ${SCHEMA_TRUNCATE_CHARS} bytes are replaced with a marker; re-run with \`--full-schemas\`.`,
        ]
      : []),
    '',
    ...(unavailable.length === 0
      ? []
      : [
          '## Sections that could not be collected',
          '',
          'Listed explicitly rather than omitted silently — an absent section',
          'should never be mistaken for an empty one.',
          '',
          ...unavailable.map(([section, reason]) => `- \`${section}\`: ${reason}`),
          '',
        ]),
  ].join('\n');
}

/**
 * Assemble every bundle entry.
 *
 * The redaction pass is applied HERE, once, to each section's finished value
 * — not at each collector. One place to audit, and no collector can forget.
 */
export function buildBundleEntries(rawInputs: BundleInputs): TarEntry[] {
  const entries: TarEntry[] = [];

  // `unavailable` reasons are FREE TEXT — collector messages, built around
  // whatever the operator typed — and they land in metadata.json AND the
  // README. Scrubbed once, here, so both files get the same treatment.
  //
  // Without this the two disagreed: the README got substring scrubbing while
  // metadata.json got value-level redaction only, so a credential in the
  // MIDDLE of a reason survived in the JSON and not the markdown. A guarantee
  // that holds in one bundle file and not another is not a guarantee.
  const inputs: BundleInputs =
    rawInputs.unavailable === undefined
      ? rawInputs
      : {
          ...rawInputs,
          unavailable: Object.fromEntries(
            Object.entries(rawInputs.unavailable).map(([section, reason]) => [
              section,
              scrubFreeText(reason),
            ]),
          ),
        };

  const json = (name: string, value: unknown): void => {
    entries.push({ name, content: `${JSON.stringify(redactForBundle(value), null, 2)}\n` });
  };

  json('metadata.json', {
    generatedAt: inputs.generatedAt,
    fullSchemas: inputs.fullSchemas === true,
    sections: {
      versions: true,
      configuration: true,
      registry: inputs.registry !== undefined,
      tools: inputs.tools !== undefined,
      health: inputs.health !== undefined,
      doctor: inputs.doctor !== undefined,
      runtimeState: inputs.runtimeState !== undefined,
      logs: inputs.logTail !== undefined,
    },
    unavailable: inputs.unavailable ?? {},
  });

  json('versions.json', inputs.versions);

  json('configuration.json', {
    preset: inputs.preset ?? null,
    environmentVariableNames: inputs.envNames ?? [],
    paths: pathBasenames(inputs.paths ?? []),
  });

  if (inputs.registry !== undefined) json('registry.json', inputs.registry);
  if (inputs.tools !== undefined) {
    json('tools.json', truncateSchemas(inputs.tools, inputs.fullSchemas === true));
  }
  if (inputs.health !== undefined) json('health.json', inputs.health);
  if (inputs.doctor !== undefined) json('doctor.json', inputs.doctor);
  if (inputs.runtimeState !== undefined) json('runtime-state.json', inputs.runtimeState);

  if (inputs.logTail !== undefined) {
    // Re-redacted even though the emitting process already redacted these
    // lines. A log file can predate the redaction pipeline, can come from a
    // differently-configured process, or can have been hand-edited — and §13
    // is explicit that the tail is sanitised for "residual leakage".
    const redacted = inputs.logTail.map((line) =>
      // Both passes: the structured pipeline first (so a key-shaped log line
      // is handled identically to everywhere else), then the free-text
      // scrubber for credentials embedded mid-line.
      scrubFreeText(redactForBundle({ line }).line),
    );
    entries.push({ name: 'logs.txt', content: `${redacted.join('\n')}\n` });
  }

  // README last, and built FROM the entries above plus its own name — so the
  // Files list it prints is the archive's actual contents by construction,
  // not a parallel enumeration that can drift from them.
  const filenames = [...entries.map((entry) => entry.name), 'README.md'];

  // README.md goes through the pipeline too.
  //
  // It was the ONE bundle file that did not: `json()` applied
  // `redactForBundle`, while this entry was pushed straight to the archive.
  // That made the README's own guarantee — "every string in every file below
  // was passed through the central redaction pipeline" — false about the
  // README, which is itself listed under Files. Both passes, same as the log
  // tail, since a README is free text.
  const readme = scrubFreeText(redactForBundle({ text: bundleReadme(inputs, filenames) }).text);
  entries.push({ name: 'README.md', content: `${readme}\n` });

  return entries;
}
