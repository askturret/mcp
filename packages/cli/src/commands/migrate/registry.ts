// SPDX-License-Identifier: Apache-2.0
/**
 * The migration registry (#62).
 *
 * Every migration this build knows about, as data. The engine has no
 * per-version branches — adding a migration is adding an entry here.
 *
 * ## What is NOT in here, and why that is the honest answer
 *
 * §62's acceptance asks for "at least one migration pair (0.x → 1.0) committed
 * as the reference". **There is no published 0.x → 1.0 migration below, because
 * there is nothing to migrate.**
 *
 * Checked rather than assumed: this project is at `0.1.0`, there is no 1.0
 * release, and `git log` contains no adopter-facing rename or removal — the
 * only rename commit in the history renames an unused parameter inside
 * `via-handler`.
 *
 * ## Nothing has been published — but NOT for the reason this used to give
 *
 * This paragraph used to argue from the privacy flag: that every workspace
 * carried it, and therefore nobody could have installed a version to migrate
 * from. **The conclusion is still true. The premise is false and had decayed
 * silently** (#433): most workspaces are publishable today.
 *
 * The old sentence is paraphrased rather than quoted, deliberately. The test in
 * `migrate.test.ts` matches on its literal text, so reproducing it here to
 * explain it would trip the very check that keeps it from returning — the same
 * shape as describing a closing keyword by spelling it beside its number.
 *
 * That distinction is the whole point, because `private: true` was the
 * MECHANISM that made the conclusion safe, and it is gone. What holds now is
 * weaker and easier to lose:
 *
 *   the only publish path is `npm publish --workspaces --provenance
 *   --access public` in `supply-chain.yml`, gated on
 *   `if: github.event_name == 'release'` — and this repository has never cut
 *   a release.
 *
 * So the protection is procedural, not structural: it is "no release has been
 * published", and it is no longer a property of the packages.
 *
 * **ONE PUBLISHED GITHUB RELEASE ENDS IT — not a tag push.** An earlier version
 * of this paragraph said a `git tag` push would, and that is wrong:
 * `supply-chain.yml` triggers on `pull_request`, `push:[main]`,
 * `release:[published]` and `workflow_dispatch`. There is no tag trigger, so a
 * pushed tag is inert here. Overstating the trigger of the thing that ends the
 * protection is the same category of error this docstring is repairing, which
 * is why it is corrected rather than quietly adjusted.
 *
 * ## And it ends for ALL NINE AT ONCE
 *
 * The step is `npm publish --workspaces`, so the first release ever cut
 * publishes every publishable package simultaneously, with provenance, as a
 * public debut. There is no incremental first package and no chance to watch
 * one land before the rest follow. From that moment the compatibility policy
 * binds for all nine together — which is the reason any of this matters, and
 * why "nothing is published" is a statement with an expiry rather than a
 * standing fact.
 *
 * ## WHICH CLAIM IS BEING MADE, precisely
 *
 * **Supported: nothing has been published BY THIS REPOSITORY.** That rests on
 * the publish path above plus zero releases, and it is what the evidence
 * establishes.
 *
 * The stronger reading — *nothing exists under these names anywhere* — is
 * probable but not proven by the same evidence. Every publishable name returns
 * 404 unauthenticated, and a negative control confirms the probe discriminates,
 * but a package published MANUALLY with `--access restricted`, outside this
 * repository's path, would also 404. That residual is stated rather than
 * blurred, because collapsing the two is how the sentence above went wrong in
 * the first place.
 *
 * ## Re-derive it; do not trust this paragraph
 *
 * Deliberately no counts here — a hardcoded number is exactly what drifted, and
 * repeating the mistake in the correction would be absurd. Three commands, none
 * of which can go stale:
 *
 *   which packages could be published
 *     node -e "…read every workspace package.json, report .private…"
 *   whether any actually is        npm view @askturret/<name> version
 *   whether a release ever ran     git tag -l   /   gh release list
 *
 * `migrate.test.ts` re-derives the first from disk on every run and fails if
 * this file claims universal privacy again, so the specific false sentence
 * cannot come back unnoticed.
 *
 * ## This paragraph licenses nothing
 *
 * Stated because that is what it was used for. "No adopter has installed a
 * version to migrate from" is a tempting justification for treating a
 * compatibility break as free, and it nearly settled #432's `--json` shape
 * question that way. Whether a break is acceptable is a decision about the
 * change, and the answer must hold regardless of how many adopters there
 * currently are. This says what is true; it does not make anything free.
 *
 * A `0.x → 1.0` entry written today would therefore be either a no-op or an
 * invention. #59 — merged hours ago — exists to make compatibility claims
 * checkable against real cases, and opening its companion tool with a fabricated
 * one would be a poor start.
 *
 * So the reference migration below is `prospective`: real content, derived from
 * a decision that has actually been made, for a change that has not shipped.
 * See `MigrationStatus` for why that is a field rather than a caveat in prose.
 */

import type { Migration } from './types.js';

