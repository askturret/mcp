# @askturret/mcp-cli

CLI tools for AskTurret MCP - doctor, inspect, diff, and diagnostics commands.

## Commands

### `doctor` - Offline API Readiness Analysis

Analyze OpenAPI specifications for MCP readiness. Works standalone, no runtime install required.

**Usage:**

```bash
# Analyze a local spec file
npx @askturret/mcp doctor ./openapi.yaml
npx @askturret/mcp doctor ./openapi.json

# Analyze a remote MCP server
npx @askturret/mcp doctor --url http://localhost:7000/mcp

# Output machine-readable JSON
npx @askturret/mcp doctor ./openapi.yaml --json
```

**What it checks:**

1. **OpenAPI Validity** - Spec is parseable and uses a supported version (3.0.x or 3.1.x)
2. **Schema Quality** - Every operation has input schema; GETs have non-empty output schema
3. **Naming** - `operationId` present and agent-friendly (not `p1_get_v3_v4`)
4. **Descriptions** - Non-empty, longer than 20 chars for better agent understanding
5. **Overlapping Tools** - Near-identical names or schemas across operations
6. **Missing Effects** - Mutating operations without `x-mcp-effects` classification
7. **Unsafe Fields** - Request bodies with obvious secret-shaped fields (password/apiKey/ssn)
8. **Exposure Policy** - Which operations the Light preset would drop, and why

**Output:**

- **Human-readable**: Colorized text with structured summary and per-operation table
- **Machine-readable**: JSON via `--json` flag (stable public contract, semver-controlled)

**Exit codes:**

- `0` - No errors found (warnings are OK)
- `1` - Errors detected that must be fixed

### `inspect` - Live Server Introspection

Inspect a running MCP server: handshake, `tools/list`, latency, optional dry-run and snapshot diff.

**Usage:**

```bash
npx @askturret/mcp inspect --url <endpoint>
npx @askturret/mcp inspect --url <endpoint> --tool <name> --dry-run
```

**Exit codes:**

- `0` - Server reached and healthy
- `1` - Server reached but unreachable or unhealthy
- `2` - Fatal error: invalid arguments (such as a missing `--url`), or the inspection itself threw

Note that `1` and `2` are distinct on purpose. `1` means the command ran correctly and is
reporting on the server's state; `2` means the command could not run at all. Scripts that retry
on a transient outage should retry on `1` and never on `2` — retrying a usage error just repeats
it.

## Readiness Score (rubric v1)

The doctor command calculates a readiness score using a stable, documented rubric:

### Base Score: 50

### Bonuses:

- **+10** - Valid OpenAPI spec with no errors
- **+10** - All operations have `operationId`
- **+10** - All operations have descriptions (>20 chars)
- **+5** - All required schemas present (input for mutations, output for GETs)
- **+5** - Fewer than 3 warnings — **or** **+3** for fewer than 5

The last two are **mutually exclusive**, not cumulative: the implementation is an
`if / else if`, so a spec with 0 warnings earns `+5` and *not* `+5 and +3`. This
is the one part of the rubric that reads as additive and is not.

### Penalties (subtractive):

- **-5 per error** - Critical issues that block deployment
- **-1 per warning** - Non-critical issues worth reviewing

The result is clamped to `0-100`.

### The reachable range is 0-90

Adding every bonus to the base gives `50 + 10 + 10 + 10 + 5 + 5 = 90`. **A
flawless spec scores 90, and 91-100 is unreachable** — the clamp's upper bound is
not the rubric's maximum. Both worked examples above confirm it: the clean
fixture scores exactly 90.

This is stated rather than quietly rounded up because the gap is what produced
#107 — a documented `95/100` example, and a "100 = perfect spec" band, for scores
the code cannot emit. Whether the rubric *should* reach 100 is a scoring-behaviour
question, deliberately not changed here.

### Bands:

- **90**: Flawless - every check passes, no warnings (the maximum)
- **75-89**: Production-ready with minor improvements possible
- **60-74**: Good foundation, some issues to address
- **40-59**: Needs work before deployment
- **0-39**: Major issues blocking MCP adoption

## Non-goals

The `doctor` command is **static analysis only**:

- ✗ No overlays applied (though output suggests what overlays could fix)
- ✗ No live invocation (use `inspect` for that)
- ✗ No runtime validation

## Version Stability

- **Scoring rubric** is stable across patch versions
- **JSON output schema** is a public contract - breaking changes bump major version
- **Error codes** are stable identifiers for programmatic use

## Error Codes Reference

| Code | Severity | Description |
|------|----------|-------------|
| `OPENAPI_VERSION_UNSUPPORTED` | error | OpenAPI version not 3.0.x or 3.1.x |
| `MISSING_OPERATION_ID` | error | Operation lacks `operationId` |
| `MISSING_OUTPUT_SCHEMA` | error | GET operation has no output schema |
| `DUPLICATE_OPERATION_ID` | error | Two operations share the same `operationId` |
| `UNFRIENDLY_OPERATION_ID` | warning | Operation ID not agent-friendly |
| `MISSING_DESCRIPTION` | warning | Operation lacks description |
| `SHORT_DESCRIPTION` | info | Description under 20 chars |
| `MISSING_INPUT_SCHEMA` | warning | Mutating operation lacks request body schema |
| `MISSING_EFFECTS` | warning | Mutating operation lacks `x-mcp-effects` |
| `UNSAFE_FIELDS_DETECTED` | warning | Request body contains secret-shaped fields |
| `SIMILAR_OPERATION_NAMES` | warning | Potentially confusing similar names |

