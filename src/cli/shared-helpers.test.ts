/**
 * Tests for system-prompt layering helpers.
 *
 * Invariant under test: the framework base (`prompts/system-prompt.md`) is the
 * UNCONDITIONAL foundation; the operator overlay (AFK_SYSTEM_PROMPT →
 * afk.config.json → AFK.md) is APPENDED on top, never substituted for the base.
 * This is the inverse of the historical `overlay ?? framework` behavior, where
 * any operator prompt replaced the framework base wholesale.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OPERATOR_CONFIG_HEADER,
  composeSystemPrompt,
  resolveBaseSystemPrompt,
} from './shared-helpers.js';
import { loadConfig } from './config.js';

// Mock the config module so loadConfig() (the overlay source) is controllable.
// loadSystemPrompt() is an in-module call in shared-helpers and reads the real
// prompts/system-prompt.md from the package tree — i.e. the framework base is
// genuinely present in these tests, which is the production invariant.
vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>();
  return { ...actual, loadConfig: vi.fn() };
});

const FRAMEWORK = '# Agent AFK\n\nYou operate inside a runtime.';
const OVERLAY = '# Project\n\nUse pnpm. Never touch main.';

describe('composeSystemPrompt', () => {
  it('appends the overlay beneath the operator-config header when both present', () => {
    const out = composeSystemPrompt(FRAMEWORK, OVERLAY);
    expect(out).toBeDefined();
    const fwIdx = out!.indexOf(FRAMEWORK);
    const headerIdx = out!.indexOf(OPERATOR_CONFIG_HEADER);
    const ovIdx = out!.indexOf(OVERLAY);
    expect(fwIdx).toBe(0);
    expect(fwIdx).toBeLessThan(headerIdx);
    expect(headerIdx).toBeLessThan(ovIdx);
  });

  it('does NOT let the overlay replace the framework base (regression guard)', () => {
    const out = composeSystemPrompt(FRAMEWORK, OVERLAY);
    expect(out).toContain(FRAMEWORK);
    expect(out).toContain(OVERLAY);
    expect(out).not.toBe(OVERLAY);
  });

  it('returns the framework unchanged when no overlay is present', () => {
    expect(composeSystemPrompt(FRAMEWORK, undefined)).toBe(FRAMEWORK);
    expect(composeSystemPrompt(FRAMEWORK, '')).toBe(FRAMEWORK);
    expect(composeSystemPrompt(FRAMEWORK, '   \n  ')).toBe(FRAMEWORK);
  });

  it('returns the overlay alone when the framework is genuinely absent (dev/test edge)', () => {
    expect(composeSystemPrompt(undefined, OVERLAY)).toBe(OVERLAY);
    expect(composeSystemPrompt('', OVERLAY)).toBe(OVERLAY);
  });

  it('returns undefined when neither is present', () => {
    expect(composeSystemPrompt(undefined, undefined)).toBeUndefined();
    expect(composeSystemPrompt('', '')).toBeUndefined();
    expect(composeSystemPrompt('  ', undefined)).toBeUndefined();
  });

  it('never emits a dangling header (header only appears with both parts)', () => {
    expect(composeSystemPrompt(FRAMEWORK, undefined)).not.toContain(OPERATOR_CONFIG_HEADER);
    expect(composeSystemPrompt(undefined, OVERLAY)).not.toContain(OPERATOR_CONFIG_HEADER);
  });
});

describe('resolveBaseSystemPrompt', () => {
  function fakeConfig(overlay: string | undefined, source: string | undefined) {
    return {
      model: 'sonnet',
      maxTokens: 8192,
      temperature: 1,
      updatePolicy: 'prompt',
      ...(overlay !== undefined ? { systemPrompt: overlay } : {}),
      ...(source !== undefined ? { systemPromptSource: source } : {}),
    } as unknown as ReturnType<typeof loadConfig>;
  }

  beforeEach(() => {
    vi.mocked(loadConfig).mockReset();
  });

  it('layers framework + overlay and reports a composed source', () => {
    vi.mocked(loadConfig).mockReturnValue(fakeConfig('Operator says hi', 'afk-md:/repo/AFK.md'));
    const { prompt, source } = resolveBaseSystemPrompt();
    expect(prompt).toBeDefined();
    expect(prompt).toContain('Operator says hi');
    expect(prompt).toContain(OPERATOR_CONFIG_HEADER);
    // Framework base is present too — the operating posture is not replaced.
    expect(prompt!.length).toBeGreaterThan('Operator says hi'.length + OPERATOR_CONFIG_HEADER.length);
    expect(source).toBe('framework+afk-md:/repo/AFK.md');
  });

  it('reports source "framework" when no overlay is configured', () => {
    vi.mocked(loadConfig).mockReturnValue(fakeConfig(undefined, undefined));
    const { prompt, source } = resolveBaseSystemPrompt();
    expect(prompt).toBeDefined();
    expect(prompt).not.toContain(OPERATOR_CONFIG_HEADER);
    expect(source).toBe('framework');
  });

  it('prefixes whatever overlay tier won (env example)', () => {
    vi.mocked(loadConfig).mockReturnValue(fakeConfig('env override', 'env:AFK_SYSTEM_PROMPT'));
    const { source } = resolveBaseSystemPrompt();
    expect(source).toBe('framework+env:AFK_SYSTEM_PROMPT');
  });
});