/**
 * The reference migration.
 *
 * ## Why this one
 *
 * #52 built the Regulated preset and recorded a deviation: §10.2 describes the
 * audit requirement as `sink: { durable: 'required' }`, and the implementation
 * carries it as a sibling `durability` field on `PresetAuditConfig`. #59 then
 * classified reshaping it — **MAJOR after 1.0, free before** — because
 * `PresetConfiguration` is a core public type that is *returned* to adopters,
 * and moving a field is removal plus addition however it is described.
 *
 * That made it the FIRST breaking change in this project whose shape, direction
 * and version impact were all already decided by something other than this
 * file. The migration is derived from those decisions rather than invented to
 * fill a slot, which is the whole difference between a reference and a
 * placeholder.
 *
 * ## Why the `migrate --json` rule is in THIS entry (#432)
 *
 * A second rule was added when `migrate --json` moved advisory entries out of
 * `findings[]` into a new `advisories[]`. That is a shape change in
 * machine-readable output that a consumer parses — an `output` rule by this
 * registry's own definition — so recording it here is the same discipline
 * `migrate` asks of everyone else, applied to `migrate`.
 *
 * It belongs in this entry rather than a new one because **a version pair
 * identifies a migration.** `selectMigrations` matches on exact `from`/`to`
 * labels, so a second `0.x → 1.0` entry would be indistinguishable from this
 * one to every query, and would print the pair twice in `--help`. One entry per
 * pair; a release with two breaking changes is one migration with two rules.
 *
 * The `summary` is the guide snippet's heading and now names both, because a
 * heading that covers one of two rules is the same kind of partial label this
 * issue is about.
 *
 * ## It is PROSPECTIVE, and the engine acts on that
 *
 * Neither change has shipped. `migrate` will not apply this unless asked with
 * `--include-prospective`, and `--check` reports it separately from work that is
 * actually due. When they land, this entry's status changes to `published` and
 * its `to` becomes the real release — the rules do not.
 */
const PRESET_AUDIT_RESHAPE: Migration = {
  from: '0.x',
  to: '1.0',
  status: 'prospective',
  summary: 'Preset audit durability moves under `sink`; `migrate --json` gains `advisories`',
  reference: 'https://github.com/askturret/mcp/issues/59',
  rules: [
    {
      kind: 'config',
      id: 'preset-audit-durability-under-sink',
      from: 'audit.durability',
      to: 'audit.sink.durable',
      // 'required' | 'optional' in the flat field; the nested form is the same
      // vocabulary, so the value survives unchanged and only its home moves.
      reason:
        '§10.2 describes this as `sink: { durable: … }`. The flat `audit.durability` ' +
        'field was a deviation recorded in #52 and classified MAJOR by #59, because ' +
        '`PresetConfiguration` is returned to adopters and moving a field is a removal ' +
        'plus an addition.',
    },
    {
      kind: 'output',
      id: 'describe-preset-audit-shape',
      surface: 'describePreset()',
      from: 'configuration.audit.durability',
      to: 'configuration.audit.sink.durable',
      reason:
        '`describePreset` is how ADR-007 makes a preset inspectable, so anything ' +
        'asserting on its shape — a config test, a compliance export — reads this path. ' +
        'Reported rather than rewritten: the consumer is the adopter’s code, and §62 ' +
        'is explicit that adopter logic is not ours to edit.',
    },
    {
      kind: 'output',
      id: 'migrate-json-advisories',
      surface: 'migrate --json',
      from: 'findings[]',
      to: 'advisories[]',
      reason:
        'Entries for `output` rules moved out of `findings[]` into a new `advisories[]` ' +
        '(#432). A script filtering `.findings` for work to do no longer sees them — ' +
        'which is the point, since they were never found in the project — but a script ' +
        'COUNTING `.findings` will see a smaller number. Their `file` field also carried ' +
        'a surface name such as `describePreset()` where the type documents a ' +
        'repo-relative path; the replacement field is `surface`, which says what it is.',
    },
  ],
};

/**
 * Every migration, ordered oldest-first.
 *
 * Deliberately not sorted at runtime: the order a migration must be applied in
 * is a property of the migrations, not of their version strings, and a sort
 * would quietly impose semver ordering on labels like `0.x`.
 */
export const MIGRATIONS: readonly Migration[] = [PRESET_AUDIT_RESHAPE];

export interface SelectOptions {
  readonly from?: string;
  readonly to?: string;
  readonly includeProspective?: boolean;
}

/**
 * Which migrations apply to a requested range.
 *
 * Matching is by exact `from`/`to` label rather than by semver comparison. The
 * registry deals in the labels a migration was published under — including
 * `0.x`, which is not a version at all — and a comparator would have to invent
 * a meaning for that. When a real numeric range needs spanning, the entries
 * chain: `0.9 → 1.0` then `1.0 → 1.1`.
 */
export function selectMigrations(options: SelectOptions = {}): readonly Migration[] {
  return MIGRATIONS.filter((migration) => {
    if (options.from !== undefined && migration.from !== options.from) return false;
    if (options.to !== undefined && migration.to !== options.to) return false;
    if (migration.status === 'prospective' && options.includeProspective !== true) return false;
    return true;
  });
}

/** Every version pair the registry knows, for `--help` and the docs index. */
export function knownPairs(): readonly { from: string; to: string; status: string }[] {
  return MIGRATIONS.map((m) => ({ from: m.from, to: m.to, status: m.status }));
}
