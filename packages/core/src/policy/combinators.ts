// SPDX-License-Identifier: Apache-2.0
/**
 * Boolean composition for policies: `allOf`, `anyOf`, `not`.
 *
 * The decision lattice is three-valued (`allow` / `deny` / `confirmation_required`),
 * so it is NOT Boolean algebra and does not obey all the laws one would expect
 * from `&&`, `||` and `!`. Where an intuition breaks, the safety rule wins and
 * the break is documented — both here and in a test that pins the real
 * behaviour. See `not()` for the one that bites.
 */

import type {
  ConfirmationChallenge,
  Policy,
  PolicyContext,
  PolicyDecision,
  PolicyEvidence,
} from './types.js';

// ---------------------------------------------------------------------------
// Decision constructors
// ---------------------------------------------------------------------------

const allow = (evidence: readonly PolicyEvidence[]): PolicyDecision => ({
  effect: 'allow',
  evidence,
});

const deny = (
  code: string,
  safeReason: string,
  evidence: readonly PolicyEvidence[],
): PolicyDecision => ({ effect: 'deny', code, safeReason, evidence });

const confirmationRequired = (
  challenge: ConfirmationChallenge,
  evidence: readonly PolicyEvidence[],
): PolicyDecision => ({ effect: 'confirmation_required', challenge, evidence });

/**
 * Is this a decision shape we recognise?
 *
 * A policy is ordinary user code. It can return `undefined`, a typo'd effect,
 * or a value from an older version of this interface. Treating an unrecognised
 * shape as anything but a denial would mean an unparseable answer grants
 * access — the "I could not determine" → "it passed" conflation that this
 * codebase treats as its most expensive defect class.
 */
function isRecognisedDecision(value: unknown): value is PolicyDecision {
  if (typeof value !== 'object' || value === null) return false;

  // `evidence` is carried by EVERY effect, so it is checked before the
  // effect-specific payload rather than three times after it.
  //
  // This line is load-bearing far out of proportion to its size. Without it,
  // `{ effect: 'allow' }` was judged recognised and then threw
  // "evidence is not iterable" when a combinator spread it. Nested, the
  // parent's own evaluateSafely caught that and denied; at the ROOT of a tree
  // there is no parent, so the TypeError escaped to the caller — a policy
  // engine whose entire job is to contain untrusted policy code, failing open
  // by one layer. Found in QA on PR #117.
  if (!Array.isArray((value as { evidence?: unknown }).evidence)) return false;
  if (!(value as { evidence: readonly unknown[] }).evidence.every(isRecognisedEvidence)) {
    return false;
  }

  const effect = (value as { effect?: unknown }).effect;
  if (effect === 'allow') return true;
  if (effect === 'deny') {
    const d = value as { code?: unknown; safeReason?: unknown };
    return typeof d.code === 'string' && typeof d.safeReason === 'string';
  }
  if (effect === 'confirmation_required') {
    return (value as { challenge?: unknown }).challenge != null;
  }
  return false;
}

/**
 * Is this a usable evidence entry?
 *
 * The array being an array is not enough. `evidence: [null]` spreads happily
 * and only fails later, in Explorer or the audit sink — relocating the crash
 * out of the module that can still deny, into one that can only log. The same
 * argument that requires the `Array.isArray` check above applies one level
 * down, so it is applied there too.
 */
function isRecognisedEvidence(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as { policyId?: unknown; claim?: unknown; detail?: unknown };
  if (typeof e.policyId !== 'string' || typeof e.claim !== 'string') return false;
  return e.detail === undefined || typeof e.detail === 'string';
}

/** Evidence carrying no data of its own — safe by construction. */
const note = (policyId: string, claim: string, detail?: string): PolicyEvidence =>
  detail === undefined ? { policyId, claim } : { policyId, claim, detail };

/**
 * Evaluate a child policy without letting it break the tree.
 *
 * Fails CLOSED on both a thrown error and an unrecognised return value. A
 * policy that crashes has not allowed anything, and a combinator that
 * propagates the throw would take down the dispatcher instead of denying one
 * call.
 *
 * The thrown error's message is deliberately DISCARDED rather than copied into
 * `safeReason`. Error messages routinely embed the very things evidence may
 * never carry — request payloads, tokens, record identifiers — and
 * `catch (e) { safeReason: e.message }` is the most natural way to leak them
 * into a field whose name promises the opposite.
 */
async function evaluateSafely(policy: Policy, context: PolicyContext): Promise<Evaluated> {
  const policyId = typeof policy?.id === 'string' ? policy.id : '<unknown>';
  try {
    const decision = await policy.evaluate(context);
    if (!isRecognisedDecision(decision)) {
      return {
        failed: true,
        decision: deny(
          'policy_returned_invalid_decision',
          'A policy returned a value that is not a recognised decision.',
          [note(policyId, 'policy returned an unrecognised decision shape', 'denied by safety default')],
        ),
      };
    }
    return { failed: false, decision };
  } catch {
    return {
      failed: true,
      decision: deny('policy_threw', 'A policy failed to evaluate.', [
        note(
          policyId,
          'policy threw during evaluation',
          'denied by safety default; error detail withheld because it may embed request data',
        ),
      ]),
    };
  }
}