## Examples

Both examples below are what `doctor` **actually prints** against the specs
checked in at `src/__tests__/fixtures/`, so you can reproduce them. A test
asserts these blocks still match the command's real output — see
[Keeping these examples honest](#keeping-these-examples-honest).

Transcribed as a terminal renders them, so the colour escape codes are applied
rather than shown. One visible consequence in the broken example: the `E` and `W`
columns sit a space narrower on rows whose counts are non-zero, because a
coloured count is padded before it is coloured. Cosmetic, and not a typo here.

### Clean spec (`fixtures/petstore.json`):

```bash
$ turret doctor src/__tests__/fixtures/petstore.json

═══════════════════════════════════════════════════════════════
  AskTurret MCP Doctor - API Readiness Analysis
═══════════════════════════════════════════════════════════════

Spec: Petstore API v1.0.0
OpenAPI: 3.0.0

✓ MCP Readiness Score: 90/100

Summary:
  Total Operations: 3
  Errors:           0
  Warnings:         0
  Info:             0
  Light Exposed:    2
  Light Dropped:    1

Operations:

  Method  Path                          OpID                  E  W  Light
  ──────  ────────────────────────────  ────────────────────  ─  ─  ─────
  GET     /pets                         listPets              -   -   ✓
  POST    /pets                         createPet             -   -   ✗
  GET     /pets/{id}                    getPetById            -   -   ✓

Light Preset Policy:
  The following operations would be dropped in Light preset:

  • createPet
    POST operation not auto-exposed in Light preset (mutations require explicit inclusion)

═══════════════════════════════════════════════════════════════

✓ Analysis complete. No issues found.
```

Exit code `0`. Note **90 is the maximum** the rubric can produce — see
[Readiness Score](#readiness-score-rubric-v1). A clean spec scoring 90 rather
than 100 is the rubric working as documented, not a deduction you need to hunt for.

### Broken spec (`fixtures/broken.json`):

This is where warnings are worth reading — eight of them, across five distinct
codes.

```bash
$ turret doctor src/__tests__/fixtures/broken.json

═══════════════════════════════════════════════════════════════
  AskTurret MCP Doctor - API Readiness Analysis
═══════════════════════════════════════════════════════════════

Spec: Broken API v1.0.0
OpenAPI: 3.0.0

✗ MCP Readiness Score: 32/100

Summary:
  Total Operations: 3
  Errors:           2
  Warnings:         8
  Info:             0
  Light Exposed:    1
  Light Dropped:    2

Operations:

  Method  Path                          OpID                  E  W  Light
  ──────  ────────────────────────────  ────────────────────  ─  ─  ─────
  GET     /users                        -                     2   1   ✓
  POST    /users                        p1_post_v3            -   4   ✗
  PUT     /users/{id}                   updateUser            -   3   ✗

Detailed Findings:

  GET /users:
    ✗ [MISSING_OPERATION_ID] Operation must have an operationId
    ⚠ [MISSING_DESCRIPTION] Operation should have a description
    ✗ [MISSING_OUTPUT_SCHEMA] GET operation must have a non-empty output schema

  p1_post_v3:
    ⚠ [UNFRIENDLY_OPERATION_ID] Operation ID "p1_post_v3" is not agent-friendly. Consider using camelCase or snake_case descriptive names.
      Suggestion: createUser
    ⚠ [MISSING_DESCRIPTION] Operation should have a description
    ⚠ [MISSING_EFFECTS] Mutating operation should have x-mcp-effects classification
      Suggestion: Add x-mcp-effects to operation object with appropriate effect types
    ⚠ [UNSAFE_FIELDS_DETECTED] Request body contains potentially sensitive fields: password, apiKey. Consider adding redaction hints.
      Fields: password, apiKey

  updateUser:
    ⚠ [MISSING_DESCRIPTION] Operation should have a description
    ⚠ [MISSING_INPUT_SCHEMA] Mutating operation should define request body schema
    ⚠ [MISSING_EFFECTS] Mutating operation should have x-mcp-effects classification
      Suggestion: Add x-mcp-effects to operation object with appropriate effect types

Light Preset Policy:
  The following operations would be dropped in Light preset:

  • p1_post_v3
    POST operation not auto-exposed in Light preset (mutations require explicit inclusion)
  • updateUser
    PUT operation not auto-exposed in Light preset (mutations require explicit inclusion)

═══════════════════════════════════════════════════════════════

✗ Analysis complete with errors. Fix errors before deployment.
```

Exit code `1`. Working the score by hand shows how the rubric composes: base 50,
no bonuses earned (there are errors, a missing `operationId`, missing
descriptions, missing schemas, and 8 warnings is over every warning threshold),
then `-5 x 2 errors` and `-1 x 8 warnings` = **32**.

### Keeping these examples honest

These two blocks drifted from reality once already (#107): the clean example
claimed `95/100` with 1 invented warning, and the broken one claimed `35/100`
with 5 warnings and 1 info. Neither had ever been printed by the command, and
`95` was not even reachable under the rubric.

`src/__tests__/doctor-readme.test.ts` now runs `doctor` against both fixtures and
asserts the score, the summary counts and the closing line in **this file** match
what the command actually prints. If you change the rubric, a check or a fixture,
that test fails and tells you which number to update here.

## Development

```bash
# Build
npm run build

# Test
npm test

# Test watch mode
npm test:watch
```

## License

Apache-2.0
