#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the documentation type-vocabulary guard (#156).
 *
 * Each case reproduces a drift found in the real repository, plus the
 * near-misses that would make the guard cry wolf. The false-positive cases
 * matter as much as the true ones here: three of them were live defects in the
 * guard's first draft, and a guard that fails on correct documentation gets
 * switched off, which is indistinguishable from never having written it.
 *
 * Run: node .github/scripts/check-doc-types.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { check, memberNames, aliasMembers, stripNonCode, typescriptBlocks } from './check-doc-types.mjs';

let passed = 0;
let failed = 0;

function is(desc, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`ok   - ${desc}`);
    passed++;
  } else {
    console.log(`FAIL - ${desc}\n       expected ${e}\n       got      ${a}`);
    failed++;
  }
}

const tmpDirs = [];

/** A throwaway repo: one source file of types, one doc. */
function scratch(sourceTs, markdown, { docName = 'guide.md' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'doctypes-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, 'packages', 'core', 'src'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'core', 'src', 'types.ts'), sourceTs);
  writeFileSync(join(dir, 'docs', docName), markdown);
  return dir;
}

const fence = (body) => `# Doc\n\n\`\`\`typescript\n${body}\n\`\`\`\n`;

const SOURCE = `
export interface OperationDefinition {
  readonly id: string;
  readonly effects: EffectMetadata;
  readonly executor: ExecutorBinding;
  readonly annotations?: Readonly<Record<string, unknown>>;
}
export interface EffectMetadata { readonly readOnly: boolean; }
export interface ExecutorBinding { readonly type: string; }
export interface OperationExecutor {
  execute(
    operation: OperationDefinition,
    input: unknown,
  ): Promise<OperationResult>;
}
export interface OperationResult { readonly ok: boolean; }
export type PolicyDecision =
  | { readonly effect: 'allow' }
  | { readonly effect: 'deny'; readonly code: string; readonly safeReason: string };
export type OperationId = string;
export interface SourcedValue<TValue> { readonly value: TValue; }
`;

// ---------------------------------------------------------------------------
// Unit: the parsers, where the guard's first draft was actually wrong
// ---------------------------------------------------------------------------

is(
  'memberNames: a METHOD is a member (the bug that reported "Real members: ")',
  memberNames('execute(\n  a: string,\n  b: number,\n): Promise<void>;'),
  ['execute'],
);

is(
  'memberNames: a nested object type contributes only its OWN field',
  memberNames('source: {\n  kind: string;\n  location?: string;\n};'),
  ['source'],
);

is(
  'memberNames: readonly and optional modifiers do not become part of the name',
  memberNames('readonly id: string;\nreadonly annotations?: Record<string, unknown>;'),
  ['id', 'annotations'],
);

is(
  'aliasMembers: unions the members of every variant',
  [...aliasMembers("type X = | { a: 1; b: 2 } | { a: 1; c: 3 };", 0)].sort(),
  ['a', 'b', 'c'],
);

is(
  'aliasMembers: an alias with no object literal has NO member vocabulary (null, not empty)',
  aliasMembers('type X = Readonly<Record<string, number>>;', 0),
  null,
);

is(
  'stripNonCode: keepStrings preserves the module specifier the import scan needs',
  stripNonCode("import X from 'fastify'; // c", { keepStrings: true }).trim(),
  "import X from 'fastify';",
);

is('typescriptBlocks: finds a ts-tagged fence', typescriptBlocks('```ts\nlet a;\n```').length, 1);

// ---------------------------------------------------------------------------
// True positives: each is a drift that was really in the tree
// ---------------------------------------------------------------------------

{
  // D1: `Effect[]` / `Executor[]` — types that do not exist.
  const r = check(scratch(SOURCE, fence('interface OperationDefinition {\n  effects: Effect[];\n}')));
  is('D1: a type name with no referent fails', r.code, 1);
  is('D1: names the missing type', r.message.includes("'Effect' is not an exported type"), true);
}

{
  // D1: `executors` plural, when the real field is singular.
  const r = check(
    scratch(SOURCE, fence('interface OperationDefinition {\n  executors: ExecutorBinding[];\n}')),
  );
  is('D1: a documented field that does not exist fails', r.code, 1);
  is(
    'D1: names the field AND lists the real ones',
    r.message.includes('OperationDefinition.executors does not exist') &&
      r.message.includes('id, effects, executor, annotations'),
    true,
  );
}

{
  // D3: a `type` field on an interface whose only member is `execute`.
  const r = check(
    scratch(SOURCE, fence('interface OperationExecutor {\n  type: string;\n  execute(): void;\n}')),
  );
  is('D3: a spurious field on a method-only interface fails', r.code, 1);
  is('D3: reports the real member', r.message.includes('Real members: execute'), true);
}

{
  // D4: `reason` on a union type, where the real variant carries `safeReason`.
  const r = check(
    scratch(SOURCE, fence("type PolicyDecision =\n  | { effect: 'deny'; reason: string };")),
  );
  is('D4: a member on NO variant of a union fails', r.code, 1);
  is('D4: names it', r.message.includes('PolicyDecision.reason does not exist'), true);
}

// ---------------------------------------------------------------------------
// False positives: correct documentation the guard must NOT fail
// ---------------------------------------------------------------------------

{
  const r = check(
    scratch(
      SOURCE,
      fence(
        'interface OperationDefinition {\n' +
          '  readonly id: OperationId;\n' +
          '  readonly effects: EffectMetadata;\n' +
          '  readonly executor: ExecutorBinding;\n' +
          '}',
      ),
    ),
  );
  is('correct documentation passes', r.code, 0);
}

{
  // Abridgement is legitimate: a doc may omit fields, never invent them.
  const r = check(scratch(SOURCE, fence('interface OperationDefinition {\n  readonly id: OperationId;\n}')));
  is('a doc that OMITS real fields still passes (abridgement is not drift)', r.code, 0);
}

{
  // A third-party type is not ours to check — the import says where it lives.
  const r = check(
    scratch(SOURCE, fence("import Fastify from 'fastify';\n\nconst app: Fastify = null;")),
  );
  is('a type imported from OUTSIDE the workspace is not flagged', r.code, 0);
}

{
  // ...but a workspace import stays checked.
  const r = check(
    scratch(SOURCE, fence("import { Nonexistent } from '@askturret/mcp-core';\n\nlet a: Nonexistent;")),
  );
  is('a WORKSPACE import of a missing type is still flagged', r.code, 1);
}

{
  // SCREAMING_SNAKE is a constant, not a type.
  const r = check(scratch(SOURCE, fence('const v = PLUGIN_API_VERSION;')));
  is('a SCREAMING_SNAKE constant is not treated as a type', r.code, 0);
}

{
  // A generic parameter the block itself declares is a local name. The
  // interface it sits on is real, so only `TValue` is at issue here.
  const r = check(scratch(SOURCE, fence('interface SourcedValue<TValue> {\n  value: TValue;\n}')));
  is('a locally-declared generic parameter is not flagged', r.code, 0);
}

{
  // ...and the enclosing type still has to exist. A block declaring a type
  // this repository does not export is the `SourcedValue`-shaped drift (D2)
  // that started #156 — except that one turned out to be real, which is why
  // the guard must answer the question rather than assume either way.
  const r = check(scratch(SOURCE, fence('interface NotOurs<TValue> {\n  value: TValue;\n}')));
  is('a block declaring a type that does not exist is flagged', r.code, 1);
}

{
  const r = check(
    scratch(SOURCE, fence('// doc-types: illustrative\nclass MyOwnExecutor {\n  run(): void {}\n}')),
  );
  is('an illustrative block opts out', r.code, 0);
}

// ---------------------------------------------------------------------------
// Refusal: an unusable index must not report success
// ---------------------------------------------------------------------------

{
  const dir = mkdtempSync(join(tmpdir(), 'doctypes-empty-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'g.md'), fence('interface X { a: string; }'));
  const r = check(dir);
  is('an empty type index exits 2 rather than passing everything', r.code, 2);
}

for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });

console.log(`\npassed: ${passed}  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
