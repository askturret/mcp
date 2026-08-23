// SPDX-License-Identifier: Apache-2.0
/**
 * An adapter that schedules a stdout write to land AFTER the run finishes.
 *
 * QA's residual-edge case. The first version of the fix restored stdout in
 * `finally` and emitted the document afterwards, so a timer like this could
 * fire between the restore and the emit — putting garbage BEFORE the JSON,
 * which is the one position that makes it unparseable.
 */
import { expressAdapterUnderTest } from '../../../dist/in-repo-adapters.js';

export default {
  name: 'late-writer',
  async createServer(config) {
    const timer = setTimeout(() => {
      process.stdout.write('LATE-WRITE-GARBAGE\n');
    }, 200);
    // Un-ref'd so it cannot hold the process open; it still fires if the
    // process is alive, which is exactly the case under test.
    timer.unref?.();
    return expressAdapterUnderTest.createServer(config);
  },
};
