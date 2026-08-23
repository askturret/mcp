// SPDX-License-Identifier: Apache-2.0
/**
 * Registry snapshot diff (§13).
 *
 * Compares two `RegistrySnapshot`s and classifies every difference as breaking,
 * non-breaking, double-check or ambiguous, so CI can gate a release on the
 * tool surface the way it already gates on tests.
 *
 * ## Two §13 rules are NOT implemented here, because they cannot be
 *
 * §13 lists six breaking categories. Two of them are not functions of two
 * snapshots:
 *
 * - **"Visibility change — an operation that was visible under a common
 *   principal now requires a new permission."** Permissions are not in a
 *   snapshot at all. `permissionPolicy(required)` takes
 *   `Record<operationId, permissions[]>` as RUNTIME CONFIGURATION, and
 *   visibility is `f(policy, principal, operation)`. `OperationDefinition` has
 *   no permission field, so two snapshots contain identical (zero) permission
 *   information no matter how the policy changed. This rule needs a policy
 *   configuration diff, which is a different input and arguably a different
 *   command.
 *
 * - **"Policy change requiring confirmation for a tool that previously did
 *   not."** Half computable. Confirmation is
 *   `effects.classifications ∩ confirmFor`, and only the first half is in the
 *   snapshot; `confirmFor` comes from `confirmationForEffects(...)` in the
 *   server's policy. So diff computes the snapshot half under an explicit,
 *   caller-supplied assumption about the policy (`DiffOptions.confirmFor`,
 *   defaulting to the production preset's set) and says so in the change
 *   detail. It cannot see a change to the POLICY, only to the classifications
 *   the policy would act on.
 *
 * Both are flagged for QA rather than quietly dropped, because a diff that
 * reports "no breaking changes" while silently not evaluating two of six rules
 * is worse than one that reports what it did not check.
 */

import type { OperationDefinition, RegistrySnapshot } from '../types.js';
import {
  compareInputSchemas,
  compareOutputSchemas,
  schemasStructurallyEqual,
} from './schema-compare.js';
import {
  DEFAULT_CONFIRM_FOR,
  type Change,
  type ChangeSeverity,
  type DiffOptions,
  type DiffReport,
} from './types.js';

