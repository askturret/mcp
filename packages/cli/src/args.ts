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

/** What a command accepts, in the order its help text lists them. */
export interface FlagSpec {
  /** Command name, for the refusal message. */
  readonly command: string;
  /** Flags taking a value — `--url <v>` and `--url=<v>` both work. */
  readonly value: readonly string[];
  /** Flags taking no value. */
  readonly boolean: readonly string[];
}

export interface NormalizedArgs {
  /** argv rewritten into the space-separated form, with `--` removed. */
  readonly args: readonly string[];
  /** The FIRST usage problem. One actionable error beats a pile. */
  readonly error?: string;
}

function unknownFlagMessage(spec: FlagSpec, name: string): string {
  const accepted = [...spec.value.map((f) => `${f} <value>`), ...spec.boolean].join(', ');
  return (
    `error: unknown flag \`${name}\`.\n` +
    `  ${spec.command} accepts: ${accepted}.\n` +
    '  Use `--` to stop option parsing.'
  );
}

export function normalizeFlags(argv: readonly string[], spec: FlagSpec): NormalizedArgs {
  const known = new Set([...spec.value, ...spec.boolean]);
  const takesValue = new Set(spec.value);

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
