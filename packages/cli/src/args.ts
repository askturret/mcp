// SPDX-License-Identifier: Apache-2.0
/**
 * Shared command-line normalisation for the CLI's commands (#261).
 *
 * ## What it is for
 *
 * Every command matched flags by exact string equality, and only `migrate` had
 * a `default:` that refused anything else. So `inspect`, `diff` and
 * `diagnostics` silently discarded any unrecognised `--token` and any
 * `--flag=value` spelling — the same false-green shape #169 was filed for and
 * #256 fixed in `doctor` alone.
 *
 * ## Why a normaliser rather than a parser
 *
 * The obvious move is one generic parser every command adopts. That would mean
 * rewriting four bespoke parsers with four flag sets and four sets of
 * accumulation rules at once, which is a large change to make for a defect
 * about *unrecognised* input.
 *
 * This instead PRE-PROCESSES argv into the form those parsers already handle:
 * `--flag=value` becomes `--flag`, `value`, `--` is honoured and dropped, and
 * anything unrecognised becomes an error the caller reports. Each command then
 * runs its existing loop unchanged. The duplicated logic — splitting, refusing,
 * the carve-outs — lives here once, which is the part that was drifting.
 *
 * `doctor` is deliberately NOT migrated onto this. It has a positional argument
 * and a bespoke `--preset` resolution the other three do not, so folding it in
 * would mean re-testing the command this pattern was just proven on. Noted
 * rather than done.
 *
 * ## The carve-outs, same three as #256
 *
 * A refusal that rejected something previously valid would trade one defect for
 * another:
 *
 *   - `--` ends option parsing. Nothing after it is read as a flag.
 *   - A token that is not flag-like passes through untouched. None of these
 *     three commands take positionals today, so those tokens are ignored
 *     downstream exactly as they were before — this is not the place to start
 *     rejecting them.
 *   - Single-dash tokens are only treated as flags when the command declares
 *     them (`-h`). An undeclared `-x` passes through rather than being refused,
 *     because that is what it did before.
 */

/** One flag a command accepts. */
export interface FlagDef {
  /** Long form, e.g. `--url`. */
  readonly name: string;
  /** Short form, e.g. `-h`. */
  readonly alias?: string;
  /**
   * Value placeholder, e.g. `<url>`. Its PRESENCE is what makes this a
   * value-taking flag — there is no separate boolean marker to keep in step.
   */
  readonly placeholder?: string;
  /**
   * For `--help`. May contain newlines; continuation lines are indented to the
   * description column, so a flag that needs a second sentence keeps it rather
   * than being truncated into the accepted-flags list's shape.
   */
  readonly description: string;
}

/**
 * What a command accepts — ONE list, two renderings (#264).
 *
 * ## Why the shape changed
 *
 * #261 generated the unknown-flag refusal from this spec while each command's
 * `--help` stayed hand-maintained. The two promptly disagreed: `diagnostics
 * --help` listed nine flags while its refusal advertised twelve, omitting
 * `--regulated` — a real disclosure control, and one the `--preset regulated`
 * refusal explicitly sends operators to. An operator taking that advice to
 * `--help` did not find it there.
 *
 * Adding the missing lines would have fixed today's disagreement and left the
 * mechanism that produced it. So the help text and the accepted-flags list are
 * now BOTH derived from this one list. They cannot drift, because there is no
 * longer a second copy to drift from.
 */
export interface FlagSpec {
  /** Command name, for the refusal message. */
  readonly command: string;
  /** In the order `--help` should list them. */
  readonly flags: readonly FlagDef[];
}

export interface NormalizedArgs {
  /** argv rewritten into the space-separated form, with `--` removed. */
  readonly args: readonly string[];
  /** The FIRST usage problem. One actionable error beats a pile. */
  readonly error?: string;
}

/** Every spelling that names this flag. */
function spellings(flag: FlagDef): readonly string[] {
  return flag.alias === undefined ? [flag.name] : [flag.name, flag.alias];
}

