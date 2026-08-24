<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-021 — Two logger types in `core`, and when the older one retires

**Status:** Accepted (#133)
**Retirement trigger:** Epic #3 / #49 — the central redaction pipeline

## Context

`packages/core` has two logger interfaces.

| | `Logger` | `StructuredLogger` |
|---|---|---|
| Where | `sources/types.ts` | `logging/types.ts` |
| Since | pre-#38 | #38 (§9.3) |
| Methods | `debug` `info` `warn` `error` | `trace` `debug` `info` `warn` `error` `child()` |
| Metadata | `Record<string, unknown>` | `T & SafeLogFields<T>` |
| §9.4 forbidden fields | not enforced | **compile error** |

`StructuredLogger` is a strict superset.

### This is a layering question, not a naming collision

The issue that prompted this was filed as *"two divergent `Logger` types"*, and
that framing suggests the fix is to rename or merge. It is not, and the
distinction changes what "done" means.

The types are named `Logger` and `StructuredLogger`. There is no collision, so
a call site that needs `child()` while holding the legacy type gets a **compile
error**, not a runtime surprise. The real question is which seam owns logging —
plus a safety defect in the bridge between the two, which is the only part with
a security dimension and would have survived any amount of renaming.

### Why the legacy type cannot simply be deleted

It is on two documented public seams: `DiscoveryContext.logger` and
`CompilerContext.logger`.

Widening those to `StructuredLogger` is safe for **consumers** — a superset
still has `.info()`. It is not free for **constructors**: every place that
builds one of those contexts would have to supply `trace` and `child`. That is
both `NOOP_LOGGER` constants in `reload/`, every adapter fixture, and every test
that constructs a discovery context.

### Why not now

Epic #3 (#49) opens these files anyway. `RedactionFn` is explicitly a placeholder
seam for the central redaction pipeline, and `defaultRedaction` is a stand-in
for it. Unifying the logger *before* #49 defines what that pipeline needs means
plausibly migrating the same call sites twice, the second time against a target
that does not exist yet.

## Decision

1. **Both types stay, for now.** `StructuredLogger` is the one new code uses.
   Both doc comments say so, and each points at the other, so a reader arriving
   at either learns which to prefer without having to find this file.

2. **The legacy `Logger` retires as part of Epic #3 / #49.** That is a named
   condition, not "later". #49 opens these call sites regardless, which makes it
   the cheapest moment to widen the seam.

3. **`asLegacyLogger` is kept and made safe** — it is *not* deleted.

## On keeping `asLegacyLogger`

The architectural review recommended deleting it, on the basis that it had
**zero production call sites** and was therefore a trap laid for its first user.
That reasoning was sound; the premise was out of date.

`packages/gateway/src/server.ts:136` calls it. The gateway holds a
`StructuredLogger` and must satisfy `DiscoveryContext.logger`, which is the
legacy type — precisely the seam described above. Deleting the adapter would
have broken the gateway build.

So the review's stated alternative applies: **the bypass is made loud rather
than removed.**

### What the defect was

`StructuredLogger`'s methods are generic over `T & SafeLogFields<T>` for one
purpose — to make `logger.info('x', { rawInput: big })` a compile error. The
adapter erased that:

```ts
logger[level](message, (meta ?? {}) as LogFields);
```

`LegacyLogger.info` takes `meta?: Record<string, unknown>`, unconstrained, and
the cast laundered it into the structured sink. A legacy-side caller passing
`{ rawInput: … }` compiled cleanly and emitted.

**The runtime layer did not catch it either.** `DEFAULT_REDACTED_KEYS` is
credential-shaped — `password`, `token`, `apiKey`, `authorization`, `secret`,
`ssn` — and shares no member with `FORBIDDEN_FIELD_KEYS`. The two lists are
documented as complementary, with neither subsuming the other. Through this
adapter, **both** layers missed.

### Why the fix is at runtime, and not a tighter type

This is worth stating plainly, so the weaker-looking mechanism does not read as
the lazier choice.

The callers that matter — `fromOpenApi`'s discovery, the compiler passes — hold
a `LegacyLogger`. Its `meta` is `Record<string, unknown>` *by definition*, and
those callers never see the adapter's types. Narrowing the adapter's parameter
would change nothing at any real call site, while making the returned object no
longer a `LegacyLogger`. The compile-time guard is structurally unavailable
across this boundary.

So the guard is enforced where it can be. `asLegacyLogger` drops a forbidden
key's **value** and reports the key's **name** under `forbiddenFieldsDropped`.
The names are eight fixed strings from this repository, not data, so emitting
them leaks nothing — and silence was the actual defect. A value that vanished
without trace would only be a quieter version of it.

`FORBIDDEN_FIELD_KEYS` is now a runtime array with `ForbiddenFieldKey` derived
from it, rather than a hand-written union with no runtime counterpart. Two lists
that must agree, maintained by hand, agree until the first time someone adds to
one of them.

## Consequences

**Good**

- A reader arriving at either type learns which to use and why the other exists.
- The adapter is no longer a silent guard bypass, and the drop is visible in the
  record.
- Adding a name to §9.4 extends the compile-time union and the runtime check in
  one edit.

**Bad, and accepted**

- **Two logger types remain**, which is the cost of the deferral. New code can
  still reach for the legacy one; the doc comment is the only thing discouraging
  it.
- **The legacy path's guard is weaker than the structured path's.** A forbidden
  field is caught when it runs, not when it compiles. That is strictly worse
  than a compile error and is a real gap until #49.
- **`forbiddenFieldsDropped` is a new field name** that log consumers may not
  expect. It appears only when something was actually dropped.
- **This ADR describes a state that should not persist.** If #49 ships and the
  legacy type is still here, that is the signal the deferral hardened — which is
  exactly what naming the trigger is meant to make visible.

## References

- `packages/core/src/sources/types.ts` — legacy `Logger`
- `packages/core/src/logging/types.ts` — `StructuredLogger`, `FORBIDDEN_FIELD_KEYS`
- `packages/core/src/logging/logger.ts` — `asLegacyLogger`
- `packages/core/src/logging/redaction.ts` — `DEFAULT_REDACTED_KEYS`
- `packages/gateway/src/server.ts` — the production caller

---
*Operum Engineer · [operum.ai](https://operum.ai)*
