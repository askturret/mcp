// SPDX-License-Identifier: Apache-2.0
/**
 * Reliability tier — load, chaos and shutdown/reload scenarios (§12.1, §51).
 *
 * Exported so an adopter can run SUBSETS against their own deployment rather
 * than taking the suite whole: §51's acceptance asks for exactly that, and a
 * bank that can only be run all-or-nothing is one nobody runs.
 */

export {
  NIGHTLY_SCALE,
  PR_SCALE,
  createHarness,
  drive,
  gatedExecutor,
  operation,
  scaleFromEnv,
  tally,
  type CallOutcome,
  type Harness,
  type HarnessOptions,
  type ReliabilityScale,
} from './harness.js';

export {
  PERMITTED_CODES,
  chaosPreservesTypedErrors,
  overlappingSwapsUnderLoad,
  partialFailureIsolatesGroups,
  partialFailureWithoutGrouping,
  reloadDuringDrain,
  retryHoldsBulkheadPermit,
  saturationDoesNotTripBreaker,
  type ChaosResult,
  type PartialFailureResult,
  type ReloadDuringDrainResult,
  type RetryOccupancyResult,
  type SaturationResult,
  type SnapshotIsolationResult,
} from './scenarios/interactions.js';

export {
  boundedResourceUsage,
  canMeasureHeap,
  shutdownUnderLoad,
  type BoundedResourceResult,
  type ShutdownUnderLoadResult,
} from './scenarios/lifecycle.js';

export {
  deadlineFiresOnHungUpstream,
  fastCallBeatsItsDeadline,
  queuedCallsStillHitTheirDeadline,
  type DeadlineResult,
  type DeadlineUnderSaturationResult,
} from './scenarios/deadlines.js';

export {
  loadPetstoreOperations,
  petstoreLayers,
  petstoreSpecPath,
  type PetstoreLayerResult,
  type PetstoreSuiteResult,
} from './scenarios/petstore.js';

export {
  buildGoldenDashboard,
  renderGoldenDashboard,
  type GrafanaDashboard,
  type GrafanaPanel,
} from './dashboards.js';
