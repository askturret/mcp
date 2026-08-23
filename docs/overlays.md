# Overlays and provenance

§5.3, ADR-019.

An overlay changes what an operation looks like to an agent — its description,
its effect classifications, its visibility — **without editing the source** it
was generated from. That source is often an OpenAPI spec another team owns, or
routes regenerated on every build.

## The file

`askturret.mcp.yaml` (or `.json`):

```yaml
version: 1
operations:
  createOrder:
    description: |
      Places a new order for the authenticated customer.
      Requires a valid product ID and quantity.
    effects:
      classifications: [financial]
      idempotencyKeyRequired: true
    visibility:
      requirePermissions: [orders:write]
    input:
      overrideSchema:
        properties:
          quantity:
            description: Number of units. Must be positive.
```

```ts
const server = createMcpServer({ overlays: ['./askturret.mcp.yaml'] });
```

## Precedence — §5.3, immovable

Highest wins:

| # | Level | `kind` |
|---|---|---|
| 1 | Explicit code enhancement (plugin `setup()`) | `code` |
| 2 | **MCP overlay** | `overlay` |
| 3 | Source-native `x-mcp` metadata | `x-mcp` |
| 4 | The source definition | `openapi` / `framework` |
| 5 | Conservative inference (GET → readOnly) | `inference` |
| 6 | Preset default | `preset` |

The chain is stored as **an ordered array**, not as branching logic. A
comparison that reads its ranking from one array cannot disagree with the table
above; `if`s spread across a merge function can, and eventually do.

`openapi` and `framework` are both level 4 and rank **equally** — six levels,
seven kind values. Ranking them apart would make precedence depend on which
kind of source a spec happened to come from.

## Provenance

Every field carries where it came from, on `OperationDefinition.provenance`:

```ts
[
  { field: 'name',        kind: 'openapi', location: 'petstore.yaml' },
  { field: 'description', kind: 'overlay', location: 'askturret.mcp.yaml#/operations/createOrder/description' },
  { field: 'effects.readOnly', kind: 'inference' },
]
```

The location is a **JSON pointer**, so provenance points at the line an adopter
edits rather than merely naming the file.

Two properties worth knowing:

- **Recorded as decisions are made**, never reconstructed afterwards. A
  reconstruction would be a second implementation of the precedence rules, and
  two implementations drift — at which point "why is this value here?" and the
  value itself disagree, which is worse than not answering.
- **Sorted by field name.** The registry hash is compared across deployments
  (#64), so an array whose order varied with overlay application order would
  make two identical registries hash differently.

## Merge semantics

Schema patches follow **JSON Merge Patch (RFC 7386)**:

- objects merge **recursively**, so patching one property leaves its siblings
  alone;
- `null` **removes** the key — §55's explicit-removal rule;
- arrays **replace**. That is the RFC's rule and the right one here: merging
  `required: ['a','b']` with `required: ['c']` has no defensible answer, and
  picking one silently is how a required field goes missing.

Setting any field to `null` removes it, and the removal is **recorded as an
overlay decision** — "the overlay deleted this" and "nobody ever set it" are
different answers to "why is this not here?"

## Conflicts

Two overlays setting the same field: **the later file wins**, and an
`OVERLAY_CONFLICT` warning is captured.

The warning is the half that is easy to drop and the more important one. A
silent overwrite is indistinguishable from an overlay that never loaded — which
is precisely the confusion overlays-plus-provenance exist to remove.

An overlay targeting an operation that does not exist raises
`OVERLAY_UNMATCHED_OPERATION`, for the same reason: doing nothing silently looks
exactly like working.

## Validation

Overlays are validated at load. **A malformed overlay fails the boot**, except
in `development` mode where the error is collected instead.

The asymmetry is deliberate. An overlay that silently failed to load in
production means the agent sees operations *without* the classifications and
permissions the adopter wrote — a missing `classifications: [financial]` is a
missing confirmation prompt, with nothing anywhere saying so. Refusing to boot
is loud and recoverable; booting without the governance the operator configured
is neither.

Unknown fields are **rejected**, naming the valid ones. A typo (`descriptoin`)
is far likelier than a feature request, and ignoring it means the customisation
never applies with nothing to explain why.

## The YAML reader

`@askturret/mcp-core` has **zero runtime dependencies**, and overlays did not
end that for one config format. YAML is read by a small built-in parser.

**It refuses what it does not understand** — anchors, aliases, merge keys,
multiple documents, flow mappings, nested flow collections, tabs — with a line
number. It never guesses.

That property is the whole argument for hand-writing it. A partial parser that
silently mis-reads an anchor produces an overlay subtly different from what the
adopter wrote, and overlays change what an agent is told it may do. Refusing to
load is a bad morning; loading the wrong thing is a bad quarter.

Supported: nested block mappings, block sequences, flow **sequences** of scalars
(`[financial]`, which the format above uses), quoted and plain scalars, block
scalars (`|` / `>`), comments, `null` / `~` / empty.

`.json` overlays go through `JSON.parse` and never touch it.
