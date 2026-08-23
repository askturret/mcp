// SPDX-License-Identifier: Apache-2.0
/**
 * Command dispatcher with fixed execution envelope
 *
 * ADR-010: 12-stage pipeline, sealed and immutable.
 * Every stage must be present; plugins can extend hooks but not reorder stages.
 *
 * Snapshot capture invariant: snapshot is captured ONCE at dispatch entry
 * and threaded through all stages. Never re-read the registry reference mid-flight.
 */

import type {
  OperationCommand,
  OperationResult,
  OperationError,
  OperationDefinition,
  Principal,
} from '../types.js';
import type { RegistryReference } from '../registry-reference.js';
import type {
  DispatchContext,
  DispatcherHooks,
  MCPResult,
  HookDecision,
} from './types.js';
import type { OperationExecutor } from '../executor/types.js';
import type { AuthorizationEngine } from '../policy/authorization.js';
import { omitUndefined } from '../utils.js';
import { createLogger } from '../logging/logger.js';
import type { StructuredLogger } from '../logging/types.js';
import { noopTracer } from '../telemetry/tracer.js';
import { noopMetricRecorder, emitPlaceholderSeries } from '../telemetry/metrics.js';
import {
  BulkheadRejection,
  createBulkheadRegistry,
  type BulkheadPermit,
  type BulkheadRegistry,
  type BulkheadsConfig,
} from '../bulkhead/index.js';
import {
  computeBackoffMs,
  decideRetry,
  defaultSleep,
  resolveRetryConfig,
  type RetryConfig,
} from '../retry/index.js';
import {
  METRIC,
  SPAN_ATTR,
  type MetricRecorder,
  type Observability,
  type Span,
  type SpanOutcome,
  type Tracer,
} from '../telemetry/types.js';

/**
 * MCP protocol version stamped onto every span (§9.1 `mcp.protocol.version`).
 *
 * A constant rather than a negotiated value because v0.2 speaks exactly one
 * version; when negotiation lands this becomes a per-session field, and the
 * attribute name will not have to change.
 */
const MCP_PROTOCOL_VERSION = '2025-06-18';

/** The single MCP method v0.2 instruments end-to-end. */
const MCP_METHOD = 'tools/call';

/**
 * Command dispatcher interface
 */
export interface CommandDispatcher {
  /**
   * Dispatch a command through the 12-stage execution envelope.
   *
   * @param command - Operation command to execute
   * @returns MCP wire result
   */
  dispatch(command: OperationCommand): Promise<MCPResult>;
}

/**
 * Create a command dispatcher
 *
 * @param registry - Registry reference (snapshot captured at dispatch entry)
 * @param hooks - Optional user-extensible hooks
 * @param executors - Optional executor registry (maps executor type to OperationExecutor instance)
 * @returns CommandDispatcher instance
 */
export function createDispatcher(
  registry: RegistryReference,
  hooks?: DispatcherHooks,
  executors?: Map<string, OperationExecutor>,
  options?: DispatcherOptions,
): CommandDispatcher {
  return new DefaultCommandDispatcher(registry, hooks, executors, options);
}

/**
 * Dispatcher options beyond the hook seams.
 *
 * A fourth positional parameter rather than a breaking signature change: every
 * existing caller keeps working, and an absent policy means the dispatcher
 * behaves exactly as it did before.
 */
export interface DispatcherOptions {
  /**
   * Call-time authorization policy — stage 3, the actual security boundary.
   *
   * When absent, stage 3 falls back to the `authorize` hook alone, which
   * defaults to allow-all. That is the pre-existing behaviour and remains the
   * default: turning on enforcement is an explicit act.
   */
  readonly authorization?: AuthorizationEngine;

  /**
   * Structured logger for stage-level operational logs (#38, §9.3).
   *
   * Absent means SILENT: importing core must never write to an adopter's
   * stdout uninvited, and every pre-#38 caller keeps its exact behaviour.
   *
   * These are operational logs, not audit records. Stage 11 remains the only
   * audit channel; nothing logged here carries a delivery guarantee.
   */
  readonly logger?: StructuredLogger;

