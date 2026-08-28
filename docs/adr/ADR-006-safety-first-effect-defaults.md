<!-- SPDX-License-Identifier: Apache-2.0 -->
# ADR-006 — Effect metadata is inferred safety-first from the HTTP method

**Status:** Accepted. Reconstructed after the fact (#223) — see [Provenance](#provenance).

## Context

An OpenAPI document rarely says whether an operation is safe to retry. It says
`POST /orders`. The canonical model needs `effects` — `readOnly`, `idempotent`,
`retryable`, `idempotencyKeyRequired` — because the dispatcher's retry and
confirmation rules are built on them.

So the compiler has to infer. The question is which way to be wrong when the
spec is silent, and the two directions are not symmetric: guessing "retryable"
for a payment endpoint can charge a customer twice, while guessing "not
retryable" for a safe read costs a retry nobody got.

## Decision

Infer conservatively from the HTTP method, per §2.3 and §5.7:

| Method | `readOnly` | `idempotent` | `retryable` | `idempotencyKeyRequired` |
|---|---|---|---|---|
| `GET`, `HEAD` | true | true | true | false |
| `PUT`, `DELETE` | false | true | **false** | false |
| `POST`, `PATCH` | false | false | false | **true** |

`x-mcp-effects` in the spec overrides the inference. An author who knows better
can say so; the default is what applies when nobody said anything.

## The `PUT`/`DELETE` row is the interesting one

`PUT` and `DELETE` are idempotent by HTTP semantics, so the mechanical reading
would set `retryable: true`. It does not.

Idempotent in the HTTP sense means *the server state after N identical requests
equals the state after one* — which is not the same as *this is safe for us to
replay without being told to*. Retry stays an explicit opt-in. The conservative
default and the spec-accurate default diverge here, and the conservative one
wins.

## Consequences

- **Silence is never read as permission.** An unannotated `POST` gets
  `idempotencyKeyRequired: true`, so the caller is made to supply a key rather
  than the system quietly assuming replay is fine.
- **Adopters must annotate to get retries** on mutating operations. That is
  friction, and it is the intended direction of friction.
- **Inference is only as good as the method.** An API that tunnels writes
  through `GET` is mis-inferred as safe. Nothing here detects that; `doctor`
  surfacing effect metadata is the mitigation, not this pass.

## Provenance

Reconstructed from two surviving citations:

- `packages/sources-openapi/src/from-openapi.ts:497` — *"Per §2.3 safety-first
  defaults and §5.7 ADR-006:"* followed by the table above, and the
  `inferEffects` implementation directly beneath it
- `packages/sources-openapi/src/from-openapi.ts:520` — *"Idempotent mutations,
  but require explicit retry opt-in"*, on the `PUT`/`DELETE` branch itself

The **table is quoted from the source, not inferred.**

In *"The `PUT`/`DELETE` row is the interesting one"*, the two halves have
different evidence and are worth separating:

- **Supported.** *"Retry stays an explicit opt-in"* is `:520` almost verbatim,
  and it sits on the exact branch it describes.
- **Inference.** *Why* HTTP idempotence is not sufficient for replay — the
  distinction between server state after N requests and safety to replay
  unbidden, and the claim that the conservative default beats the spec-accurate
  one — is this document's reconstruction. No surviving comment states it.

Correct the second half if the original rationale resurfaces.

This section previously described itself as a single-citation reconstruction
and flagged the whole subsection as unsupported. That was wrong in the honest
direction — it claimed less evidence than it had — but it was still wrong, and
a provenance note that understates is a provenance note nobody can calibrate
against. Corrected under #321.
