// SPDX-License-Identifier: Apache-2.0
/**
 * Loading and validating overlay files (§55).
 *
 * ## Fail-fast, except in development
 *
 * §55: "a malformed overlay is a fail-fast startup error unless the runtime is
 * in `development` mode."
 *
 * The asymmetry is right, and worth stating rather than just implementing. An
 * overlay that silently failed to load in production is the worst of the three
 * outcomes available: the server starts, the agent sees operations WITHOUT the
 * classifications or permission requirements the adopter wrote, and nothing
 * anywhere says so. A missing `classifications: [financial]` is a missing
 * confirmation prompt. Refusing to boot is loud and recoverable; booting
 * without the governance the operator configured is neither.
 *
 * In development the trade flips — someone editing an overlay wants the server
 * to keep running while the file is briefly half-written — so there the error
 * is collected and reported instead of thrown.
 */

import {
  OVERLAY_VERSION,
  OverlayValidationError,
  type OverlayDocument,
  type OverlayOperationPatch,
} from './types.js';
import { parseYamlSubset, YamlParseError } from './yaml.js';

/** Fields an overlay may set on an operation. Closed on purpose. */
const OPERATION_FIELDS = new Set([
  'name',
  'description',
  'effects',
  'visibility',
  'input',
  'output',
  'annotations',
]);

const EFFECT_FIELDS = new Set([
  'classifications',
  'readOnly',
  'idempotent',
  'retryable',
  'idempotencyKeyRequired',
]);

const VISIBILITY_FIELDS = new Set(['requirePermissions', 'hidden']);

export type OverlayMode = 'strict' | 'development';

export interface LoadOverlayResult {
  readonly document?: OverlayDocument;
  /** Populated instead of throwing when mode is `development`. */
  readonly error?: OverlayValidationError;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknown(
  known: ReadonlySet<string>,
  actual: Record<string, unknown>,
  location: string,
  path: string,
): void {
  for (const key of Object.keys(actual)) {
    if (known.has(key)) continue;

    // A typo is far likelier than a feature request, and silently ignoring an
    // unknown field means the adopter's customisation never applies with
    // nothing to indicate why. Naming the valid set turns "wrong" into "wrong,
    // and here is what you meant".
    throw new OverlayValidationError(
      location,
      `${path}.${key}`,
      `unknown field '${key}'. Valid fields here: ${[...known].sort().join(', ')}.`,
    );
  }
}

function validateStringArray(
  value: unknown,
  location: string,
  path: string,
): readonly string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new OverlayValidationError(location, path, 'expected an array of strings');
  }
  return value as readonly string[];
}

function validateBoolean(value: unknown, location: string, path: string): boolean | null {
  if (value === null) return null;
  if (typeof value !== 'boolean') {
    throw new OverlayValidationError(location, path, `expected true or false, got ${typeof value}`);
  }
  return value;
}