  /**
   * Span tree and metrics (#39, §9.1 / §9.2).
   *
   * Absent means no-op tracer and no-op recorder — telemetry is opt-in per
   * § Delivery ("default: no exporter configured"). The dispatcher therefore
   * always has something to call and never needs a null-check on the request
   * path.
   */
  readonly observability?: Observability;

  /**
   * Bulkhead configuration (#43, §8.2, ADR-013).
   *
   * §43 shows this under a `runtime: { bulkheads: ... }` wrapper. No `runtime`
   * config object exists in this codebase — `DispatcherOptions` is the seam
   * stage 6 actually reads from — so it is accepted here instead, with the
   * same shape. Flagged for QA rather than a `runtime` key invented to match
   * the prose.
   *
   * Absent means DEFAULT_BULKHEADS, not "unbounded". A dispatcher with no
   * bulkhead limits is the failure mode §8.2 exists to prevent, and making
   * that the default for anyone who did not configure it would mean the
   * protection only protects people who already knew to ask.
   */
  readonly bulkheads?: BulkheadsConfig;

  /**
   * Retry policy (#45, §8.4, ADR-012).
   *
   * Absent means retries are DISABLED — not "enabled with defaults". Unlike
   * bulkheads, where the absent-means-protected default makes a dispatcher
   * safer, an absent retry policy that silently started replaying calls would
   * make every existing dispatcher send MORE traffic to someone's upstream
   * than it did yesterday. Turning that on is an explicit act.
   */
  readonly retry?: RetryConfig;
}

/**
 * The 12 stages of the sealed execution envelope (ADR-010), for log labelling.
 *
 * Named in one place so a stage cannot be logged under two different names in
 * two different branches - which is exactly how log-based dashboards rot.
 */
const STAGE_NAMES: Readonly<Record<number, string>> = {
  1: 'resolve-snapshot',
  2: 'authenticate',
  3: 'authorize',
  4: 'validate-input',
  5: 'verify-confirmation',
  6: 'acquire-bulkhead',
  7: 'apply-deadline',
  8: 'execute',
  9: 'validate-output',
  10: 'redact',
  11: 'audit',
  12: 'map-result',
};

/**
 * Default command dispatcher implementation
 */
class DefaultCommandDispatcher implements CommandDispatcher {
  private readonly authorization: AuthorizationEngine | undefined;
  private readonly logger: StructuredLogger;
  private readonly tracer: Tracer;
  private readonly metrics: MetricRecorder;
  private readonly bulkheads: BulkheadRegistry;
  private readonly retry: RetryConfig | undefined;

  /** In-flight count per tool, backing `mcp_tool_inflight` (§9.2). */
  private readonly inflight = new Map<string, number>();

  constructor(
    private readonly registry: RegistryReference,
    private readonly hooks: DispatcherHooks = {},
    private readonly executors: Map<string, OperationExecutor> = new Map(),
    options?: DispatcherOptions,
  ) {
    this.authorization = options?.authorization;
    this.retry = options?.retry;
    this.logger = options?.logger ?? createLogger();
    this.tracer = options?.observability?.tracer ?? noopTracer;
    this.metrics = options?.observability?.metrics ?? noopMetricRecorder;
    this.bulkheads = createBulkheadRegistry({
      ...(options?.bulkheads === undefined ? {} : { config: options.bulkheads }),
      metrics: this.metrics,
    });

    // The v0.2 placeholder series, emitted once at construction so the two
    // Epic-#3 metrics exist on a dashboard before their behaviour does.
    emitPlaceholderSeries(this.metrics);
  }

