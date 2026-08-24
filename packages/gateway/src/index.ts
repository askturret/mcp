// SPDX-License-Identifier: Apache-2.0
/**
 * AskTurret MCP — standalone compatibility gateway (#57, §11.3).
 *
 * The npx entry point is `cli.ts`; this is the programmatic surface, exported
 * so the gateway can be started in-process — which is how its own tests drive
 * it, and how the conformance kit can treat it as an adapter under test.
 */

export {
  GatewayConfigError,
  HELP_TEXT,
  parseArgs,
  parseConfigFile,
  resolveConfig,
  type GatewayAuditConfig,
  type GatewayConfig,
  type GatewayPreset,
  type ParsedArgs,
  type PartialGatewayConfig,
} from './config.js';

export { resolvePreset, type ResolvedPreset } from './preset.js';

export {
  createPrometheusRegistry,
  PROMETHEUS_CONTENT_TYPE,
  type PrometheusRegistry,
} from './metrics.js';

export { startGateway, type RunningGateway, type StartGatewayOptions } from './server.js';

export { GATEWAY_VERSION } from './version.js';