function validateOperation(
  raw: unknown,
  location: string,
  id: string,
): OverlayOperationPatch {
  if (!isPlainObject(raw)) {
    throw new OverlayValidationError(location, `operations.${id}`, 'expected a mapping');
  }

  const path = `operations.${id}`;
  rejectUnknown(OPERATION_FIELDS, raw, location, path);

  const patch: Record<string, unknown> = {};

  for (const field of ['name', 'description'] as const) {
    if (!(field in raw)) continue;
    const value = raw[field];
    if (value !== null && typeof value !== 'string') {
      throw new OverlayValidationError(location, `${path}.${field}`, 'expected a string or null');
    }
    patch[field] = value;
  }

  if ('effects' in raw) {
    const effects = raw['effects'];
    if (effects === null) patch['effects'] = null;
    else if (!isPlainObject(effects)) {
      throw new OverlayValidationError(location, `${path}.effects`, 'expected a mapping or null');
    } else {
      rejectUnknown(EFFECT_FIELDS, effects, location, `${path}.effects`);
      const out: Record<string, unknown> = {};
      if ('classifications' in effects) {
        out['classifications'] = validateStringArray(
          effects['classifications'],
          location,
          `${path}.effects.classifications`,
        );
      }
      for (const flag of ['readOnly', 'idempotent', 'retryable', 'idempotencyKeyRequired'] as const) {
        if (flag in effects) {
          out[flag] = validateBoolean(effects[flag], location, `${path}.effects.${flag}`);
        }
      }
      patch['effects'] = out;
    }
  }

  if ('visibility' in raw) {
    const visibility = raw['visibility'];
    if (visibility === null) patch['visibility'] = null;
    else if (!isPlainObject(visibility)) {
      throw new OverlayValidationError(location, `${path}.visibility`, 'expected a mapping or null');
    } else {
      rejectUnknown(VISIBILITY_FIELDS, visibility, location, `${path}.visibility`);
      const out: Record<string, unknown> = {};
      if ('requirePermissions' in visibility) {
        out['requirePermissions'] = validateStringArray(
          visibility['requirePermissions'],
          location,
          `${path}.visibility.requirePermissions`,
        );
      }
      if ('hidden' in visibility) {
        out['hidden'] = validateBoolean(visibility['hidden'], location, `${path}.visibility.hidden`);
      }
      patch['visibility'] = out;
    }
  }

  for (const side of ['input', 'output'] as const) {
    if (!(side in raw)) continue;
    const value = raw[side];
    if (value === null) {
      patch[side] = null;
      continue;
    }
    if (!isPlainObject(value)) {
      throw new OverlayValidationError(location, `${path}.${side}`, 'expected a mapping or null');
    }
    rejectUnknown(new Set(['overrideSchema']), value, location, `${path}.${side}`);
    const schema = value['overrideSchema'];
    if (schema !== null && schema !== undefined && !isPlainObject(schema)) {
      throw new OverlayValidationError(
        location,
        `${path}.${side}.overrideSchema`,
        'expected a JSON Schema object or null',
      );
    }
    patch[side] = { overrideSchema: (schema ?? null) as Record<string, unknown> | null };
  }

  if ('annotations' in raw) {
    const annotations = raw['annotations'];
    if (annotations !== null && !isPlainObject(annotations)) {
      throw new OverlayValidationError(
        location,
        `${path}.annotations`,
        'expected a mapping or null',
      );
    }
    patch['annotations'] = annotations;
  }

  return patch as OverlayOperationPatch;
}

/**
 * Validate a parsed overlay document.
 *
 * Exported so a caller that already has the object — a test, or an adopter
 * embedding an overlay in code — validates it by the same rules a file goes
 * through. Two validators would drift.
 */
export function validateOverlayDocument(raw: unknown, location: string): OverlayDocument {
  if (!isPlainObject(raw)) {
    throw new OverlayValidationError(location, '', 'expected a mapping at the top level');
  }

  // `location` is accepted because a validated `OverlayDocument` carries it,
  // and the compiler pass re-validates whatever the caller put in
  // `context.overlays` — including a document this module produced. Rejecting
  // it would make a parsed overlay fail its own validator, which is the kind of
  // asymmetry that turns into "it worked from a file but not in code".
  rejectUnknown(new Set(['version', 'operations', 'location']), raw, location, '');

  const version = raw['version'];
  if (version !== OVERLAY_VERSION) {
    // Refused rather than assumed. A future format read by this build would be
    // interpreted under v1 rules, which is the quiet-wrong-answer case an
    // overlay can least afford.
    throw new OverlayValidationError(
      location,
      'version',
      `unsupported overlay version ${JSON.stringify(version)}; this build understands ${OVERLAY_VERSION}`,
    );
  }

  const operations = raw['operations'];
  if (operations !== undefined && !isPlainObject(operations)) {
    throw new OverlayValidationError(location, 'operations', 'expected a mapping of operation id to patch');
  }

  const validated: Record<string, OverlayOperationPatch> = {};
  for (const [id, patch] of Object.entries(operations ?? {})) {
    validated[id] = validateOperation(patch, location, id);
  }

  return { version: OVERLAY_VERSION, operations: validated, location };
}

/**
 * Parse overlay text. `.json` goes through `JSON.parse`; anything else through
 * the YAML subset reader.
 */
export function parseOverlay(text: string, location: string): OverlayDocument {
  let raw: unknown;

  if (location.endsWith('.json')) {
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new OverlayValidationError(
        location,
        '',
        `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    try {
      raw = parseYamlSubset(text);
    } catch (error) {
      if (error instanceof YamlParseError) {
        throw new OverlayValidationError(location, '', error.message);
      }
      throw error;
    }
  }

  return validateOverlayDocument(raw, location);
}

/**
 * Parse an overlay, honouring the mode.
 *
 * `strict` throws — the caller is expected to let it reach the operator and
 * stop the boot. `development` returns the error instead, so an editor session
 * survives a half-written file.
 */
export function loadOverlay(text: string, location: string, mode: OverlayMode): LoadOverlayResult {
  try {
    return { document: parseOverlay(text, location) };
  } catch (error) {
    if (mode === 'strict') throw error;
    return {
      error:
        error instanceof OverlayValidationError
          ? error
          : new OverlayValidationError(location, '', String(error)),
    };
  }
}
