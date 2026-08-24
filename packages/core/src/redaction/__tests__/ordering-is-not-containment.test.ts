// SPDX-License-Identifier: Apache-2.0
/**
 * Ordering is a tie-break, not containment (#171).
 *
 * ## What this file is for
 *
 * `RedactionPipeline.add` and `createRedactionPipeline`'s `add` both used to
 * promise that "a user rule cannot accidentally un-redact something the
 * defaults already catch, because first match wins and the built-in matched
 * first". The first half is true, the conclusion does not follow, and the whole
 * sentence read as a security property an adopter could rely on.
 *
 * Ordering only decides a tie, and a tie requires that a built-in match THE
 * SAME NODE. No built-in matches a plain-object container. `walk` tests every
 * node — containers included — and returns `transform(value)` on a match
 * without descending, so a user rule that claims a container wins by default
 * and the built-ins never reach the leaves inside it.
 *
 * The comments are corrected. Prose drifts back, so this file pins BOTH halves
 * as executable statements:
 *
 *   - what ordering genuinely buys (a built-in wins a tie on a shared node);
 *   - what it does not (a container claim short-circuits the walk);
 *   - and the boundary that DOES contain it, for plugin rules only.
 *
 * ## What this file deliberately does not argue
 *
 * That the adopter-facing behaviour is a bug. It is not, and #171 is explicit:
 * an adopter's rule runs in the adopter's own process, where replacing a whole
 * subtree is a legitimate thing to want. `constrainPluginRedactionRule` is
 * applied at the PLUGIN boundary because that is where the trust boundary is.
 * The defect was the promise, not the behaviour — so the leak below is asserted
 * as CORRECT, documented behaviour rather than as a failure.
 */

import { describe, it, expect } from '@jest/globals';

import { createRedactionPipeline } from '../pipeline.js';
import { BUILTIN_RULES } from '../rules.js';
import { constrainPluginRedactionRule } from '../../plugin/host.js';
import type { RedactionContext, RedactionRule } from '../types.js';

const SECRET = 'sk_live_super_secret_value';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';

const CONTEXT: RedactionContext = { surface: 'log', path: [] };

/** The payload from #171: a secret at the root, one nested, one inside an array. */
const payload = (): Record<string, unknown> => ({
  apiKey: SECRET,
  nested: { password: SECRET, token: JWT },
  list: [{ secret: SECRET }],
});

/** Which sensitive literals survived, by inspection of the whole output. */
function leaked(output: unknown): string[] {
  const serialized = JSON.stringify(output) ?? '';
  return [
    ...(serialized.includes(SECRET) ? ['SECRET'] : []),
    ...(serialized.includes(JWT) ? ['JWT'] : []),
  ];
}

/** A pass-through rule: matches per `matches`, and hands the value back intact. */
const passThrough = (id: string, matches: RedactionRule['matches']): RedactionRule => ({
  id,
  matches,
  transform: (value) => value,
});

const CLAIMS_ROOT = (): RedactionRule => passThrough('claims-root', () => true);
const CLAIMS_ANY_NESTED = (): RedactionRule =>
  passThrough('claims-nested', (context) => context.path.length > 0);
const CLAIMS_ARRAYS = (): RedactionRule =>
  passThrough('claims-arrays', (_context, value) => Array.isArray(value));

describe('ordering is a tie-break, not containment (#171)', () => {
  it('redacts every secret in the payload with the built-ins alone', () => {
    // The control, and it is load-bearing. Every "leaks" assertion below is
    // only meaningful if the built-ins would otherwise have caught these
    // values — otherwise the leak could be the payload's fault, not the
    // container claim's.
    const pipeline = createRedactionPipeline();

    expect(leaked(pipeline.redact(payload(), CONTEXT))).toEqual([]);
  });

  describe('what ordering does NOT buy', () => {
    it.each([
      ['a rule claiming the root', CLAIMS_ROOT, ['SECRET', 'JWT']],
      ['a rule claiming any nested node', CLAIMS_ANY_NESTED, ['SECRET', 'JWT']],
      ['a rule claiming arrays', CLAIMS_ARRAYS, ['SECRET']],
    ])('%s un-redacts what the built-ins would have caught', (_label, makeRule, expectedLeaks) => {
      const pipeline = createRedactionPipeline();
      pipeline.add(makeRule());

      // Asserted as the DOCUMENTED behaviour, not as a bug. If this ever stops
      // leaking, the comments on `add` are wrong again in the other direction
      // and this test should be revisited rather than deleted.
      expect(leaked(pipeline.redact(payload(), CONTEXT))).toEqual(expectedLeaks);
    });

    it('leaks even though every built-in is still installed and still ahead', () => {
      // Rules out the obvious alternative explanation: that the user rule
      // somehow removed or displaced the built-ins. It did neither. The
      // built-ins are present, and ordered first, and still lose — because they
      // are never consulted for a node they do not match.
      const pipeline = createRedactionPipeline();
      pipeline.add(CLAIMS_ROOT());

      const ids = pipeline.rules().map((rule) => rule.id);

      expect(ids.slice(0, BUILTIN_RULES.length)).toEqual(BUILTIN_RULES.map((rule) => rule.id));
      expect(ids.at(-1)).toBe('claims-root');
      expect(leaked(pipeline.redact(payload(), CONTEXT))).toEqual(['SECRET', 'JWT']);
    });
  });

  describe('what ordering DOES buy', () => {
    it('lets a built-in win a tie on a node the user rule also matches', () => {
      // The true half of the original sentence, kept honest. Here the user rule
      // matches a LEAF that `key-name` also matches, so there is a real tie —
      // and the built-in, being ahead, takes it.
      const pipeline = createRedactionPipeline();
      pipeline.add({
        id: 'would-expose-apikey',
        matches: (context) => context.path.at(-1) === 'apiKey',
        transform: () => `USER_RULE_WON:${SECRET}`,
      });

      const output = pipeline.redact(payload(), CONTEXT) as Record<string, unknown>;

      expect(String(output['apiKey'])).not.toContain('USER_RULE_WON');
      expect(leaked(output)).toEqual([]);
    });
  });

  describe('the boundary that does contain it', () => {
    it('declines the container claim when the SAME rule is plugin-constrained', () => {
      // Same rule object, same pipeline, same payload — only the plugin wrapper
      // differs. That isolation is the point: it shows containment comes from
      // constrainPluginRedactionRule and not from ordering, which is exactly
      // the distinction the corrected comments now draw.
      const pipeline = createRedactionPipeline();
      pipeline.add(constrainPluginRedactionRule(CLAIMS_ROOT()));

      expect(leaked(pipeline.redact(payload(), CONTEXT))).toEqual([]);
    });

    it('still lets a plugin rule redact the individual leaves', () => {
      // The constraint costs a plugin the ability to claim a subtree, not the
      // ability to redact. Without this, "declines containers" could be
      // satisfied by a wrapper that declined everything.
      const pipeline = createRedactionPipeline({ rules: [] });
      pipeline.add(
        constrainPluginRedactionRule({
          id: 'plugin-leaf',
          matches: (_context, value) => value === SECRET,
          transform: () => '[PLUGIN]',
        }),
      );

      const output = pipeline.redact(payload(), CONTEXT) as Record<string, unknown>;

      expect(output['apiKey']).toBe('[PLUGIN]');
      expect((output['nested'] as Record<string, unknown>)['password']).toBe('[PLUGIN]');
      // The JWT is untouched: no built-ins here, and this rule only claims SECRET.
      expect((output['nested'] as Record<string, unknown>)['token']).toBe(JWT);
    });
  });
});
