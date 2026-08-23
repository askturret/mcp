// SPDX-License-Identifier: Apache-2.0
/**
 * Pass 3: Apply overlays and code enhancements (§5.3, ADR-019, #55).
 *
 * The v0.1 no-op stub, filled in. The pipeline is untouched: this pass keeps
 * its name, its position, its signature and its place in `COMPILER_PASSES` —
 * #55 asks for the stub to become real, not for the compiler to be rewritten,
 * and every surrounding pass still sees the shape it saw before.
 *
 * ## Why here, and not later
 *
 * Pass 3 runs BEFORE generate-names (4) and infer-effects (6), and that
 * ordering is load-bearing rather than incidental:
 *
 *   - an overlay that renames an operation must be visible to name generation,
 *     or a name would be derived from the source id and then overwritten —
 *     which is not the same result as deriving it from the override;
 *   - an overlay that sets `readOnly` must be visible to inference, so
 *     inference can decline to overwrite something an adopter stated.
 *
 * Provenance carries that forward: a field marked `overlay` outranks
 * `inference`, so a later pass can tell "chosen" from "defaulted".
 */

import type { CompilerPass, CompiledOperation, CompilerContext } from '../types.js';
import {
  applyOverlaysToOperation,
  provenanceEntries,
  unmatchedOverlayIds,
  type OverlayTarget,
} from '../../overlay/merge.js';
import { validateOverlayDocument } from '../../overlay/load.js';
import type { OverlayConflict, OverlayDocument, ProvenanceSource } from '../../overlay/types.js';

/**
 * Provenance for what the earlier passes established.
 *
 * Everything a source produced is `source`; hint-derived effect flags are
 * `inference`. Recorded so an overlay's win is a comparison against something
 * real, rather than an assumption that nothing was there.
 */
function baseProvenance(operation: CompiledOperation): Record<string, ProvenanceSource> {
  const location = operation.source?.location;
  const kind = 'openapi' as const;
  const at: ProvenanceSource = location === undefined ? { kind } : { kind, location };

  const provenance: Record<string, ProvenanceSource> = {};
  if (operation.name !== undefined) provenance['name'] = at;
  if (operation.description !== undefined) provenance['description'] = at;
  if (operation.rawInput !== undefined) provenance['input'] = at;
  if (operation.rawOutput !== undefined) provenance['output'] = at;

  for (const key of Object.keys(operation.effects ?? {})) {
    // Effects here come from source hints, which §5.3 ranks as conservative
    // inference — below an overlay, above a preset default.
    provenance[`effects.${key}`] = { kind: 'inference' };
  }

  return provenance;
}

/**
 * Accept whatever the caller put in `context.overlays`.
 *
 * That field is typed as the v0.1 `Overlay` (`{ id, [key: string]: unknown }`),
 * which predates this format. Rather than widen a type every pass shares, an
 * entry is validated HERE through the same validator a file goes through — so
 * an adopter passing an overlay inline gets identical rules to one loading a
 * file, and "it worked from a file but not in code" never becomes a real bug
 * report.
 */
function asOverlayDocument(raw: unknown, index: number): OverlayDocument {
  const candidate = raw as { location?: unknown; id?: unknown };
  const location =
    typeof candidate.location === 'string'
      ? candidate.location
      : typeof candidate.id === 'string'
        ? candidate.id
        : `overlay[${index}]`;

  return validateOverlayDocument(raw, location);
}

export const applyOverlays: CompilerPass = {
  name: 'apply-overlays',

  async run(
    operations: readonly CompiledOperation[],
    context: CompilerContext,
  ): Promise<readonly CompiledOperation[]> {
    context.logger.debug('Running apply-overlays pass', {
      count: operations.length,
      overlayCount: context.overlays.length,
    });

    if (context.overlays.length === 0) return operations;

    const documents = context.overlays.map((overlay, index) => asOverlayDocument(overlay, index));
    const conflicts: OverlayConflict[] = [];

    const applied = operations.map((operation) => {
      const id = operation.candidateId ?? operation.name;

      const target: OverlayTarget = {
        id,
        ...(operation.name === undefined ? {} : { name: operation.name }),
        ...(operation.description === undefined ? {} : { description: operation.description }),
        ...(operation.effects === undefined
          ? {}
          : { effects: { ...operation.effects } as Record<string, unknown> }),
        ...(operation.rawInput === undefined ? {} : { rawInput: operation.rawInput }),
        ...(operation.rawOutput === undefined ? {} : { rawOutput: operation.rawOutput }),
        ...(operation.annotations === undefined
          ? {}
          : { annotations: operation.annotations as Record<string, unknown> }),
      };

      const { operation: merged, provenance } = applyOverlaysToOperation(
        target,
        documents,
        baseProvenance(operation),
        conflicts,
      );

      return {
        ...operation,
        ...(merged.name === undefined ? {} : { name: merged.name }),
        ...(merged.description === undefined ? {} : { description: merged.description }),
        ...(merged.effects === undefined
          ? {}
          : { effects: merged.effects as CompiledOperation['effects'] }),
        ...(merged.rawInput === undefined ? {} : { rawInput: merged.rawInput }),
        ...(merged.rawOutput === undefined ? {} : { rawOutput: merged.rawOutput }),
        ...(merged.annotations === undefined ? {} : { annotations: merged.annotations }),
        // Carried on the operation so later passes and the snapshot can read
        // it. §55 asks only that provenance be RESOLVABLE — the Explorer UI is
        // a sibling issue — and a field on the compiled operation is the
        // narrowest thing that satisfies it.
        provenance: provenanceEntries(provenance),
        ...(merged.visibility === undefined ? {} : { overlayVisibility: merged.visibility }),
      } as CompiledOperation;
    });

    for (const conflict of conflicts) {
      // §55: "deterministic winner (later file), warning captured." The winner
      // is deterministic; this is the captured half, and it is what makes a
      // silent overwrite distinguishable from an overlay that never loaded.
      context.warnings.warn({
        code: 'OVERLAY_CONFLICT',
        message:
          `Overlay field '${conflict.field}' on operation '${conflict.operationId}' is set by ` +
          `more than one overlay; the later one wins.`,
        location: conflict.winner,
        details: { winner: conflict.winner, loser: conflict.loser },
      });
    }

    const knownIds = new Set(applied.map((operation) => operation.candidateId ?? operation.name));
    for (const missing of unmatchedOverlayIds(documents, knownIds)) {
      // An overlay keyed on an id that no longer exists does nothing, and
      // doing nothing silently is indistinguishable from working.
      context.warnings.warn({
        code: 'OVERLAY_UNMATCHED_OPERATION',
        message: 'Overlay targets an operation that does not exist; it had no effect.',
        location: missing,
      });
    }

    context.logger.debug('Overlays applied', {
      overlayCount: documents.length,
      conflicts: conflicts.length,
    });

    return applied;
  },
};