  /**
   * Emit the per-stage operational log.
   *
   * ## Level: DEBUG since #39 — a deliberate revision of #38's criterion
   *
   * #38 shipped these at INFO because its acceptance test said so, and I
   * flagged at the time that twelve info lines per request is debug-shaped
   * volume. QA agreed it was a reservation worth revisiting once a real span
   * tree existed.
   *
   * That span tree now exists, and it represents stage-by-stage progress
   * better than repeated log lines do: spans carry duration and parentage,
   * they are sampled, and they do not multiply a request into twelve
   * long-retention records. Keeping both would mean paying twice for the same
   * information — the specific duplication QA called out.
   *
   * So: SPANS carry progress, LOGS carry outcome. Stage detail drops to debug
   * (still there when an operator turns it up), and one INFO line per request
   * reports the result. Reversing this is a one-line change, and #38's test
   * has been updated in the same commit rather than left to fail silently.
   */
  private logStage(
    log: StructuredLogger,
    stage: number,
    extra?: Readonly<Record<string, string | number | boolean | null>>,
  ): void {
    log.debug('dispatch stage', {
      stage,
      stageName: STAGE_NAMES[stage] ?? 'unknown',
      ...(extra ?? {}),
    });
  }

  /**
   * Instrumentation wrapper around the sealed 12-stage envelope.
   *
   * Wrapping rather than threading spans through all eight return paths keeps
   * the diff reviewable AND derives the outcome from the RESULT the dispatcher
   * actually produced, instead of from whichever branch remembered to set it.
   * A branch that forgets to record its outcome is the likeliest way for
   * telemetry and reality to drift apart.
   */
  async dispatch(command: OperationCommand): Promise<MCPResult> {
    const tool = command.operationId;
    const requestSpan = this.tracer.startSpan('mcp.request', {
      attributes: {
        [SPAN_ATTR.method]: MCP_METHOD,
        [SPAN_ATTR.protocolVersion]: MCP_PROTOCOL_VERSION,
        ...(command.clientInfo?.name === undefined
          ? {}
          : { [SPAN_ATTR.clientName]: command.clientInfo.name }),
      },
    });
    const toolSpan = requestSpan.startChild('mcp.tool.call', {
      attributes: { [SPAN_ATTR.toolName]: tool },
    });

    const startedAt = Date.now();
    this.bumpInflight(tool, 1);

    let result: MCPResult;
    try {
      result = await this.dispatchInstrumented(command, toolSpan);
    } finally {
      this.bumpInflight(tool, -1);
    }

    const durationSeconds = (Date.now() - startedAt) / 1000;
    const outcome: SpanOutcome = result.isError ? 'error' : 'success';
    const errorCode = result.error?.code;

    toolSpan.setOutcome(outcome, errorCode);
    requestSpan.setOutcome(outcome, errorCode);
    toolSpan.end();
    requestSpan.end();

    this.metrics.add(METRIC.requestsTotal, 1, { method: MCP_METHOD, outcome });
    this.metrics.record(METRIC.requestDurationSeconds, durationSeconds, {
      method: MCP_METHOD,
      outcome,
    });
    this.metrics.add(METRIC.toolCallsTotal, 1, { tool, outcome });
    this.metrics.record(METRIC.toolDurationSeconds, durationSeconds, { tool, outcome });

    if (errorCode !== undefined) {
      this.metrics.add(METRIC.toolErrorsTotal, 1, { tool, error_code: errorCode });
    }

    if (!result.isError) {
      // Size of the SERIALIZED payload, never its content.
      this.metrics.record(METRIC.outputBytes, byteLength(result.content), { tool });
    }

    // The one INFO line per request: the outcome, which is what an operator
    // paging at 3am needs. Stage detail lives in spans and in debug.
    this.logger.info('dispatch complete', {
      requestId: command.requestId,
      operationId: tool,
      outcome,
      durationSeconds,
      ...(errorCode === undefined ? {} : { errorCode }),
    });

    return result;
  }

  private bumpInflight(tool: string, delta: number): void {
    const next = (this.inflight.get(tool) ?? 0) + delta;
    if (next <= 0) {
      this.inflight.delete(tool);
    } else {
      this.inflight.set(tool, next);
    }
    this.metrics.set(METRIC.toolInflight, Math.max(0, next), { tool });
  }

