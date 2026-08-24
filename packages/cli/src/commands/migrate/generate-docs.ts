#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Regenerate docs/migrations/README.md from the registry (#62).
 *
 * The index is GENERATED, and a test asserts the committed file matches this
 * output. So a migration added without regenerating the doc fails CI, rather
 * than shipping an index that silently omits it — the same reason
 * docs/adapters.md is generated rather than maintained.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { renderIndex } from './guide.js';

const target = resolve(process.argv[2] ?? 'docs/migrations/README.md');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, renderIndex(), 'utf8');
process.stdout.write(`wrote ${target}\n`);
