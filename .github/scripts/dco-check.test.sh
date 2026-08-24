#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Tests for dco-check.sh.
#
# Builds a throwaway git repository and runs the real script against it, so the
# assertions exercise the actual production code path rather than re-stating
# its logic. Run locally with:
#
#   .github/scripts/dco-check.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DCO="$SCRIPT_DIR/dco-check.sh"

if [ ! -x "$DCO" ]; then
  echo "dco-check.sh is missing or not executable at $DCO" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"

git init -q .
git config user.name "Ada Lovelace"
git config user.email "ada@example.com"
git config commit.gpgsign false
git config gc.auto 0

AUTHOR="Ada Lovelace <ada@example.com>"

n=0
commit() { # commit <message>
  n=$((n + 1))
  echo "content $n" >"file-$n.txt"
  git add -A
  git commit -q -m "$1"
}

echo "initial" >README
git add -A
git commit -q -m "initial commit"
BASE="$(git rev-parse HEAD)"

passed=0
failed=0

expect() { # expect <description> <expected-exit> <base> <head>
  local desc="$1" want="$2" base="$3" head="$4" out rc
  out="$("$DCO" "$base" "$head" 2>&1)"
  rc=$?
  if [ "$rc" -eq "$want" ]; then
    printf 'ok   - %s\n' "$desc"
    passed=$((passed + 1))
  else
    printf 'FAIL - %s (expected exit %s, got %s)\n' "$desc" "$want" "$rc"
    printf '%s\n' "$out" | sed 's/^/       | /'
    failed=$((failed + 1))
  fi
}

branch() { git checkout -q -b "$1" "$BASE"; }

# 1. Signed-off commit matching the author -> pass
branch signed
commit "feat: signed

Signed-off-by: $AUTHOR"
expect "commit signed off by its author passes" 0 "$BASE" HEAD

# 2. Unsigned commit -> fail. This is the case the missing check let through.
branch unsigned
commit "feat: unsigned"
expect "commit with no sign-off fails" 1 "$BASE" HEAD

# 3. Sign-off present but for somebody else -> fail
branch mismatched
commit "feat: mismatched

Signed-off-by: Grace Hopper <grace@example.com>"
expect "sign-off not matching author or committer fails" 1 "$BASE" HEAD

# 4. One signed and one unsigned commit -> fail (every commit must be signed)
branch mixed
commit "feat: signed one

Signed-off-by: $AUTHOR"
commit "feat: unsigned two"
expect "a single unsigned commit fails the whole range" 1 "$BASE" HEAD

# 5. Case differences in the trailer -> pass
branch casing
commit "feat: odd casing

signed-off-by: ADA LOVELACE <ADA@EXAMPLE.COM>"
expect "sign-off match is case-insensitive" 0 "$BASE" HEAD

# 6. Several trailers, one of which matches -> pass
branch multi
commit "feat: co-authored

Co-authored-by: Grace Hopper <grace@example.com>
Signed-off-by: Grace Hopper <grace@example.com>
Signed-off-by: $AUTHOR"
expect "passes when one of several sign-offs matches" 0 "$BASE" HEAD

# 7. Trailer block interrupted by a non-trailer line -> still pass
branch interrupted
commit "feat: interrupted trailers

Signed-off-by: $AUTHOR

See https://example.com/some-note for background."
expect "sign-off is found even when it is not the last line" 0 "$BASE" HEAD

# 8. Merge commits are skipped, but their real commits are still checked
branch merge-signed
commit "feat: side branch signed

Signed-off-by: $AUTHOR"
SIDE="$(git rev-parse HEAD)"
git checkout -q -b merge-target "$BASE"
commit "feat: target signed

Signed-off-by: $AUTHOR"
git merge -q --no-ff -m "Merge side branch (no sign-off on the merge itself)" "$SIDE"
expect "unsigned merge commit is skipped when its commits are signed" 0 "$BASE" HEAD

branch merge-unsigned
commit "feat: side branch unsigned"
SIDE_BAD="$(git rev-parse HEAD)"
git checkout -q -b merge-target-bad "$BASE"
commit "feat: target signed too

Signed-off-by: $AUTHOR"
git merge -q --no-ff -m "Merge unsigned side branch" "$SIDE_BAD"
expect "skipping merges does not hide an unsigned commit behind one" 1 "$BASE" HEAD

# 9. Empty range -> pass (nothing to certify)
git checkout -q -b empty "$BASE"
expect "empty commit range passes" 0 "$BASE" HEAD

# 10. Missing arguments -> usage error, distinct from a sign-off failure
out="$("$DCO" 2>&1)"
rc=$?
if [ "$rc" -eq 2 ]; then
  printf 'ok   - missing base argument exits 2\n'
  passed=$((passed + 1))
else
  printf 'FAIL - missing base argument exits 2 (got %s)\n' "$rc"
  failed=$((failed + 1))
fi

# ---------------------------------------------------------------------------
# #141 — commits that acquire a second parent by accident
#
# `git rev-list --no-merges` excluded ANY commit with 2+ parents, so such a
# commit was never examined: not failed, skipped. The fixtures below build one
# the way the bug actually produces it, rather than by hand-rolling a tree.
# ---------------------------------------------------------------------------

