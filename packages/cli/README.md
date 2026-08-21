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

## MCP Readiness Score (0-100)

The doctor command calculates a readiness score using a stable, documented rubric:

### Base Score: 50

### Bonuses (additive):

- **+10** - Valid OpenAPI spec with no errors
- **+10** - All operations have `operationId`
- **+10** - All operations have descriptions (>20 chars)
- **+5** - All required schemas present (input for mutations, output for GETs)
- **+5** - Fewer than 3 warnings
- **+3** - Fewer than 5 warnings

### Penalties (subtractive):

- **-5 per error** - Critical issues that block deployment
- **-1 per warning** - Non-critical issues worth reviewing

### Score is clamped to 0-100

### Examples:

- **100**: Perfect spec - all checks pass, no warnings
- **80-99**: Production-ready with minor improvements possible
- **60-79**: Good foundation, some issues to address
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

### High score example (Petstore):

```bash
$ npx @askturret/mcp doctor ./petstore.yaml

═══════════════════════════════════════════════════════════════
  AskTurret MCP Doctor - API Readiness Analysis
═══════════════════════════════════════════════════════════════

Spec: Petstore API v1.0.0
OpenAPI: 3.0.0

✓ MCP Readiness Score: 95/100

Summary:
  Total Operations: 3
  Errors:           0
  Warnings:         1
  Info:             0
  Light Exposed:    2
  Light Dropped:    1

Operations:

  Method  Path              OpID          E  W  Light
  ──────  ────────────────  ────────────  ─  ─  ─────
  GET     /pets             listPets      -  -  ✓
  POST    /pets             createPet     -  1  ✗
  GET     /pets/{id}        getPetById    -  -  ✓

Detailed Findings:

  createPet:
    ⚠ [MISSING_EFFECTS] Mutating operation should have x-mcp-effects

Light Preset Policy:
  The following operations would be dropped in Light preset:

  • createPet
    POST operation not auto-exposed (mutations require explicit inclusion)

═══════════════════════════════════════════════════════════════
⚠ Analysis complete with warnings. Review before deployment.
```

### Broken spec example:

```bash
$ npx @askturret/mcp doctor ./broken.yaml

═══════════════════════════════════════════════════════════════
  AskTurret MCP Doctor - API Readiness Analysis
═══════════════════════════════════════════════════════════════

Spec: Broken API v1.0.0
OpenAPI: 3.0.0

✗ MCP Readiness Score: 35/100

Summary:
  Total Operations: 3
  Errors:           2
  Warnings:         5
  Info:             1
  Light Exposed:    1
  Light Dropped:    2

... (detailed findings follow)

═══════════════════════════════════════════════════════════════
✗ Analysis complete with errors. Fix errors before deployment.
```

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