/**
 * A child's decision, plus whether it is a real answer or a substituted denial.
 *
 * The distinction only matters to `not()`, and it matters a great deal there:
 * a substituted denial must never be inverted into an allowance. See `not()`.
 */
interface Evaluated {
  readonly decision: PolicyDecision;
  readonly failed: boolean;
}

const evaluateAll = (
  policies: readonly Policy[],
  context: PolicyContext,
): Promise<PolicyDecision[]> =>
  Promise.all(policies.map((p) => evaluateSafely(p, context).then((e) => e.decision)));

/**
 * Children are ALWAYS all evaluated — no short-circuit.
 *
 * Short-circuiting on the first deny would be cheaper, but §5.5 requires policy
 * explanations be inspectable, and Explorer and the audit trail render the
 * evidence list. A tree that stops early produces an explanation that silently
 * omits every branch after the first failure, which is the explanation an
 * operator most needs when asking "why was this denied?".
 */
const gatherEvidence = (decisions: readonly PolicyDecision[]): PolicyEvidence[] =>
  decisions.flatMap((d) => [...d.evidence]);

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

/**
 * Conjunction. Every child must allow.
 *
 * - any `deny` → `deny` (the first in declaration order, for determinism)
 * - else any `confirmation_required` → `confirmation_required` (the first)
 * - else → `allow`
 *
 * **`allOf([])` allows.** That is the identity element for conjunction, and it
 * is what keeps `allOf([...a, ...b])` equivalent to
 * `allOf([allOf(a), allOf(b)])`. It is also a footgun when the array is built
 * dynamically and comes out empty — an empty policy list is not a security
 * posture. Callers building policy lists at runtime should assert non-empty
 * themselves; this function will not guess that an empty list meant "deny".
 */
export function allOf(policies: readonly Policy[], options?: { readonly id?: string }): Policy {
  const id = options?.id ?? `allOf(${policies.map((p) => p?.id ?? '<unknown>').join(', ')})`;

  return {
    id,
    async evaluate(context: PolicyContext): Promise<PolicyDecision> {
      const decisions = await evaluateAll(policies, context);
      const evidence = gatherEvidence(decisions);

      const denied = decisions.find((d) => d.effect === 'deny');
      if (denied && denied.effect === 'deny') {
        return deny(denied.code, denied.safeReason, [
          ...evidence,
          note(id, 'at least one policy denied', 'deny takes precedence over allow and confirmation_required'),
        ]);
      }

      const confirming = decisions.find((d) => d.effect === 'confirmation_required');
      if (confirming && confirming.effect === 'confirmation_required') {
        return confirmationRequired(confirming.challenge, [
          ...evidence,
          note(id, 'at least one policy requires confirmation', 'confirmation_required takes precedence over allow'),
        ]);
      }

      return allow([
        ...evidence,
        note(
          id,
          policies.length === 0 ? 'no policies to satisfy' : 'every policy allowed',
          policies.length === 0 ? 'an empty allOf allows by definition' : undefined,
        ),
      ]);
    },
  };
}

/**
 * Disjunction. At least one child must allow.
 *
 * - any `allow` → `allow`
 * - else all `deny` → `deny`
 * - else → `confirmation_required`
 *
 * **A single `deny` does NOT veto here**, unlike everywhere else in this
 * module. That looks like it contradicts the safety-first rule, and it is worth
 * being explicit about why it does not: `anyOf` exists to express "any one of
 * these routes is acceptable". If one denial vetoed the whole disjunction,
 * `anyOf` would behave identically to `allOf` and there would be no way to
 * write an alternative at all. The safety-first rule governs how decisions
 * combine WITHIN a conjunction; it is not a claim that deny wins everywhere.
 *
 * **`anyOf([])` denies** — an empty disjunction has nothing that could allow.
 * Note this is deliberately NOT symmetric with `allOf([])`, because the
 * identity element of a disjunction is the bottom value, not the top one.
 */