# Build an ordinary commit that also carries a second parent already reachable
# from the first — a merge in shape only.
#
# This uses plumbing deliberately. `git commit` CANNOT produce this shape: it
# passes its parent list through reduce_heads(), which drops any parent that is
# already an ancestor of another, so setting MERGE_HEAD to a reachable commit
# yields an ordinary one-parent commit. Porcelain protects you here.
#
# libgit2 does not reduce parents, which is how the nine real instances on main
# came to exist — including one with no trailer that this check skipped in
# silence. `commit-tree` is the closest faithful reproduction available to a
# shell fixture.
accidental_merge() { # accidental_merge <message> <already-reachable-ref>
  local tree new
  n=$((n + 1))
  echo "content $n" >"file-$n.txt"
  git add -A
  tree="$(git write-tree)"
  new="$(git commit-tree "$tree" -p HEAD -p "$(git rev-parse "$2")" -m "$1")"
  git reset -q --hard "$new"
}

# Without this, the tests below could pass for the wrong reason. If the
# MERGE_HEAD trick ever stopped working, the fixture would be an ordinary
# unsigned commit — which fails the check anyway, so the exit code alone proves
# nothing. Assert the shape we believe we constructed.
assert_degenerate() { # assert_degenerate <description> <ref>
  local desc="$1" line count first rest p ok=1
  line="$(git rev-list --parents -n1 "$2")"
  count=$(($(printf '%s' "$line" | wc -w) - 1))
  first="$(printf '%s' "${line#* }" | cut -d' ' -f1)"
  rest="$(printf '%s' "${line#* }" | cut -d' ' -f2-)"
  [ "$count" -ge 2 ] || ok=0
  if [ "$ok" -eq 1 ]; then
    for p in $rest; do
      git merge-base --is-ancestor "$p" "$first" || ok=0
    done
  fi
  if [ "$ok" -eq 1 ]; then
    printf 'ok   - %s\n' "$desc"
    passed=$((passed + 1))
  else
    printf 'FAIL - %s (parents=%s, not a redundant-parent commit)\n' "$desc" "$count"
    failed=$((failed + 1))
  fi
}

# 11. THE ACCEPTANCE CASE (#141): accidental second parent, no sign-off.
branch degenerate-unsigned
commit "feat: groundwork

Signed-off-by: $AUTHOR"
accidental_merge "feat: unsigned, and accidentally a merge" "$BASE"
assert_degenerate "fixture: accidental merge carries an extra, redundant parent" HEAD
expect "unsigned commit that accidentally became a merge fails (was skipped)" 1 "$BASE" HEAD

# 12. Control against over-correcting. The same shape, correctly signed, must
# still pass — "fail anything with two parents" would reject 41 commits of this
# repository's own history.
branch degenerate-signed
commit "feat: groundwork again

Signed-off-by: $AUTHOR"
accidental_merge "feat: signed, and accidentally a merge

Signed-off-by: $AUTHOR" "$BASE"
assert_degenerate "fixture: signed accidental merge carries a redundant parent" HEAD
expect "accidental merge that is signed off passes" 0 "$BASE" HEAD

# 13. The #135 incident itself: EVERY commit in the range carries a second
# parent, so `--no-merges` filtered the branch down to nothing and the script
# reported success having verified zero commits.
#
# This needs a base with an ancestor behind it: the second parent has to be
# reachable-but-distinct, and a parent equal to the first is discarded as a
# duplicate rather than kept as a redundant one.
branch all-degenerate-base
commit "feat: fork point

Signed-off-by: $AUTHOR"
T13_BASE="$(git rev-parse HEAD)"
accidental_merge "feat: first, accidentally a merge

Signed-off-by: $AUTHOR" "$BASE"
assert_degenerate "fixture: #135 repro, first commit is a redundant-parent merge" HEAD
accidental_merge "feat: second, accidentally a merge, unsigned" "$BASE"
assert_degenerate "fixture: #135 repro, second commit is a redundant-parent merge" HEAD
if [ -z "$(git rev-list --no-merges "$T13_BASE"..HEAD)" ]; then
  printf 'ok   - fixture: the old --no-merges selection returns ZERO commits here\n'
  passed=$((passed + 1))
else
  printf 'FAIL - fixture: --no-merges still selects commits, so this is not the #135 shape\n'
  failed=$((failed + 1))
fi
expect "branch where every commit is an accidental merge is still verified" 1 "$T13_BASE" HEAD

# 14. The exclusion must be VISIBLE. The original defect stayed hidden because
# a run that skipped everything read exactly like a run that passed everything.
branch visible-skip
commit "feat: side signed

Signed-off-by: $AUTHOR"
SIDE_V="$(git rev-parse HEAD)"
git checkout -q -b visible-skip-target "$BASE"
commit "feat: target signed

Signed-off-by: $AUTHOR"
git merge -q --no-ff -m "Merge side branch, unsigned merge commit" "$SIDE_V"
out="$("$DCO" "$BASE" HEAD 2>&1)"
if printf '%s' "$out" | grep -q 'Skipped 1 genuine merge commit'; then
  printf 'ok   - the genuine merge that was skipped is named in the output\n'
  passed=$((passed + 1))
else
  printf 'FAIL - skipped-merge count is not reported in the output\n'
  printf '%s\n' "$out" | sed 's/^/       | /'
  failed=$((failed + 1))
fi

echo
echo "passed: $passed  failed: $failed"
[ "$failed" -eq 0 ]
