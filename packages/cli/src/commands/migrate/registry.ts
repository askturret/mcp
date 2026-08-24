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
 * `via-handler`. Every workspace is still `private: true`, so no adopter has
 * ever installed a version to migrate from.
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
 * That makes it the one breaking change in this project whose shape, direction
 * and version impact are all already decided by something other than this file.
 * The migration is derived from those decisions rather than invented to fill a
 * slot, which is the whole difference between a reference and a placeholder.
 *
 * ## It is PROSPECTIVE, and the engine acts on that
 *
 * The reshape has not happened. `migrate` will not apply this unless asked with
 * `--include-prospective`, and `--check` reports it separately from work that is
 * actually due. When the reshape lands, this entry's status changes to
 * `published` and its `to` becomes the real release — the rules do not.
 */
const PRESET_AUDIT_RESHAPE: Migration = {
  from: '0.x',
  to: '1.0',
  status: 'prospective',
  summary: 'Preset audit durability moves under `sink`',
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