  private async dispatchInstrumented(
    command: OperationCommand,
    toolSpan: Span,
  ): Promise<MCPResult> {
    // Declared out here so the `finally` can release it on EVERY exit path —
    // success, mapped error, and the internal-error catch alike. A slot leaked
    // on an exception is worse than one never taken: the bulkhead's effective
    // concurrency drops permanently, and the symptom is unrelated calls
    // queueing for a group that looks idle.
    let permit: BulkheadPermit | undefined;

    try {
      // STAGE 1: Resolve snapshot and operation
      // CRITICAL: Capture snapshot ONCE at dispatch entry, never re-read
      const snapshot = this.registry.current();
      const operation = snapshot.operations.get(command.operationId);

      // Request-scoped bindings, so every subsequent line carries the
      // canonical field set (§ Output format) without each call site
      // repeating it. `traceId` is bound only when the caller supplied one -
      // absent means "unknown", which is not the same claim as null.
      const log = this.logger.child(
        omitUndefined({
          requestId: command.requestId,
          operationId: command.operationId,
          registryHash: snapshot.hash,
          traceId: command.traceId,
        }) as Readonly<Record<string, string>>,
      );

      if (!operation) {
        this.logStage(log, 1, { outcome: 'operation-not-found' });
        return this.mapError({
          code: 'INVALID_INPUT',
          message: `Operation '${command.operationId}' not found`,
        });
      }

      this.logStage(log, 1, { operationCount: snapshot.operations.size });

      // Short form (§9.1, Epic #1 #12): the full hash would be a high-
      // cardinality attribute, and the short one is what `mcp_registry_
      // operations` is already labelled with, so traces and metrics join.
      toolSpan.setAttribute(SPAN_ATTR.registryHash, snapshot.hash.slice(0, 12));
      toolSpan.setAttribute(SPAN_ATTR.executorType, operation.executor.type);

      // Build dispatch context (immutable for entire pipeline)
      //
      // clientInfo is carried across from the command. It used to be dropped
      // here, which made it unreachable to anything downstream — noted during
      // #33 and closed in #35, because call-time authorization needs it.
      const context: DispatchContext = omitUndefined({
        requestId: command.requestId,
        operationId: command.operationId,
        registryHash: snapshot.hash,
        principal: command.principal,
        clientInfo: command.clientInfo,
        confirmation: command.confirmation,
        idempotencyKey: command.idempotencyKey,
        deadline: command.deadline,
        signal: command.signal,
      });

      // STAGE 2: Authenticate
      const principal = await this.authenticate(context);
      const contextWithPrincipal: DispatchContext = omitUndefined({
        ...context,
        principal: principal ?? context.principal,
      });

      // Whether a principal was resolved, NEVER which one. The principal
      // identifier is on the §9.4 never-include list, and `principal` is a
      // compile-time forbidden field name, so this records presence only.
      this.logStage(log, 2, {
        authenticated: (principal ?? context.principal) !== undefined,
      });

      // STAGE 3: Authorize — the actual security boundary (§5.5).
      //
      // The policy engine runs BEFORE the user hook. A hook cannot be allowed
      // to pre-empt a policy denial: if it could, configuring a permissive
      // hook would silently disable the security boundary, which is the one
      // thing a hook must never be able to do.
      const policySpan = toolSpan.startChild('policy.evaluate');
      const policyOutcome = await this.authorizeByPolicy(
        contextWithPrincipal,
        operation,
        command,
      );
      if (policyOutcome !== null) {
        // `mcp.policy.decision` is span-only per §9.1 ("only on policy.evaluate
        // spans"); the metric carries the same decision under its own labels.
        policySpan.setAttribute(SPAN_ATTR.policyDecision, 'deny');
        policySpan.setOutcome('error', policyOutcome.ok ? undefined : policyOutcome.error.code);
        policySpan.end();
        this.metrics.add(METRIC.policyDecisionsTotal, 1, {
          phase: 'invocation',
          decision: 'deny',
        });
        this.logStage(log, 3, { outcome: 'policy-denied' });
        // Denials are audited. Stage 11 only ever ran on the success path, so
        // without this a refusal left no trace — the one event an audit log
        // most needs to contain.
        await this.audit(contextWithPrincipal, policyOutcome);
        this.logStage(log, 11, { outcome: 'policy-denied' });
        return this.mapResult(policyOutcome);
      }

      const authDecision = await this.authorize(contextWithPrincipal, command.input);
      if ('shortCircuit' in authDecision) {
        policySpan.setAttribute(SPAN_ATTR.policyDecision, 'deny');
        policySpan.setOutcome('error');
        policySpan.end();
        this.metrics.add(METRIC.policyDecisionsTotal, 1, {
          phase: 'invocation',
          decision: 'deny',
        });
        this.logStage(log, 3, { outcome: 'hook-short-circuit' });
        await this.audit(contextWithPrincipal, authDecision.result);
        this.logStage(log, 11, { outcome: 'hook-short-circuit' });
        return this.mapResult(authDecision.result);
      }

      policySpan.setAttribute(SPAN_ATTR.policyDecision, 'allow');
      policySpan.setOutcome('success');
      policySpan.end();
      this.metrics.add(METRIC.policyDecisionsTotal, 1, {
        phase: 'invocation',
        decision: 'allow',
      });
      this.logStage(log, 3, { outcome: 'allowed' });

      // STAGE 4: Validate input
      const inputSpan = toolSpan.startChild('schema.validate.input');
      const inputValidation = this.validateInput(command, operation);
      if (!inputValidation.ok) {
        // The validation ERROR CODE, never the offending input - raw input is
        // on the §9.4 never-include list.
        inputSpan.setOutcome('error', inputValidation.error.code);
        inputSpan.end();
        this.logStage(log, 4, { outcome: 'invalid-input' });
        return this.mapError(inputValidation.error);
      }

      inputSpan.setOutcome('success');
      inputSpan.end();
      this.logStage(log, 4, { outcome: 'valid' });

      // STAGE 5: Verify confirmation
      const confirmDecision = await this.verifyConfirmation(
        contextWithPrincipal,
        command.input,
      );
      if ('shortCircuit' in confirmDecision) {
        this.logStage(log, 5, { outcome: 'confirmation-required' });
        return this.mapResult(confirmDecision.result);
      }

      this.logStage(log, 5, { outcome: 'satisfied' });

      // STAGE 6: Acquire bulkhead permit (#43 — real since this issue).
      //
      // The span was already emitted while this was a no-op, per §9.1, so the
      // trace SHAPE is unchanged by bulkheads landing. Only its duration and
      // outcome become meaningful: `bulkhead.wait` is now where a saturated
      // group's queueing time actually shows up.
      const bulkheadName = this.bulkheads.assign(operation);
      const bulkheadSpan = toolSpan.startChild('bulkhead.wait', {
        attributes: { 'mcp.bulkhead': bulkheadName },
      });

      try {
        permit = await this.bulkheads.acquire(bulkheadName, command.signal);
      } catch (error) {
        // Overflow and cancellation are ordinary, EXPECTED outcomes here, not
        // internal faults — shedding load is the bulkhead working. Mapped to
        // their own codes rather than falling through to the catch below,
        // which would report INTERNAL_ERROR and make a healthy rejection look
        // like a bug in the server.
        const rejection =
          error instanceof BulkheadRejection
            ? error
            : new BulkheadRejection('QUEUE_FULL', bulkheadName, 'bulkhead acquisition failed');

        bulkheadSpan.setOutcome('error', rejection.code);
        bulkheadSpan.end();
        this.logStage(log, 6, { outcome: 'rejected', bulkhead: bulkheadName, code: rejection.code });

        return this.mapError({ code: rejection.code, message: rejection.message });
      }

      bulkheadSpan.setOutcome('success');
      bulkheadSpan.end();
      this.logStage(log, 6, { outcome: 'acquired', bulkhead: bulkheadName });

      // STAGE 7: Apply deadline + AbortSignal to executor
      // (Already present in command, passed to executor)
      //
      // Logged despite being a no-op stage: the envelope is sealed at 12
      // stages, and a gap in the sequence reads as a dropped stage rather
      // than as one that had nothing to do.
      this.logStage(log, 7, { deadline: command.deadline.toISOString() });

      // STAGE 8: Execute
      const executorType = operation.executor.type;
      const executorSpan = toolSpan.startChild('executor.invoke', {
        attributes: { [SPAN_ATTR.executorType]: executorType },
      });
      const executorStartedAt = Date.now();
      const executionResult = await this.executeWithRetry(
        operation,
        command.input,
        contextWithPrincipal,
        log,
      );
      // Covers every attempt, deliberately: this is what stage 8 cost, and a
      // measure that reported only the last attempt would show a retried call
      // as fast while the caller waited through all of them.
      const upstreamSeconds = (Date.now() - executorStartedAt) / 1000;

      // If execution failed, skip output validation and go straight to mapping
      if (!executionResult.ok) {
        executorSpan.setOutcome('error', executionResult.error.code);
        executorSpan.end();
        this.metrics.record(METRIC.upstreamDurationSeconds, upstreamSeconds, {
          executor_type: executorType,
          outcome: 'error',
        });
        this.logStage(log, 8, { outcome: 'execution-failed' });
        return this.mapResult(executionResult);
      }

      executorSpan.setOutcome('success');
      executorSpan.end();
      this.metrics.record(METRIC.upstreamDurationSeconds, upstreamSeconds, {
        executor_type: executorType,
        outcome: 'success',
      });
      this.logStage(log, 8, { outcome: 'executed' });

      // STAGE 9: Validate output
      const outputSpan = toolSpan.startChild('schema.validate.output');
      const outputValidation = this.validateOutput(executionResult.value, operation);
      if (!outputValidation.ok) {
        outputSpan.setOutcome('error', outputValidation.error.code);
        outputSpan.end();
        this.logStage(log, 9, { outcome: 'invalid-output' });
        return this.mapError(outputValidation.error);
      }

      outputSpan.setOutcome('success');
      outputSpan.end();
      this.logStage(log, 9, { outcome: 'valid' });

      // STAGE 10: Redact observable data
      const redacted = this.redact(executionResult.value);
      this.logStage(log, 10, { outcome: 'redacted' });

      // STAGE 11: Audit
      //
      // Span emitted in v0.2 even though the mandatory-delivery sink ships in
      // Epic #3 (#48), for the same reason as bulkhead.wait: the tree shape
      // must not change under existing queries when the behaviour lands.
      const finalResult: OperationResult = { ok: true, value: redacted };
      const auditSpan = toolSpan.startChild('audit.append');
      await this.audit(contextWithPrincipal, finalResult);
      auditSpan.setOutcome('success');
      auditSpan.end();
      this.logStage(log, 11, { outcome: 'audited' });

      // STAGE 12: Map to MCP result
      this.logStage(log, 12, { outcome: 'success' });
      return this.mapResult(finalResult);
    } catch (error) {
      // Catch any internal exception and map to INTERNAL_ERROR
      // NEVER leak original message, stack, or type name
      return this.mapError({
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred',
      });
    } finally {
      permit?.release();
    }
  }

