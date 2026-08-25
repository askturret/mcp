// SPDX-License-Identifier: Apache-2.0
/**
 * Shared colour-support detection for CLI output.
 */

/** The part of a writable stream this module needs. */
export interface ColorStream {
  readonly isTTY?: boolean | undefined;
}

/**
 * Whether ANSI SGR colour should be emitted for `stream`.
 *
 * Two independent suppressors, either of which disables colour:
 *
 * - **`NO_COLOR`** (https://no-color.org). The convention keys on the variable
 *   being PRESENT with a non-empty value — the value itself carries no meaning,
 *   so `NO_COLOR=0` and `NO_COLOR=false` both still DISABLE colour. Only an
 *   unset or empty value leaves colour on, which is why this tests emptiness
 *   rather than truthiness. Reading it as a boolean is the usual way this
 *   convention gets implemented wrong.
 * - **Non-TTY stdout** — redirected to a file or a pipe, where escape codes are
 *   noise that a human reader or a downstream parser has to strip.
 *
 * `stream` and `env` are injectable so callers and tests can exercise both
 * suppressors without mutating globals — mutating `process.env` leaks across
 * jest test files that share a worker.
 */
export function shouldUseColor(
  stream: ColorStream = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const noColor = env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') return false;

  return stream.isTTY === true;
}
