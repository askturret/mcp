// SPDX-License-Identifier: Apache-2.0
/**
 * An adapter whose late stdout write can outlive the run (#174).
 *
 * The difference from `late-writer-adapter.mjs` is one line, and it is the
 * whole point: that timer is `unref`'d, so it cannot hold the process open and
 * in practice lands DURING the run, where the diversion catches it either way.
 * That is why the existing fixture could not reproduce QA's corruption.
 *
 * This timer is deliberately NOT un-ref'd. It keeps the event loop alive past
 * the end of the run, which is what extends the window QA identified: not the
 * microseconds between a restore and an emit, but everything after the restore
 * until the process exits.
 *
 * Under the old implementation — restore in `finally` — this write landed on
 * the REAL stdout, after the document, and
 * `JSON.parse(readFileSync('results.json'))` threw on the trailing garbage.
 */
import { expressAdapterUnderTest } from '../../../dist/in-repo-adapters.js';

export default {
  name: 'persistent-late-writer',
  async createServer(config) {
    // NOT un-ref'd — see above. 200ms per the issue's pinnable test.
    setTimeout(() => {
      process.stdout.write('PERSISTENT-LATE-WRITE-GARBAGE\n');
    }, 200);
    return expressAdapterUnderTest.createServer(config);
  },
};
