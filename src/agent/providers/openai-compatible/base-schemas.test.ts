/**
 * Unit tests for `selectBaseSchemas` — the surface-scoped builtin schema
 * filter for the OpenAI-compatible provider.
 *
 * Issue #2628 (advisory review finding): `selectBaseSchemas` had no unit tests,
 * leaving the `isWhatifEpisode()` branch uncovered.
 *
 * @module agent/providers/openai-compatible/base-schemas.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { selectBaseSchemas } from './base-schemas.js';
import type { AnthropicToolDef } from '../anthropic-direct/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal tool definitions covering every name the filter cares about. */
const ALL_TOOLS: AnthropicToolDef[] = [
  { name: 'ask_question', description: '', input_schema: { type: 'object', properties: {} } },
  { name: 'terminal_font_size', description: '', input_schema: { type: 'object', properties: {} } },
  { name: 'clipboard_write', description: '', input_schema: { type: 'object', properties: {} } },
  { name: 'clipboard_read', description: '', input_schema: { type: 'object', properties: {} } },
  { name: 'read_file', description: '', input_schema: { type: 'object', properties: {} } },
  { name: 'write_file', description: '', input_schema: { type: 'object', properties: {} } },
  { name: 'bash', description: '', input_schema: { type: 'object', properties: {} } },
];

function names(tools: AnthropicToolDef[]): string[] {
  return tools.map((t) => t.name);
}

// ---------------------------------------------------------------------------
// isSkillDispatch branch
// ---------------------------------------------------------------------------

describe('selectBaseSchemas — isSkillDispatch', () => {
  it('excludes the interactive-only tool set and retains everything else', () => {
    const result = selectBaseSchemas(ALL_TOOLS, { isSkillDispatch: true });
    const resultNames = new Set(names(result));

    // These tools are stripped for skill dispatches:
    const excluded = new Set(['ask_question', 'terminal_font_size', 'clipboard_write', 'clipboard_read']);
    for (const name of excluded) {
      expect(resultNames, `expected ${name} to be stripped`).not.toContain(name);
    }

    // Everything else is retained:
    const retained = new Set(['read_file', 'write_file', 'bash']);
    for (const name of retained) {
      expect(resultNames, `expected ${name} to be retained`).toContain(name);
    }
  });

  it('isNonInteractive is ignored when isSkillDispatch is true', () => {
    const withNI = selectBaseSchemas(ALL_TOOLS, { isSkillDispatch: true, isNonInteractive: true });
    const withoutNI = selectBaseSchemas(ALL_TOOLS, { isSkillDispatch: true, isNonInteractive: false });
    expect(names(withNI)).toEqual(names(withoutNI));
  });
});

// ---------------------------------------------------------------------------
// isNonInteractive branch — outside episode mode
// ---------------------------------------------------------------------------

describe('selectBaseSchemas — isNonInteractive (no episode)', () => {
  beforeEach(() => {
    vi.stubEnv('AFK_WHATIF_EPISODE', '');
  });

  it('strips ask_question', () => {
    const result = selectBaseSchemas(ALL_TOOLS, { isNonInteractive: true });
    expect(names(result)).not.toContain('ask_question');
  });

  it('strips clipboard_read', () => {
    const result = selectBaseSchemas(ALL_TOOLS, { isNonInteractive: true });
    expect(names(result)).not.toContain('clipboard_read');
  });

  it('strips clipboard_write', () => {
    const result = selectBaseSchemas(ALL_TOOLS, { isNonInteractive: true });
    expect(names(result)).not.toContain('clipboard_write');
  });

  it('retains terminal_font_size (narrower strip than skill-dispatch)', () => {
    const result = selectBaseSchemas(ALL_TOOLS, { isNonInteractive: true });
    expect(names(result)).toContain('terminal_font_size');
  });

  it('retains read_file and write_file', () => {
    const result = selectBaseSchemas(ALL_TOOLS, { isNonInteractive: true });
    expect(names(result)).toContain('read_file');
    expect(names(result)).toContain('write_file');
  });
});

// ---------------------------------------------------------------------------
// isNonInteractive branch — inside episode mode (#2600 / #2628)
// ---------------------------------------------------------------------------

describe('selectBaseSchemas — isNonInteractive in what-if episode mode', () => {
  beforeEach(() => {
    vi.stubEnv('AFK_WHATIF_EPISODE', '1');
  });

  it('keeps ask_question so the episode gate can observe it', () => {
    const result = selectBaseSchemas(ALL_TOOLS, { isNonInteractive: true });
    expect(names(result)).toContain('ask_question');
  });

  it('still strips clipboard_read', () => {
    const result = selectBaseSchemas(ALL_TOOLS, { isNonInteractive: true });
    expect(names(result)).not.toContain('clipboard_read');
  });

  it('still strips clipboard_write', () => {
    const result = selectBaseSchemas(ALL_TOOLS, { isNonInteractive: true });
    expect(names(result)).not.toContain('clipboard_write');
  });

  it('retains terminal_font_size', () => {
    const result = selectBaseSchemas(ALL_TOOLS, { isNonInteractive: true });
    expect(names(result)).toContain('terminal_font_size');
  });

  it('retains read_file, write_file, bash', () => {
    const result = selectBaseSchemas(ALL_TOOLS, { isNonInteractive: true });
    expect(names(result)).toContain('read_file');
    expect(names(result)).toContain('write_file');
    expect(names(result)).toContain('bash');
  });
});

// ---------------------------------------------------------------------------
// Interactive (no flags) — pass-through
// ---------------------------------------------------------------------------

describe('selectBaseSchemas — interactive (no flags)', () => {
  it('returns all tools unchanged when no flags set', () => {
    const result = selectBaseSchemas(ALL_TOOLS, {});
    expect(names(result)).toEqual(names(ALL_TOOLS));
  });

  it('returns all tools when both flags are false', () => {
    const result = selectBaseSchemas(ALL_TOOLS, { isSkillDispatch: false, isNonInteractive: false });
    expect(names(result)).toEqual(names(ALL_TOOLS));
  });

  it('does not strip ask_question in interactive mode even inside an episode', () => {
    vi.stubEnv('AFK_WHATIF_EPISODE', '1');
    const result = selectBaseSchemas(ALL_TOOLS, {});
    expect(names(result)).toContain('ask_question');
  });
});