export function diffSnapshots(
  before: RegistrySnapshot,
  after: RegistrySnapshot,
  options: DiffOptions = {},
): DiffReport {
  const confirmFor = new Set(options.confirmFor ?? DEFAULT_CONFIRM_FOR);
  const renames = options.renames ?? {};

  const changes: Change[] = [];

  // Apply rename hints first, so a hinted pair is compared as ONE operation
  // rather than surfacing as a removal plus an unrelated addition.
  const beforeIds = new Set(before.operations.keys());
  const afterIds = new Set(after.operations.keys());

  const renamedFrom = new Map<string, string>(); // afterId -> beforeId
  for (const [oldId, newId] of Object.entries(renames)) {
    if (beforeIds.has(oldId) && afterIds.has(newId)) {
      renamedFrom.set(newId, oldId);
    }
  }

  const removedIds = [...beforeIds].filter(
    (id) => !afterIds.has(id) && ![...renamedFrom.values()].includes(id),
  );
  const addedIds = [...afterIds].filter((id) => !beforeIds.has(id) && !renamedFrom.has(id));

  // Operations present in both, plus hinted renames.
  const pairs: { beforeId: string; afterId: string }[] = [];
  for (const id of beforeIds) {
    if (afterIds.has(id)) pairs.push({ beforeId: id, afterId: id });
  }
  for (const [afterId, beforeId] of renamedFrom) {
    pairs.push({ beforeId, afterId });
  }

  // ── Renames ────────────────────────────────────────────────────────────
  //
  // A hinted rename is BREAKING. The hint resolves WHAT happened (one
  // operation moved, rather than one vanishing and another appearing); it does
  // not make the change safe. Agents call operations by id, so an id that no
  // longer resolves breaks them exactly as a removal does. §13 files renames
  // under "ambiguous — flag but don't classify", which is about the UNHINTED
  // case; once the hint tells us it is a rename, it is classifiable, and the
  // honest classification is breaking. Flagged for QA.
  for (const [afterId, beforeId] of renamedFrom) {
    changes.push({
      code: 'operation-renamed',
      severity: 'breaking',
      operationId: afterId,
      detail: `operation id changed '${beforeId}' -> '${afterId}'; callers using the old id will fail`,
    });
  }

  // ── Suspected renames, unhinted ────────────────────────────────────────
  //
  // Detected structurally: a removed and an added operation whose contract is
  // identical apart from the id. Reported as an ADVISORY ALONGSIDE the
  // removal, never instead of it.
  //
  // Downgrading a removal to non-breaking on a heuristic is the one mistake
  // this tool cannot afford: a genuine removal misread as a rename lets a
  // breaking release through the gate silently. So the removal stands, the
  // exit code stays non-zero, and the advisory tells the operator how to
  // reclassify deliberately — with a hint file.
  const suspectedRenames = new Map<string, string>(); // removedId -> addedId
  const claimed = new Set<string>();
  for (const removedId of removedIds) {
    const removed = before.operations.get(removedId);
    if (!removed) continue;

    const matches = addedIds.filter((addedId) => {
      if (claimed.has(addedId)) return false;
      const added = after.operations.get(addedId);
      return added !== undefined && sameContract(removed, added);
    });

    // Exactly one candidate, or no advisory. Two operations with identical
    // contracts give no evidence about WHICH one this was renamed to, and
    // naming an arbitrary one would be a confident-looking guess. Registries
    // full of thin CRUD wrappers make ties common, not hypothetical.
    if (matches.length === 1 && matches[0] !== undefined) {
      suspectedRenames.set(removedId, matches[0]);
      claimed.add(matches[0]);
    }
  }

  // ── Removals and additions ─────────────────────────────────────────────
  for (const id of removedIds.sort()) {
    changes.push({
      code: 'operation-removed',
      severity: 'breaking',
      operationId: id,
      detail: 'operation no longer present; agent workflows depending on it break',
    });

    const suspected = suspectedRenames.get(id);
    if (suspected !== undefined) {
      changes.push({
        code: 'operation-possibly-renamed',
        severity: 'ambiguous',
        operationId: id,
        detail:
          `contract is identical to new operation '${suspected}', so this may be a rename rather ` +
          `than a removal. Diff will not assume so: supply a rename hint ` +
          `({ "${id}": "${suspected}" }) to classify it deliberately.`,
      });
    }
  }

  for (const id of addedIds.sort()) {
    changes.push({
      code: 'operation-added',
      severity: 'non-breaking',
      operationId: id,
      detail: 'new operation',
    });
  }

  // ── Field-level comparison ─────────────────────────────────────────────
  pairs.sort((x, y) => (x.afterId < y.afterId ? -1 : x.afterId > y.afterId ? 1 : 0));
  for (const { beforeId, afterId } of pairs) {
    const b = before.operations.get(beforeId);
    const a = after.operations.get(afterId);
    if (!b || !a) continue;
    changes.push(...compareOperations(b, a, afterId, confirmFor));
  }

  const summary = {
    breaking: changes.filter((c) => c.severity === 'breaking').length,
    nonBreaking: changes.filter((c) => c.severity === 'non-breaking').length,
    doubleCheck: changes.filter((c) => c.severity === 'double-check').length,
    ambiguous: changes.filter((c) => c.severity === 'ambiguous').length,
  };

  return {
    before: { version: before.version, hash: before.hash },
    after: { version: after.version, hash: after.hash },
    changes,
    summary,
    // `ambiguous` does not gate. An ambiguous finding always accompanies a
    // change that IS classified (today: a removal, which is already breaking),
    // so letting it gate on its own would double-count, and letting it gate
    // where nothing else fired would fail builds on a heuristic.
    hasBreaking: summary.breaking > 0,
  };
}

