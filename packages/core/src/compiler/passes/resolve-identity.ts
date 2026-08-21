/**
 * Pass 2: Resolve identity & duplicates
 *
 * Assigns canonical operationId and resolves conflicts.
 * Conflict rule: same ID from two sources → deterministic winner by source precedence.
 */

import type { CompilerPass, CompiledOperation, CompilerContext, CompilerWarning } from '../types.js';
import { omitUndefined } from '../../utils.js';

/**
 * Source precedence order (highest to lowest)
 */
const SOURCE_PRECEDENCE: readonly string[] = [
  'code',       // Explicit code definitions (highest precedence)
  'overlay',    // MCP overlays
  'openapi',    // OpenAPI specs
  'framework',  // Framework adapters
  'inference',  // Inferred operations (lowest precedence)
];

function getSourcePrecedence(kind: string): number {
  const index = SOURCE_PRECEDENCE.indexOf(kind);
  return index === -1 ? SOURCE_PRECEDENCE.length : index;
}

export const resolveIdentity: CompilerPass = {
  name: 'resolve-identity',

  async run(
    operations: readonly CompiledOperation[],
    context: CompilerContext,
  ): Promise<readonly CompiledOperation[]> {
    context.logger.debug('Running resolve-identity pass', { count: operations.length });

    // Group by candidate ID
    const byId = new Map<string, CompiledOperation[]>();
    for (const op of operations) {
      const id = op.candidateId ?? op.name;
      if (!byId.has(id)) {
        byId.set(id, []);
      }
      byId.get(id)!.push(op);
    }

    const resolved: CompiledOperation[] = [];

    // For each ID group, pick the winner by source precedence
    for (const [id, ops] of byId) {
      if (ops.length === 1) {
        // No conflict
        const op = ops[0];
        if (!op) continue; // Should never happen, but satisfy TypeScript
        const { candidateId: _, ...rest } = op;
        resolved.push({
          ...rest,
          id,
        });
      } else {
        // Conflict - pick winner by source precedence (deterministic)
        const sorted = [...ops].sort((a, b) => {
          const aPrecedence = getSourcePrecedence(a.source?.kind ?? '');
          const bPrecedence = getSourcePrecedence(b.source?.kind ?? '');
          return aPrecedence - bPrecedence;
        });

        const winner = sorted[0];
        if (!winner) {
          // Should never happen since ops.length > 1, but satisfy TypeScript
          continue;
        }

        const losers = sorted.slice(1);

        // Warn about duplicates
        for (const loser of losers) {
          context.warnings.warn(omitUndefined<CompilerWarning>({
            code: 'DUPLICATE_OPERATION_ID',
            message: `Operation ID '${id}' defined by multiple sources`,
            location: loser.source?.location,
            details: {
              id,
              winnerSource: winner.source?.kind,
              loserSource: loser.source?.kind,
            },
          }));
        }

        const { candidateId: _, ...rest } = winner;
        resolved.push({
          ...rest,
          id,
        });
      }
    }

    return resolved;
  },
};