  // ============================================================================
  // Stage implementations
  // ============================================================================

  private async authenticate(context: DispatchContext): Promise<Principal | undefined> {
    if (this.hooks.authenticate) {
      return this.hooks.authenticate(context);
    }
    // v0.1: default is unauthenticated
    return undefined;
  }

  /**
   * Stage 3, policy half.
   *
   * Returns `null` to continue, or the failing `OperationResult` to return.
   *
   * Note this runs before stage 4 (validate input), which is deliberate per
   * §5.6: a policy may refuse an operation without anyone spending cycles
   * validating an input schema against untrusted content. The input reaching
   * a policy here is the already-parsed JSON-RPC `params.arguments` — the
   * transport parses the body once, and nothing between that parse and this
   * point coerces it, so "safely decoded, no schema-driven coercion" holds by
   * construction rather than by a decode step here.
   */
  private async authorizeByPolicy(
    context: DispatchContext,
    operation: OperationDefinition,
    command: OperationCommand,
  ): Promise<OperationResult | null> {
    if (!this.authorization) return null;

    const outcome = await this.authorization.authorize({
      operation,
      registryHash: context.registryHash,
      input: command.input,
      ...(context.principal === undefined ? {} : { principal: context.principal }),
      ...(context.clientInfo === undefined ? {} : { clientInfo: context.clientInfo }),
      ...(context.confirmation === undefined ? {} : { confirmation: context.confirmation }),
    });

    if (outcome.kind === 'allow') return null;
    return { ok: false, error: outcome.error };
  }

