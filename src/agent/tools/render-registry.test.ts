/**
 * Tests for the tool-result render registry.
 *
 * Covers the boundary behavior of `renderToolResult`: registry lookup,
 * fail-open semantics on parse error / unrecognized shape, and the
 * ANSI/control-char sanitizer that runs on every formatter output before
 * returning. The per-formatter shape parsing is covered separately in
 * `src/agent/memory/memory-tool-renderers.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { renderToolResult, toolRenderers } from './render-registry.js';

describe('toolRenderers registry — startup invariants', () => {
  // Drift guard: if a memory tool's name changes, this assertion catches
  // the registry breaking before any session runs.
  it('registers formatters for all three memory tool names', () => {
    expect(toolRenderers.has('memory_search')).toBe(true);
    expect(toolRenderers.has('memory_update')).toBe(true);
    expect(toolRenderers.has('procedure_write')).toBe(true);
  });

  it('registers a bash formatter for both lowercase and capitalized names', () => {
    expect(toolRenderers.has('bash')).toBe(true);
    expect(toolRenderers.has('Bash')).toBe(true);
  });

  it('every registered formatter is a function', () => {
    for (const fn of toolRenderers.values()) {
      expect(typeof fn).toBe('function');
    }
  });

  it('every registered formatter returns a non-empty string on a known-good fixture', () => {
    // This is the L1 startup validation the paranoid critic asked for:
    // proves that no formatter is dead-on-arrival (e.g., import broken,
    // accidentally returning null unconditionally).
    const fixtures: Record<string, string> = {
      memory_search: JSON.stringify([{ type: 'fact' }]),
      memory_update: JSON.stringify({ saved: true, target: 'hot' }),
      procedure_write: JSON.stringify({ name: 'x', written: true }),
      bash: '{"additions":1016,"baseRefName":"main"}',
      Bash: '{"additions":1016,"baseRefName":"main"}',
    };
    for (const [name, formatter] of toolRenderers.entries()) {
      const fixture = fixtures[name];
      expect(fixture, `missing fixture for ${name}`).toBeDefined();
      const out = formatter(fixture!);
      expect(out, `${name} returned null on known-good fixture`).not.toBeNull();
      expect(out!.length).toBeGreaterThan(0);
    }
  });
});

describe('renderToolResult', () => {
  it('returns null for unknown tool name (fall-through to preview path)', () => {
    expect(renderToolResult('read_file', '{}')).toBeNull();
    expect(renderToolResult('grep', '[]')).toBeNull();
  });

  it('returns null when toolName is undefined', () => {
    expect(renderToolResult(undefined, '[]')).toBeNull();
  });

  it('returns null when the formatter does not recognize the shape', () => {
    expect(renderToolResult('memory_update', '{"foo":"bar"}')).toBeNull();
    expect(renderToolResult('procedure_write', '{"name":"x"}')).toBeNull();
  });

  it('returns the formatted display for a known-good payload', () => {
    expect(renderToolResult('memory_search', '[]')).toBe('no results');
  });

  it('sanitizes ANSI escape sequences from the formatter output', () => {
    // Simulate a poisoned procedure name that contains a CSI clear-screen
    // sequence. The model-controlled `name` would otherwise flow through
    // `palette.dim(...)` into the terminal, allowing display-string smuggling.
    const poisoned = JSON.stringify({
      name: '\x1b[2J\x1b[Hmalicious',
      written: true,
    });
    const out = renderToolResult('procedure_write', poisoned);
    expect(out).not.toBeNull();
    expect(out!).not.toContain('\x1b');
    expect(out!).toContain('malicious');
  });

  it('replaces C0 control characters with spaces', () => {
    const poisoned = JSON.stringify({
      name: 'with\x07bell\x00null',
      written: true,
    });
    const out = renderToolResult('procedure_write', poisoned);
    expect(out).not.toBeNull();
    // Bell + NUL → spaces (collapsed visually, but no literal control byte)
    expect(out!).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(out!).toContain('with');
    expect(out!).toContain('bell');
    expect(out!).toContain('null');
  });

  it('fails open if a formatter throws', () => {
    // We can't easily inject a throwing formatter without mutating the
    // registry, but a malformed JSON exercises the try/catch path.
    expect(renderToolResult('memory_search', 'not even json')).toBeNull();
  });
});
