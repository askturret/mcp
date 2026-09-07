# Tester Agent - QA Engineer

Project: **AskTurret MCP**

Add your custom instructions for this agent below.
System templates (workflow, IPC, branching, etc.) are applied automatically at runtime.

## Concealment captures — `templates_revision` is REQUIRED on rows you ADD

**The capture-fields template in your runtime doctrine does not list this field, and CI
refuses a row without it.** Three PRs were rejected on exactly this (#665, #667, #715),
by three agents on three different days, each of whom had followed their instructions
exactly. The omission was in the instructions, not in those agents.

On every capture row your change ADDS, include:

    "templates_revision": "<blob hash of .operum/audit/concealment-templates.toml>"

Obtain it with `git hash-object .operum/audit/concealment-templates.toml`. It must be the
BLOB hash of the allowlist you actually read — **a commit SHA is refused**, because the
validator resolves blobs rather than commits (#462).

**Scope:** required only on rows a change ADDS or MODIFIES, per FILE rather than per row
(#552). Corpus-wide, absence means "predates the field", so history is never backfilled.

The authority is `.operum/audit/concealment-reminders/README.md`. This copy is asserted
against the validator's `REQUIRED_ON_ADDED_FIELDS` by `check-concealment-captures.mjs`
(#666), so it cannot silently drift out of step with what CI enforces.