/**
 * Same contract apart from the id — the rename heuristic.
 *
 * `name` is deliberately EXCLUDED. The agent-facing name tracks the id by
 * convention, so a rename almost always changes both; requiring the name to
 * match would make this heuristic fire only for the one case nobody has —
 * an id changed while the name stayed put.
 *
 * `description` is deliberately INCLUDED. It is the cheapest signal that two
 * operations are the same thing rather than two similar CRUD wrappers, and
 * schemas alone tie far too easily (`{}` in, `{}` out describes a great many
 * operations). The cost is that renaming AND rewording in one commit produces
 * no advisory — which is the safe direction to fail, because the removal is
 * still reported as breaking either way. The advisory only ever adds context;
 * it never downgrades anything.
 */
function sameContract(before: OperationDefinition, after: OperationDefinition): boolean {
  return (
    before.description === after.description &&
    schemasStructurallyEqual(before.input, after.input) &&
    schemasStructurallyEqual(before.output, after.output) &&
    JSON.stringify(effectsKey(before)) === JSON.stringify(effectsKey(after))
  );
}

function effectsKey(op: OperationDefinition): unknown {
  return [
    op.effects.readOnly,
    op.effects.idempotent,
    op.effects.retryable,
    op.effects.idempotencyKeyRequired,
    [...op.effects.classifications].sort(),
  ];
}

