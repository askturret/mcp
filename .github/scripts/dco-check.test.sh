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

echo
echo "passed: $passed  failed: $failed"
[ "$failed" -eq 0 ]
