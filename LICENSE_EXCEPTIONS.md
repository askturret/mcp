# Licence exceptions

AskTurret MCP is Apache-2.0, and prefers dependencies under permissive licences
compatible with it — MIT, BSD-2/3-Clause, ISC, Apache-2.0 and similar are
auto-approved (architecture §19.7).

The licence gate (`.github/scripts/check-licenses.mjs`, run on every PR) fails
the build when a dependency carries anything else. This file is the only way to
override it, so that every exception is a recorded decision with a name against
it rather than a silently widened policy.

## What blocks by default

| Category | Examples | Why |
|---|---|---|
| Strong copyleft | GPL, AGPL | Incompatible with distributing an Apache-2.0 library |
| Weak copyleft | LGPL | Distribution obligations need legal review before adoption |
| Source-available | SSPL, BUSL, Elastic, Commons Clause | Not open-source; imposes usage restrictions on adopters |
| Undeclared | missing `license`, `UNLICENSED`, `SEE LICENSE IN …` | No grant of rights at all — the riskiest category, not the mildest |
| Unrecognised | anything not on the permissive allowlist | An unrecognised licence is an unread licence |

## Adding an exception

1. **Try to avoid it first.** A permissively licensed alternative is almost
   always cheaper than the review this table represents.
2. Add a row to the table below. **Reason and approver are mandatory** — the
   gate rejects a row missing either.
3. `Version` may be `*` to cover all versions, but pin it where you can, so a
   future major version gets looked at again rather than inheriting approval.
4. `Scope` is `runtime`, `dev`, or `any`. Prefer the narrowest that works: a
   dev-only dependency is not distributed to adopters, which is usually what
   makes the exception defensible in the first place.

A dev-scoped exception does **not** authorise the same dependency at runtime.

## Approved exceptions

| Package | Version | Licence | Scope | Reason | Approved by | Date |
|---|---|---|---|---|---|---|
| `caniuse-lite` | `*` | `CC-BY-4.0` | dev | Browser-support **data**, not code, and a transitive dev-only dependency of the test toolchain (browserslist). CC-BY-4.0 imposes attribution on the data set; nothing from it is compiled into or shipped with any published package, so there is no distribution obligation on adopters. Pinned to dev scope deliberately — this exception does not authorise runtime use. | @didi178 | 2026-08-21 |

## Reviewing this file

Treat a growing table as a signal, not as routine maintenance. Each row is a
dependency whose licence someone had to reason about, and the reasoning is only
as good as the last time it was checked. Re-read the rows when a major version
of the dependency lands, and drop rows whose dependency is gone.
