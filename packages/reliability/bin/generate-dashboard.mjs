#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/** Regenerate the committed golden dashboard from METRIC_DEFINITIONS. */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { renderGoldenDashboard } from '../dist/index.js';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'dashboards', 'reliability.json');
writeFileSync(out, renderGoldenDashboard(), 'utf8');
console.log(`wrote ${out}`);