export function anyOf(policies: readonly Policy[], options?: { readonly id?: string }): Policy {
  const id = options?.id ?? `anyOf(${policies.map((p) => p?.id ?? '<unknown>').join(', ')})`;

  return {
    id,
    async evaluate(context: PolicyContext): Promise<PolicyDecision> {
      if (policies.length === 0) {
        return deny('anyOf_empty', 'No policy was offered that could allow this operation.', [
          note(id, 'no policies to satisfy', 'an empty anyOf denies by definition'),
        ]);
      }

      const decisions = await evaluateAll(policies, context);
      const evidence = gatherEvidence(decisions);

      if (decisions.some((d) => d.effect === 'allow')) {
        return allow([...evidence, note(id, 'at least one policy allowed')]);
      }

      if (decisions.every((d) => d.effect === 'deny')) {
        // When every branch denied for the SAME reason, report that reason
        // rather than an aggregate. `anyOf([p, p])` should say what `p` said —
        // both because it is more useful ("only read-only operations are
        // permitted here" beats "every alternative denied"), and because
        // rewriting it would mean duplicating a policy silently changes the
        // answer callers see.
        // Keyed on code AND safeReason, not code alone. Two denials sharing a
        // code but differing in reason are not the same denial, and reporting
        // one of them would silently drop the other — while the evidence note
        // said "every policy denied", which a reader would take to mean they
        // denied identically.
        const reasons = new Set(
          decisions.map((d) => (d.effect === 'deny' ? JSON.stringify([d.code, d.safeReason]) : '')),
        );
        const first = decisions[0];

        if (reasons.size === 1 && first !== undefined && first.effect === 'deny') {
          return deny(first.code, first.safeReason, [
            ...evidence,
            note(id, 'every policy denied', 'identically, so their shared reason is reported'),
          ]);
        }

        return deny('anyOf_all_denied', 'Every alternative policy denied this operation.', [
          ...evidence,
          note(id, 'every policy denied', 'for differing reasons'),
        ]);
      }

      const confirming = decisions.find((d) => d.effect === 'confirmation_required');
      // Reachable only when at least one child confirms: no child allowed, and
      // not every child denied, so some child must be confirmation_required.
      /* istanbul ignore else -- unreachable by the case analysis above */
      if (confirming && confirming.effect === 'confirmation_required') {
        return confirmationRequired(confirming.challenge, [
          ...evidence,
          note(id, 'no policy allowed outright, but confirmation could satisfy one'),
        ]);
      }

      /* istanbul ignore next -- defensive: see comment above */
      return deny('anyOf_indeterminate', 'No alternative policy could be satisfied.', [
        ...evidence,
        note(id, 'no policy could be satisfied', 'denied by safety default'),
      ]);
    },
  };
}

/**
 * Negation.
 *
 * - `not(deny)` → `allow`
 * - `not(allow)` → `deny`
 * - `not(confirmation_required)` → **`deny`** (safety default)
 *
 * ## Double negation is NOT an involution, and it escalates
 *
 * `not(not(P))` returns `P`'s effect for `allow` and `deny`, but NOT for
 * `confirmation_required`:
 *
 * ```
 * not(not(confirmation_required)) = not(deny) = allow
 * ```
 *
 * So wrapping a policy in two negations can turn "a human must confirm this"
 * into "go ahead" — a privilege escalation, not merely a surprise. It follows
 * unavoidably from the two rules above, each of which is individually correct:
 * collapsing `confirmation_required` to `deny` is the safe choice, and
 * `not(deny) = allow` is the whole point of negation. Three-valued logic has no
 * total involution that also preserves the safety collapse.
 *
 * **Practical guidance: do not apply `not()` to a policy that can return
 * `confirmation_required`.** `not(confirmationForEffects([...]))` in particular
 * does not mean "operations without these effects" — it denies everything the
 * inner policy would have flagged AND allows nothing extra. Express the
 * complement directly instead of negating.
 *
 * This is pinned by a test asserting the escalation exists, rather than being
 * left as a comment nobody re-derives.
 */
export function not(policy: Policy, options?: { readonly id?: string }): Policy {
  const id = options?.id ?? `not(${policy?.id ?? '<unknown>'})`;

  return {
    id,
    async evaluate(context: PolicyContext): Promise<PolicyDecision> {
      const { decision: inner, failed } = await evaluateSafely(policy, context);
      const evidence = [...inner.evidence];

      // A policy that crashed did not deny — it failed to answer, and the
      // denial standing in for it is this module's own safety substitution.
      // Inverting THAT would turn a crashing policy into an open door, which
      // is the opposite of failing closed: the buggier the inner policy, the
      // more access it grants. Propagate the failure instead.
      if (failed) {
        return deny('negated_policy_failed', 'The negated policy failed to evaluate.', [
          ...evidence,
          note(
            id,
            'negated policy failed to evaluate, so this denies',
            'a failure is not a denial and is never inverted into an allowance',
          ),
        ]);
      }

      switch (inner.effect) {
        case 'deny':
          return allow([...evidence, note(id, 'negated policy denied, so this allows')]);

        case 'allow':
          return deny('negated_allow', 'The negated policy allowed this operation.', [
            ...evidence,
            note(id, 'negated policy allowed, so this denies'),
          ]);

        case 'confirmation_required':
          return deny(
            'negated_confirmation_required',
            'The negated policy required confirmation, which negation resolves to a denial.',
            [
              ...evidence,
              note(
                id,
                'negated policy required confirmation, so this denies',
                'safety default: negation of a confirmation requirement is a denial, not an allowance',
              ),
            ],
          );
      }
    },
  };
}
