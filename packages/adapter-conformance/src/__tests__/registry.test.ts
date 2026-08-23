// SPDX-License-Identifier: Apache-2.0
/**
 * Adapter membership and the `--adapter` filter (§42).
 *
 * §42 says "a new adapter that lands in the repo automatically joins the
 * suite". Nothing can literally auto-import an arbitrary new package, so the
 * guarantee is enforced the other way round: the suite DISCOVERS
 * `packages/adapters-*` from disk and fails if any of them has no registered
 * factory. A new adapter therefore cannot land and quietly sit outside the
 * contract — the build stops until it joins, which is what "automatically
 * joins" is actually asking for.
 */

import { describe, it, expect } from '@jest/globals';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { registeredAdapters, selectedAdapters } from '../registry.js';
import '../adapters.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** `packages/adapters-fastify` -> `fastify`. */
const adapterPackages = readdirSync(join(REPO_ROOT, 'packages'))
  .filter((name) => name.startsWith('adapters-'))
  .map((name) => name.replace(/^adapters-/, ''));

describe('adapter membership', () => {
  it('discovers the adapter packages it is meant to enforce', () => {
    // Guards the guard: a glob matching nothing would make the check below
    // vacuously true, and the suite would certify a contract it never applied.
    expect(adapterPackages).toEqual(expect.arrayContaining(['express', 'fastify']));
  });

  it.each(adapterPackages)('has a registered factory for the %s adapter', (name) => {
    expect(registeredAdapters()).toContain(name);
  });

  it('registers no adapter that has no package', () => {
    // The reverse direction. A factory left behind after a package was removed
    // would fail at run time inside a category, where the error reads as an
    // adapter defect rather than as stale registration.
    for (const registered of registeredAdapters()) {
      expect(adapterPackages).toContain(registered);
    }
  });
});

describe('--adapter filter', () => {
  // An EXPLICIT empty env, always.
  //
  // `CONFORMANCE_ADAPTER` is real process state whenever the suite is invoked
  // as `npm run test:conformance -- --adapter express`, and it is checked
  // before argv. Letting these cases inherit `process.env` made every argv
  // assertion below fail under exactly that invocation — the one the issue
  // documents — while passing under a plain `npm test`. A unit test that
  // depends on how its own suite was launched is not testing what it claims.
  const NO_ENV = {} as NodeJS.ProcessEnv;

  it('defaults to every registered adapter', () => {
    expect(selectedAdapters(['node', 'jest'], NO_ENV)).toEqual(registeredAdapters());
  });

  it('selects a single adapter when asked', () => {
    expect(selectedAdapters(['node', 'jest', '--adapter', 'express'], NO_ENV)).toEqual(['express']);
  });

  it('THROWS on an unknown adapter rather than running nothing', () => {
    // The important one. A typo that silently selected zero adapters would
    // report a green suite having tested nothing at all — the precise
    // false-negative this package exists to prevent.
    expect(() => selectedAdapters(['node', 'jest', '--adapter', 'koa'], NO_ENV)).toThrow(
      /not registered/,
    );
  });

  it('THROWS when --adapter is given no value', () => {
    expect(() => selectedAdapters(['node', 'jest', '--adapter'], NO_ENV)).toThrow(
      /requires a value/,
    );
    expect(() => selectedAdapters(['node', 'jest', '--adapter', '--json'], NO_ENV)).toThrow(
      /requires a value/,
    );
  });

  it('honours CONFORMANCE_ADAPTER, which is how the runner passes the flag', () => {
    expect(selectedAdapters(['node', 'jest'], { CONFORMANCE_ADAPTER: 'fastify' })).toEqual([
      'fastify',
    ]);
  });

  it('THROWS on an unknown CONFORMANCE_ADAPTER', () => {
    expect(() => selectedAdapters(['node', 'jest'], { CONFORMANCE_ADAPTER: 'koa' })).toThrow(
      /not registered/,
    );
  });
});
