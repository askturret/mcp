/**
 * Doctor's preset-expansion output.
 *
 * These call the real formatters rather than re-deriving what they should
 * print. `doctor.test.ts`'s header warns about exactly that — its own "Light
 * preset policy" block inspects the fixture and never invokes the analyser,
 * so it passes regardless of what the code does. Not copying that shape.
 */

import { describe, it, expect } from '@jest/globals';
import { describePreset } from '@askturret/mcp-core';
import { formatHumanReadable, formatJson } from '../commands/doctor-output.js';
import type { AnalysisResult } from '../commands/doctor-types.js';

function emptyResult(overrides?: Partial<AnalysisResult>): AnalysisResult {
  return {
    score: 100,
    operations: [],
    globalFindings: [],
    summary: {
      totalOperations: 0,
      errors: 0,
      warnings: 0,
      info: 0,
      lightExposed: 0,
      lightDropped: 0,
    },
    spec: { openApiVersion: '3.0.0' },
    ...overrides,
  };
}

describe('preset expansion in doctor output', () => {
  it('prints nothing about presets when none was requested', () => {
    // Adding the section must not change existing output.
    const text = formatHumanReadable(emptyResult());
    expect(text).not.toContain('expands to');
  });

  it('prints the expansion when --preset was used', () => {
    const text = formatHumanReadable(emptyResult({ preset: describePreset('production') }));

    expect(text).toContain("Preset 'production' expands to:");
    // The values an operator would actually check.
    expect(text).toContain('"readInclude": "tagged-only"');
    expect(text).toContain('"required": true');
    expect(text).toContain('"reloadMode": "degraded"');
    expect(text).toContain('"responseMaxBytes": 4194304');
  });

  it('prints output an operator can paste back as configuration', () => {
    // ADR-007's actual requirement: inline the expansion, change one field.
    // A prose summary would read better and fail this.
    const text = formatHumanReadable(emptyResult({ preset: describePreset('production') }));

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    const block = text.slice(start, end + 1);

    expect(() => JSON.parse(block)).not.toThrow();
    expect(JSON.parse(block)).toEqual(describePreset('production').configuration);
  });

  it('names every control that is declared but not enforced', () => {
    const text = formatHumanReadable(emptyResult({ preset: describePreset('production') }));

    expect(text).toContain('Declared but not yet enforced');
    expect(text).toContain('audit.sink');
    expect(text).toContain('redaction');
    // The tracking issue, so a reader can go and look.
    expect(text).toMatch(/tracked by #\d+/);
  });

  it('carries the expansion through the --json path', () => {
    const parsed = JSON.parse(formatJson(emptyResult({ preset: describePreset('production') })));

    expect(parsed.preset.preset).toBe('production');
    expect(parsed.preset.configuration.authorization.policy).toContain('authenticated');
  });

  it('is deterministic across runs', () => {
    // doctor.test.ts pins error-code stability the same way; a preset section
    // containing a timestamp or a closure would break it.
    const a = formatJson(emptyResult({ preset: describePreset('production') }));
    const b = formatJson(emptyResult({ preset: describePreset('production') }));
    expect(a).toBe(b);
  });
});