/** `--url <url>` / `--help, -h` — one flag as the help's left column shows it. */
function label(flag: FlagDef): string {
  const names = spellings(flag).join(', ');
  return flag.placeholder === undefined ? names : `${names} ${flag.placeholder}`;
}

/**
 * The `Options:` block for `--help`, column-aligned.
 *
 * Returned as lines rather than printed, so a command can place it inside its
 * own help — `diff`'s carries a classification rubric §13 requires, which is
 * not this function's business.
 */
export function renderOptions(spec: FlagSpec): readonly string[] {
  const labels = spec.flags.map(label);
  const width = Math.max(...labels.map((l) => l.length));
  const lines: string[] = [];

  spec.flags.forEach((flag, index) => {
    const [first, ...rest] = flag.description.split('\n');
    lines.push(`  ${(labels[index] ?? '').padEnd(width)}  ${first ?? ''}`);
    // Continuations align under the description, not under the flag.
    for (const line of rest) lines.push(`  ${' '.repeat(width)}  ${line}`);
  });

  return lines;
}

/**
 * The accepted-flags list the unknown-flag refusal prints.
 *
 * Names only — a refusal is a pointer to `--help`, not a replacement for it, and
 * a paragraph per flag in an error message would bury the flag that was wrong.
 */
export function acceptedSummary(spec: FlagSpec): string {
  return spec.flags.map(label).join(', ');
}

function unknownFlagMessage(spec: FlagSpec, name: string): string {
  return (
    `error: unknown flag \`${name}\`.\n` +
    `  ${spec.command} accepts: ${acceptedSummary(spec)}.\n` +
    '  Use `--` to stop option parsing.'
  );
}

export function normalizeFlags(argv: readonly string[], spec: FlagSpec): NormalizedArgs {
  const known = new Set(spec.flags.flatMap(spellings));
  const takesValue = new Set(
    spec.flags.filter((f) => f.placeholder !== undefined).flatMap(spellings),
  );

  const out: string[] = [];
  let error: string | undefined;
  const refuse = (message: string): void => {
    if (error === undefined) error = message;
  };

  let optionsEnded = false;

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === undefined || raw === '') continue;

    if (optionsEnded) {
      out.push(raw);
      continue;
    }

    if (raw === '--') {
      optionsEnded = true;
      continue;
    }

    // A single-dash token is a flag only when the command declares it, so an
    // undeclared `-x` keeps whatever meaning it had (none) instead of becoming
    // a new error.
    if (!raw.startsWith('--') && !known.has(raw)) {
      out.push(raw);
      continue;
    }

    const equals = raw.indexOf('=');
    const name = equals === -1 ? raw : raw.slice(0, equals);
    // An empty inline value (`--url=`) is a MISSING value, not the empty string
    // as a value — otherwise the command reports a confusing downstream error
    // about a blank endpoint.
    const inline = equals === -1 ? undefined : raw.slice(equals + 1) || undefined;

    if (!known.has(name)) {
      // Deliberately does NOT consume a following token: for a flag we do not
      // recognise we cannot know whether it takes a value, and swallowing the
      // next one would turn one error into two.
      refuse(unknownFlagMessage(spec, name));
      continue;
    }

    if (!takesValue.has(name)) {
      if (inline !== undefined) {
        // Ignoring the value would make `--json=false` switch JSON ON, which is
        // the opposite of what was typed.
        refuse(`error: \`${name}\` takes no value (got \`${raw}\`).`);
      }
      out.push(name);
      continue;
    }

    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      // Only consume the next token if it really is a value. Otherwise
      // `--url --json` eats the flag after it and fails somewhere unrelated.
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i++;
      }
    }

    if (value === undefined) {
      refuse(`error: \`${name}\` requires a value.`);
      continue;
    }

    out.push(name, value);
  }

  return error === undefined ? { args: out } : { args: out, error };
}