  private async authorize(
    context: DispatchContext,
    input: unknown,
  ): Promise<HookDecision> {
    if (this.hooks.authorize) {
      return this.hooks.authorize(context, input);
    }
    // v0.1: default is allow all
    return { continue: true };
  }

  /**
   * Stage 4 — validate input, and enforce the idempotency-key requirement.
   *
   * The key check lives HERE, in stage 4, rather than beside the retry loop in
   * stage 8, because §8.4 requires that a missing key produce `INVALID_INPUT`
   * with "no attempt made". Checking it at execution time would mean the
   * upstream had already been called before we noticed the key was missing —
   * for a `idempotencyKeyRequired` operation, exactly the unreplayable call
   * the requirement exists to prevent.
   *
   * A whitespace-only key is treated as missing. It satisfies a presence check
   * while being useless to any upstream trying to deduplicate on it, and
   * accepting it would turn the guarantee into a formality.
   */
  private validateInput(
    command: OperationCommand,
    operation: OperationDefinition,
  ): OperationResult {
    // v0.1: basic type check (full JSON Schema validation deferred)
    if (command.input === null || command.input === undefined) {
      return {
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Input is required',
        },
      };
    }

    if (
      operation.effects.idempotencyKeyRequired &&
      (command.idempotencyKey === undefined || command.idempotencyKey.trim() === '')
    ) {
      return {
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          // Names the requirement, never echoes a supplied value.
          message: `Operation '${operation.id}' requires an idempotency key`,
        },
      };
    }

    return { ok: true, value: command.input };
  }

  private async verifyConfirmation(
    context: DispatchContext,
    input: unknown,
  ): Promise<HookDecision> {
    if (this.hooks.verifyConfirmation) {
      return this.hooks.verifyConfirmation(context, input);
    }
    // v0.1: no-op (pass-through)
    return { continue: true };
  }

  /**
   * Stage 8 with the §8.4 retry loop wrapped around it.
   *
   * ## Why this is inside stage 8 rather than a stage of its own
   *
   * ADR-010 seals the envelope at twelve stages. A retry is not a new step in
   * the pipeline — it is stage 8 being performed again — so the loop lives
   * here and the stage sequence is untouched. Every other stage still runs
   * exactly once per request: a retried call is NOT re-authorized, and it must
   * not be, because re-running authorization mid-flight would let a policy
   * change between attempts decide half a request.
   *
   * With no retry policy configured this is a single call, byte-for-byte the
   * behaviour that existed before #45.
   */
  private async executeWithRetry(
    operation: OperationDefinition,
    input: unknown,
    context: DispatchContext,
    log: StructuredLogger,
  ): Promise<OperationResult> {
    const config = this.retry;
    if (config === undefined) {
      return this.execute(operation, input, context);
    }

    const tool = operation.id;
    const resolved = resolveRetryConfig(config, operation.id);
    const random = config.random ?? Math.random;
    const sleep = config.sleep ?? defaultSleep;

    let attempt = 0;

    for (;;) {
      attempt += 1;
      const result = await this.execute(operation, input, context);

      // Retries only — the initial attempt is already counted by
      // `mcp_tool_calls_total`, and counting it twice would put a floor of 1
      // under every tool's retry rate.
      if (attempt > 1) {
        this.metrics.add(METRIC.retryAttemptsTotal, 1, {
          tool,
          outcome: result.ok ? 'success' : 'error',
        });
      }

      if (result.ok) return result;

      const decision = decideRetry({
        errorCode: result.error.code,
        effects: operation.effects,
        attempt,
        maxAttempts: resolved.maxAttempts,
      });

      if (!decision.retry) {
        this.recordRetryOutcome(tool, attempt, decision.reason, result.error.code, log);
        return result;
      }

      // §8.4: "Total time budget capped by the operation's absolute deadline —
      // retries never extend the deadline." Checked BEFORE sleeping: a backoff
      // that would itself outlast the deadline buys nothing but latency, since
      // the attempt after it could only return TIMEOUT.
      const backoffMs = computeBackoffMs(attempt, resolved, random);
      if (backoffMs >= context.deadline.getTime() - Date.now()) {
        this.recordRetryOutcome(tool, attempt, 'deadline-budget', result.error.code, log);
        return result;
      }

      await sleep(backoffMs, context.signal);

      // A client that hung up during the backoff must not be charged for
      // another upstream call on its behalf.
      if (context.signal.aborted) {
        return {
          ok: false,
          error: { code: 'CANCELLED', message: 'Request cancelled' },
        };
      }
    }
  }

  /**
   * Record why retrying stopped.
   *
   * `mcp_retry_exhausted_total` fires only when at least one retry actually
   * happened. A call that was never eligible did not run out of budget — it
   * never had one — and counting it here would make the metric a synonym for
   * `mcp_tool_errors_total`, which is precisely the confusion it exists to
   * resolve.
   */
  private recordRetryOutcome(
    tool: string,
    attempt: number,
    reason: string,
    terminalError: string,
    log: StructuredLogger,
  ): void {
    const exhausted = reason === 'attempts-exhausted' || reason === 'deadline-budget';

    if (exhausted && attempt > 1) {
      this.metrics.add(METRIC.retryExhaustedTotal, 1, {
        tool,
        terminal_error: terminalError,
      });
    }

    log.debug('retry stopped', { attempt, reason, errorCode: terminalError });
  }

  private async execute(
    operation: OperationDefinition,
    input: unknown,
    context: DispatchContext,
  ): Promise<OperationResult> {
    // Resolve executor from operation binding
    const executorType = operation.executor.type;
    const executor = this.executors.get(executorType);

    if (!executor) {
      // No executor registered for this type - return error
      return {
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: `No executor registered for type '${executorType}'`,
        },
      };
    }

    // Delegate to the actual executor (viaHandler, viaHttp, etc.)
    try {
      return await executor.execute(operation, input, context);
    } catch (error) {
      // Catch any unhandled executor exceptions and map to INTERNAL_ERROR
      // Executors should return OperationResult, not throw, but this is a safety net
      return {
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Execution failed',
        },
      };
    }
  }

  private validateOutput(
    output: unknown,
    _operation: OperationDefinition,
  ): OperationResult {
    // v0.1: basic type check (full JSON Schema validation deferred)
    if (output === null || output === undefined) {
      return {
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Executor returned null or undefined',
        },
      };
    }
    return { ok: true, value: output };
  }

  private redact<T>(value: T): T {
    if (this.hooks.redact) {
      return this.hooks.redact(value);
    }
    // v0.1: pass-through (no redaction)
    return value;
  }

  private async audit(
    context: DispatchContext,
    result: OperationResult,
  ): Promise<void> {
    if (this.hooks.audit) {
      await this.hooks.audit(context, result);
    }
    // v0.1: no-op sink
  }

  // ============================================================================
  // Error mapping
  // ============================================================================

  private mapResult(result: OperationResult): MCPResult {
    if (result.ok) {
      return {
        isError: false,
        content: result.value,
      };
    }
    return this.mapError(result.error);
  }

  private mapError(error: OperationError): MCPResult {
    return {
      isError: true,
      error: omitUndefined({
        code: error.code,
        message: error.message,
        details: error.details,
        retryAfter: error.retryAfter,
      }),
    };
  }
}

/**
 * Serialized size of a result payload, for `mcp_output_bytes` (§9.2).
 *
 * Measures the CONTENT only, never inspects or emits it. A payload that
 * cannot be serialized records 0 rather than throwing: a metrics call must
 * not be able to fail a request that already succeeded.
 */
function byteLength(content: unknown): number {
  if (content === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(content) ?? '', 'utf8');
  } catch {
    return 0;
  }
}

// Re-export types
export type { DispatcherHooks, DispatchContext, MCPResult } from './types.js';
