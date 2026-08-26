#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Self-test for check-jest-flag-forwarding.mjs (#207).
 *
 * A guard that cannot fail is worse than no guard: it reports safety it never
 * checked, which is the exact defect class it exists to catch. So the negative
 * cases below matter more than the positive ones — each asserts the guard goes
 * RED on a form that really does misbehave, verified against npm's actual
 * behaviour before being encoded here.
 *
 * The guard runs as a SUBPROCESS against the real script, so this exercises the
 * file CI runs rather than a re-implementation of its logic.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, 'check-jest-flag-forwarding.mjs');

let passed = 0;
let failed = 0;
const tmpDirs = [];

function check(desc, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log(`ok   - ${desc}`);
  } else {
    failed++;
    console.log(`FAIL - ${desc} (expected ${expected}, got ${actual})`);
  }
}

/** A throwaway repo root containing `files`, keyed by repo-relative path. */
function scratch(files) {
  const dir = mkdtempSync(join(tmpdir(), 'jestflag-'));
  tmpDirs.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

const run = (dir) => spawnSync('node', [GUARD, dir], { encoding: 'utf-8' });

/** A workflow whose single `run:` step is `command`. */
const workflow = (command) =>
  `name: T\non: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${command}\n`;

// --- The two broken forms. Both were reproduced against npm 11.8 / jest 29.7
// --- before being encoded here, rather than assumed from the flag's shape.

check(
  'FAILS on a jest flag with no `--` (npm eats it and runs everything)',
  run(scratch({ '.github/workflows/t.yml': workflow('npm test --testPathPattern="parity"') })).status,
  1,
);

check(
  'FAILS on `--` without `-w` (flag reaches every workspace; jest exits 1 on a miss)',
  run(scratch({ '.github/workflows/t.yml': workflow('npm test -- --testPathPattern="parity"') }))
    .status,
  1,
);

// --- #312: the false negative. `-w` was checked for PRESENCE while `--` was
// --- checked for POSITION, so a `-w` sitting after the separator counted as
// --- scoping when npm hands it to jest as a plain argument. Measured during
// --- #207 QA at 54 suites / 844 tests, exit 0 — the full core suite, not the
// --- one file the pattern named. That is the #207 silent no-op, reintroduced
// --- through the form this guard was written to prevent.
// ---
// --- The guard's OWN remediation text produced it: "add `--` before the flag,
// --- and `-w <package>` to scope it", followed literally, appends both after
// --- `--` in that order.

{
  const after = run(
    scratch({
      '.github/workflows/t.yml': workflow(
        'npm test -- -w packages/core --testPathPattern="parity"',
      ),
    }),
  );
  check('FAILS on `-w` AFTER `--`, which npm forwards instead of consuming (#312)', after.status, 1);

  // Exit 1 alone would also be satisfied by the guard failing for an unrelated
  // reason, so assert it identified THIS defect and said where the fix goes.
  check(
    '...and reports that the `-w` is on the wrong side of the separator',
    /sits AFTER `--`/.test(after.stderr),
    true,
  );
  check(
    '...and tells the author to MOVE it rather than add one they already typed',
    /move `-w <package>` BEFORE the `--`/.test(after.stderr),
    true,
  );
}

check(
  'PASSES on the correct form, `-w <pkg>` AND `--`',
  run(
    scratch({
      '.github/workflows/t.yml': workflow(
        'npm test -w packages/core -- --testPathPattern="parity"',
      ),
    }),
  ).status,
  0,
);

check(
  'accepts the long spelling --workspace=',
  run(
    scratch({
      '.github/workflows/t.yml': workflow(
        'npm test --workspace=packages/core -- --testPathPattern="parity"',
      ),
    }),
  ).status,
  0,
);

// --- Position matters: a `--` AFTER the flag does not forward it. Without this
// --- the guard would bless a command npm still silently no-ops.

check(
  'FAILS when the `--` comes AFTER the flag rather than before it',
  run(
    scratch({
      '.github/workflows/t.yml': workflow('npm test -w packages/core --testPathPattern="p" --'),
    }),
  ).status,
  1,
);

// --- Other jest flags in the same family, so the guard is about the CLASS
// --- rather than the one flag #207 happened to name.

check(
  'FAILS on --testNamePattern with no `--`',
  run(
    scratch({ '.github/workflows/t.yml': workflow('npm test --testNamePattern="slug"') }),
  ).status,
  1,
);

check(
  'FAILS on jest 30 spelling --testPathPatterns with no `--`',
  // The flag was renamed in jest 30. Covered now so the guard does not quietly
  // stop applying the day this repo upgrades.
  run(
    scratch({ '.github/workflows/t.yml': workflow('npm test --testPathPatterns="slug"') }),
  ).status,
  1,
);

// --- package.json scripts are the other place the string EXECUTES.

check(
  'FAILS on a broken invocation inside a package.json script',
  run(
    scratch({
      'package.json': JSON.stringify({
        name: 't',
        scripts: { 'test:one': 'npm test --testPathPattern=x' },
      }),
    }),
  ).status,
  1,
);

check(
  'PASSES on a correct invocation inside a package.json script',
  run(
    scratch({
      'package.json': JSON.stringify({
        name: 't',
        scripts: { 'test:one': 'npm test -w packages/core -- --testPathPattern=x' },
      }),
    }),
  ).status,
  0,
);

// --- Things that must NOT trip it. A guard with false positives gets disabled,
// --- which is the same outcome as not having written it.

check(
  'a plain `npm test` is not flagged',
  run(scratch({ '.github/workflows/t.yml': workflow('npm test') })).status,
  0,
);

check(
  'a bare `jest --testPathPattern=x` is not flagged — npm is not in the path',
  // Running jest directly has no npm layer to eat the flag, so it works and is
  // none of this guard's business.
  run(scratch({ '.github/workflows/t.yml': workflow('npx jest --testPathPattern=x') })).status,
  0,
);

check(
  'PROSE is not scanned, so CONTRIBUTING can show the broken form as an example',
  // Load-bearing: the documentation added by #207 quotes `npm test
  // --testPathPattern=X` as the thing NOT to do. A guard that scanned prose
  // would fail on its own docs, or force them to omit the string a reader needs
  // in order to recognise the mistake.
  run(
    scratch({
      'CONTRIBUTING.md': 'Do NOT run `npm test --testPathPattern=X` — npm eats the flag.\n',
    }),
  ).status,
  0,
);

check(
  'a package.json with no scripts block does not crash the guard',
  run(scratch({ 'package.json': JSON.stringify({ name: 't' }) })).status,
  0,
);

check(
  'malformed package.json is skipped rather than reported as a flag problem',
  // Not this guard's job, and crashing here would mask the real finding.
  run(scratch({ 'package.json': '{ not json' })).status,
  0,
);

// --- #331: a line may hold SEVERAL commands, and each is judged on its own.
// ---
// --- NPM_TEST runs to the end of what it is handed, so a chain was consumed as
// --- ONE command: the well-formed first half matched, classified clean, and the
// --- second half was never examined. That second half is the #207 silent
// --- full-suite run, so a chain could reintroduce it while the guard stayed
// --- green. Latent when fixed — nothing in this repo chains `npm test` — which
// --- is the point: the next person to write a two-package step walks into it.

for (const sep of ['&&', '||', ';', '|']) {
  check(
    `FAILS on a chain joined by \`${sep}\` whose SECOND command is broken (#331)`,
    run(
      scratch({
        '.github/workflows/t.yml': workflow(
          `npm test -w packages/core -- --testPathPattern=Y ${sep} npm test --testPathPattern=Z`,
        ),
      }),
    ).status,
    1,
  );
}

check(
  'PASSES a chain in which BOTH commands are well-formed (#331)',
  // The paired positive: a split that flagged correct chains would satisfy every
  // negative above and still be wrong.
  run(
    scratch({
      '.github/workflows/t.yml': workflow(
        'npm test -w packages/core -- --testPathPattern=Y && npm test -w packages/cli -- --testPathPattern=Z',
      ),
    }),
  ).status,
  0,
);

{
  const chained = run(
    scratch({
      '.github/workflows/t.yml': workflow(
        'npm test -w packages/core -- --testPathPattern=Y && npm test --testPathPattern=Z',
      ),
    }),
  );
  check(
    'names the SECOND command, not the whole line (#331)',
    // Quoting the whole chain would leave the reader to work out which half is
    // broken; the report has to point at the command that is wrong.
    chained.stderr.includes('npm test --testPathPattern=Z'),
    true,
  );
  check(
    '...and does not quote the well-formed first command back as the finding',
    /FAIL[\s\S]*npm test -w packages\/core -- --testPathPattern=Y/.test(chained.stderr),
    false,
  );
}

// --- A separator inside a QUOTED argument is not a separator. This is where a
// --- naive split breaks, and a jest pattern is exactly where `|` turns up.

check(
  'does NOT split on a `|` inside a double-quoted pattern (#331)',
  run(
    scratch({
      '.github/workflows/t.yml': workflow('npm test -w packages/core -- --testPathPattern="a|b"'),
    }),
  ).status,
  0,
);

check(
  'does NOT split on a `;` inside a single-quoted pattern (#331)',
  run(
    scratch({
      '.github/workflows/t.yml': workflow("npm test -w packages/core -- --testPathPattern='a;b'"),
    }),
  ).status,
  0,
);

check(
  'STILL flags a broken command AFTER a quoted separator (#331)',
  // The paired positive for the two above: quote handling must not swallow the
  // rest of the line, or it becomes the false negative it was written to avoid.
  run(
    scratch({
      '.github/workflows/t.yml': workflow(
        'npm test -w packages/core -- --testPathPattern="a|b" && npm test --testPathPattern=Z',
      ),
    }),
  ).status,
  1,
);

// --- #331 QA: splitting must never COST a finding.
// ---
// --- The first version of this fix split and nothing else, which suppressed
// --- findings the guard used to make. A separator INTERIOR to one command — an
// --- ordinary command substitution is enough — strands the `--` in a segment
// --- holding no `npm test`, leaving the first segment un-forwarded and clean:
// ---
// ---   npm test $(cat p|head -1) -- --testPathPattern=Z    caught before, missed after
// ---
// --- That is plain --testPathPattern reaching EVERY workspace, i.e. the #207
// --- silent no-op, in the guard that exists to refuse exactly it. The scan now
// --- unions the unsplit line with the segments, so splitting can only ADD.

for (const [label, command] of [
  ['a pipe inside a command substitution', 'npm test $(cat p|head -1) -- --testPathPattern=Z'],
  ['the same with a -w after the --', 'npm test $(a|b) -- --testPathPattern=Z -w pkg'],
  ['an && inside a command substitution', 'npm test $(a&&b) -- --testPathPattern=Z'],
  ['a ; inside a command substitution', 'npm test $(a;b) -- --testPathPattern=Z'],
]) {
  check(
    `STILL flags a broken command with ${label} (#331 QA)`,
    run(scratch({ '.github/workflows/t.yml': workflow(command) })).status,
    1,
  );
}

{
  // The union must not report the same defect twice. A broken command followed
  // by a separator is seen by BOTH passes; the segment is the actionable unit,
  // so it supersedes the longer unsplit view rather than joining it.
  const r = run(
    scratch({ '.github/workflows/t.yml': workflow('npm test --testPathPattern=x && echo hi') }),
  );
  check('reports a broken command before a separator exactly ONCE', (r.stderr.match(/ {2}FAIL {2}/g) ?? []).length, 1);
  check(
    '...quoting the command rather than the whole line',
    r.stderr.includes('npm test --testPathPattern=x\n'),
    true,
  );
}

// --- #362 (split from #337 item 1): when the split is WRONG, the segment is a
// --- truncated fragment
// --- and preferring it quotes back a command the file does not contain. The
// --- exit code, file, line, diagnosis and fix were always correct here; only
// --- the echoed command was mangled — the #331/#332 class of a guard whose
// --- output means something slightly other than what it says.
{
  const r = run(
    scratch({ '.github/workflows/t.yml': workflow('npm test --testPathPattern=$(a|b)') }),
  );

  check('a pipe inside $( ) in the flag value is still a finding', r.status, 1);

  // The bug: the pipe is treated as a command boundary, so the segment is
  // `npm test --testPathPattern=$(a` — a string that appears nowhere in the file.
  check(
    'does NOT echo the segment truncated at the interior pipe',
    r.stderr.includes('npm test --testPathPattern=$(a\n'),
    false,
  );

  check(
    '...it echoes the faithful unsplit command instead',
    r.stderr.includes('npm test --testPathPattern=$(a|b)\n'),
    true,
  );

  // Exactly one of the pair survives. Preferring the unsplit rendering must not
  // turn one defect into two reports.
  check(
    '...and still reports the defect exactly ONCE',
    (r.stderr.match(/ {2}FAIL {2}/g) ?? []).length,
    1,
  );
}

// --- The same, with an unclosed quote rather than a paren, so the balance test
// --- is pinned on both constructs it claims to cover.
{
  const r = run(
    scratch({ '.github/workflows/t.yml': workflow("npm test --testPathPattern='a|b'") }),
  );
  check('a pipe inside a quoted value is still a finding', r.status, 1);
  check(
    "...echoing the faithful unsplit command, not the fragment",
    r.stderr.includes("npm test --testPathPattern='a|b'\n"),
    true,
  );
}

// --- #331 QA: the unbalanced-quote fallback is CITED as evidence that the
// --- failure direction is deliberate, so it has to be pinned. QA deleted the
// --- line outright and the suite stayed green — a mechanism offered as proof
// --- that nothing asserts is a claim, not a guarantee.

check(
  'FAILS on a broken command after an UNBALANCED quote (#331 QA)',
  // With the fallback, the line is re-split ignoring quotes and the second
  // command is judged. Without it the open quote swallows the rest of the line,
  // the leading command reads as well-formed, and the broken one disappears.
  run(
    scratch({
      '.github/workflows/t.yml': workflow(
        'npm test -w pkg -- --testPathPattern="oops && npm test --testPathPattern=Z',
      ),
    }),
  ).status,
  1,
);

// --- #332 QA: the message must name the flag that was actually written.
// ---
// --- `wMatch.index` points at the LEADING WHITESPACE, so slicing two characters
// --- back out yielded " -", which trimmed to "-". BOTH spellings printed as a
// --- flag that does not exist, inside the very message #312 added in order to
// --- remove an ambiguity. The spelling is captured now rather than re-derived.

{
  const short = run(
    scratch({
      '.github/workflows/t.yml': workflow('npm test -- -w packages/core --testPathPattern=X'),
    }),
  );
  check('names `-w` when `-w` was written (#332 QA)', short.stderr.includes('`-w` sits AFTER'), true);
  check('...and never prints a bare `-`', short.stderr.includes('`-` sits AFTER'), false);

  const long = run(
    scratch({
      '.github/workflows/t.yml': workflow(
        'npm test -- --workspace=packages/core --testPathPattern=X',
      ),
    }),
  );
  check(
    'names `--workspace` when `--workspace` was written (#332 QA)',
    long.stderr.includes('`--workspace` sits AFTER'),
    true,
  );
}

// --- The guard names the offending file and line, since a report that cannot
// --- be acted on is only a slower way to fail.

const named = run(
  scratch({ '.github/workflows/t.yml': workflow('npm test --testPathPattern="parity"') }),
);
check(
  'names the file and line of the offending command',
  /t\.yml:7/.test(named.stderr),
  true,
);
check(
  'quotes the offending command back',
  named.stderr.includes('npm test --testPathPattern="parity"'),
  true,
);

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
