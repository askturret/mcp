// SPDX-License-Identifier: Apache-2.0
/**
 * An adapter that prints to stdout — at MODULE LOAD and during createServer.
 *
 * Stands in for arbitrary third-party code: a banner, a deprecation notice, a
 * stray console.log left in. The kit cannot audit a community adapter, so the
 * `--json` contract has to survive one that is noisy.
 *
 * The MODULE-SCOPE write is here because QA's adversarial fixture caught that
 * the first version only printed from `createServer`. That version could not
 * catch a regression in ordering around the dynamic `import()` — if the kit
 * ever loaded the adapter BEFORE taking ownership of stdout, a banner printed
 * at import time would land in the document and no test would notice.
 */
console.log('NOISY-ADAPTER-MODULE-SCOPE');

import { expressAdapterUnderTest } from '../../../dist/in-repo-adapters.js';

export default {
  name: 'noisy',
  async createServer(config) {
    console.log('NOISY-ADAPTER-BANNER: starting up');
    process.stdout.write('NOISY-ADAPTER-RAW-WRITE\n');
    return expressAdapterUnderTest.createServer(config);
  },
};