function compareOperations(
  before: OperationDefinition,
  after: OperationDefinition,
  operationId: string,
  confirmFor: ReadonlySet<string>,
): Change[] {
  const changes: Change[] = [];
  const push = (
    code: Change['code'],
    severity: ChangeSeverity,
    detail: string,
    path?: string,
  ): void => {
    changes.push({ code, severity, operationId, detail, ...(path === undefined ? {} : { path }) });
  };

  // ── Input: tightening breaks callers ─────────────────────────────────
  const input = compareInputSchemas(before.input, after.input);
  for (const c of input.requiredFieldsAdded)
    push('input-required-field-added', 'breaking', c.detail, c.path);
  for (const c of input.typesNarrowed) push('input-type-narrowed', 'breaking', c.detail, c.path);
  for (const c of input.enumsReduced) push('input-enum-reduced', 'breaking', c.detail, c.path);
  for (const c of input.constraintsTightened)
    push('input-constraint-tightened', 'breaking', c.detail, c.path);
  for (const c of input.additionalPropertiesRemoved)
    push('input-additional-properties-removed', 'breaking', c.detail, c.path);
  for (const c of input.unrecognisedChanges)
    push('input-type-narrowed', 'breaking', c.detail, c.path);

  // Removing an input field WIDENS what is accepted, so it does not break a
  // caller that still sends it — unless additionalProperties is now false, and
  // that is already reported above as its own breaking change. §13 does not
  // name this case; classified non-breaking on the variance rule. Flagged.
  for (const c of input.fieldsRemoved) push('input-field-removed', 'non-breaking', c.detail, c.path);
  for (const c of input.optionalFieldsAdded)
    push('input-optional-field-added', 'non-breaking', c.detail, c.path);

  // ── Output: loosening breaks callers ─────────────────────────────────
  const output = compareOutputSchemas(before.output, after.output);
  for (const c of output.fieldsRemoved) push('output-field-removed', 'breaking', c.detail, c.path);
  for (const c of output.typesWidened) push('output-type-widened', 'breaking', c.detail, c.path);
  for (const c of output.unrecognisedChanges)
    push('output-type-widened', 'breaking', c.detail, c.path);
  // A new output field is additive; existing callers ignore it.
  for (const c of output.fieldsAdded) push('output-field-added', 'non-breaking', c.detail, c.path);

  // ── Effects ──────────────────────────────────────────────────────────
  //
  // `readOnly: true -> false` and `idempotent: true -> false` are breaking:
  // an agent that was told it could retry freely can no longer do so, and it
  // has already been written on that promise.
  const tightened: string[] = [];
  const loosened: string[] = [];
  for (const flag of ['readOnly', 'idempotent'] as const) {
    if (before.effects[flag] && !after.effects[flag]) tightened.push(flag);
    if (!before.effects[flag] && after.effects[flag]) loosened.push(flag);
  }
  if (tightened.length > 0) {
    push(
      'effects-tightened',
      'breaking',
      `${tightened.join(' and ')} changed true -> false; callers may no longer retry safely`,
      'effects',
    );
  }
  if (loosened.length > 0) {
    // §13's one "double-check": nothing breaks, but the operation just claimed
    // to become safer, and a mislabelled mutation is how that claim goes wrong.
    push(
      'effects-loosened',
      'double-check',
      `${loosened.join(' and ')} changed false -> true; nothing breaks, but verify the operation really is now safe`,
      'effects',
    );
  }

  // `retryable` / `idempotencyKeyRequired` are not named by §13. Requiring an
  // idempotency key that was not required before DOES break callers who do not
  // send one, so it is reported as tightening rather than ignored. Flagged.
  if (!before.effects.idempotencyKeyRequired && after.effects.idempotencyKeyRequired) {
    push(
      'effects-tightened',
      'breaking',
      'idempotencyKeyRequired changed false -> true; callers not sending a key will be rejected',
      'effects.idempotencyKeyRequired',
    );
  }
  if (before.effects.retryable && !after.effects.retryable) {
    push(
      'effects-tightened',
      'breaking',
      'retryable changed true -> false; callers relying on retry will break',
      'effects.retryable',
    );
  }

  const beforeClasses = new Set(before.effects.classifications);
  const afterClasses = new Set(after.effects.classifications);
  const addedClasses = [...afterClasses].filter((c) => !beforeClasses.has(c)).sort();
  const removedClasses = [...beforeClasses].filter((c) => !afterClasses.has(c)).sort();

  if (addedClasses.length > 0) {
    push(
      'effects-classification-added',
      'non-breaking',
      `effect classifications added: ${addedClasses.join(', ')}`,
      'effects.classifications',
    );
  }
  if (removedClasses.length > 0) {
    push(
      'effects-classification-removed',
      'double-check',
      `effect classifications removed: ${removedClasses.join(', ')}; the operation now declares less risk than before`,
      'effects.classifications',
    );
  }

  // ── Confirmation, under a stated policy assumption ───────────────────
  const confirmedBefore = [...beforeClasses].some((c) => confirmFor.has(c));
  const confirmedAfter = [...afterClasses].some((c) => confirmFor.has(c));

  if (!confirmedBefore && confirmedAfter) {
    push(
      'confirmation-now-required',
      'breaking',
      `now carries a confirmation-triggering classification (${[...afterClasses].filter((c) => confirmFor.has(c)).sort().join(', ')}); ` +
        `callers that did not expect a confirmation challenge will break. ` +
        `Assumes confirmation applies to: ${[...confirmFor].sort().join(', ')}`,
      'effects.classifications',
    );
  }
  if (confirmedBefore && !confirmedAfter) {
    push(
      'confirmation-no-longer-required',
      'double-check',
      `no longer carries a confirmation-triggering classification; a tool that required human ` +
        `acknowledgement now does not. Assumes confirmation applies to: ${[...confirmFor].sort().join(', ')}`,
      'effects.classifications',
    );
  }

  // ── Cosmetic ─────────────────────────────────────────────────────────
  if (before.name !== after.name) {
    push('name-changed', 'non-breaking', `name '${before.name}' -> '${after.name}'`, 'name');
  }
  if (before.description !== after.description) {
    push('description-changed', 'non-breaking', 'description edited', 'description');
  }
  if (JSON.stringify(before.annotations ?? null) !== JSON.stringify(after.annotations ?? null)) {
    push('annotations-changed', 'non-breaking', 'annotations edited', 'annotations');
  }

  // `provenance` is deliberately NOT compared. §13: "Provenance metadata
  // changed (never a real change)." It records where a field came from during
  // compilation, so it moves whenever the pipeline is touched and would
  // otherwise flood every report with changes that mean nothing to a caller.

  return changes;
}
