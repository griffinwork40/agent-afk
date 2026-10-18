/**
 * Tests for model-fallback logic and resolveChildModel provenance.
 *
 * Run with: pnpm test src/agent/subagent/model-fallback.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { resolveChildModel } from './resolve-child-model.js';
import { isFallbackEligibleSource, attemptModelFallback } from './model-fallback.js';
import type { ToolResult } from '../tools/types.js';

// ---------------------------------------------------------------------------
// resolveChildModel — provenance overload
// ---------------------------------------------------------------------------

describe('resolveChildModel provenance (withSource: true)', () => {
  it('returns source=callSite when callSiteModel is set', () => {
    const r = resolveChildModel({ callSiteModel: 'opus', defaultSubagentModel: 'haiku' }, { withSource: true });
    expect(r).toEqual({ model: 'opus', source: 'callSite' });
  });

  it('returns source=namedAgent when only namedAgentModel is set', () => {
    const r = resolveChildModel({ namedAgentModel: 'haiku', defaultSubagentModel: 'sonnet' }, { withSource: true });
    expect(r).toEqual({ model: 'haiku', source: 'namedAgent' });
  });

  it('returns source=default when only defaultSubagentModel is set', () => {
    const r = resolveChildModel({ defaultSubagentModel: 'local' }, { withSource: true });
    expect(r).toEqual({ model: 'local', source: 'default' });
  });

  it('returns source=parent when only defaultModel is set', () => {
    const r = resolveChildModel({ defaultModel: 'claude-opus-5-5' }, { withSource: true });
    expect(r).toEqual({ model: 'claude-opus-5-5', source: 'parent' });
  });

  it('returns source=floor when nothing is set', () => {
    const r = resolveChildModel({}, { withSource: true });
    expect(r).toEqual({ model: 'sonnet', source: 'floor' });
  });

  it('callSite wins over namedAgent', () => {
    const r = resolveChildModel(
      { callSiteModel: 'gpt-5.5', namedAgentModel: 'haiku', defaultSubagentModel: 'local' },
      { withSource: true },
    );
    expect(r).toEqual({ model: 'gpt-5.5', source: 'callSite' });
  });

  it('string overload still returns plain string', () => {
    const model = resolveChildModel({ callSiteModel: 'sonnet' });
    expect(typeof model).toBe('string');
    expect(model).toBe('sonnet');
  });
});

// ---------------------------------------------------------------------------
// isFallbackEligibleSource
// ---------------------------------------------------------------------------

describe('isFallbackEligibleSource', () => {
  it('returns true for default', () => {
    expect(isFallbackEligibleSource('default')).toBe(true);
  });

  it('returns true for floor', () => {
    expect(isFallbackEligibleSource('floor')).toBe(true);
  });

  it('returns false for callSite', () => {
    expect(isFallbackEligibleSource('callSite')).toBe(false);
  });

  it('returns false for namedAgent', () => {
    expect(isFallbackEligibleSource('namedAgent')).toBe(false);
  });

  it('returns false for parent', () => {
    expect(isFallbackEligibleSource('parent')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// attemptModelFallback integration
// ---------------------------------------------------------------------------

const MODEL_REJECTION_ERROR: ToolResult = {
  content: 'ChatGPT/Codex backend rejected model "q36-hf" (HTTP 400). This is a ChatGPT-subscription backend restriction.',
  isError: true,
};

const TRANSIENT_ERROR: ToolResult = {
  content: 'Rate limit exceeded (429). Please retry after 30s.',
  isError: true,
};

const SUCCESS_RESULT: ToolResult = {
  content: 'Agent completed successfully.',
};

describe('attemptModelFallback', () => {
  it('retries on default-tier model rejection → returns warning + fallback result', async () => {
    const rerun = vi.fn().mockResolvedValue({ content: 'Fallback ran fine.' });

    const result = await attemptModelFallback({
      firstResult: MODEL_REJECTION_ERROR,
      failedModel: 'local',
      source: 'default',
      parentModel: 'claude-opus-5-5',
      traceWriter: undefined,
      rerun,
    });

    expect(rerun).toHaveBeenCalledWith('claude-opus-5-5');
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('[model-fallback]');
    expect(result.content).toContain('"local"');
    expect(result.content).toContain('claude-opus-5-5');
    expect(result.content).toContain('Fallback ran fine.');
  });

  it('does NOT retry on explicit callSite model rejection', async () => {
    const rerun = vi.fn();

    const result = await attemptModelFallback({
      firstResult: MODEL_REJECTION_ERROR,
      failedModel: 'q36-hf',
      source: 'callSite',
      parentModel: 'claude-opus-5-5',
      traceWriter: undefined,
      rerun,
    });

    expect(rerun).not.toHaveBeenCalled();
    expect(result).toBe(MODEL_REJECTION_ERROR);
  });

  it('does NOT retry on namedAgent model rejection', async () => {
    const rerun = vi.fn();

    const result = await attemptModelFallback({
      firstResult: MODEL_REJECTION_ERROR,
      failedModel: 'haiku',
      source: 'namedAgent',
      parentModel: 'claude-opus-5-5',
      traceWriter: undefined,
      rerun,
    });

    expect(rerun).not.toHaveBeenCalled();
    expect(result).toBe(MODEL_REJECTION_ERROR);
  });

  it('does NOT retry on 429 transient error even for default tier', async () => {
    const rerun = vi.fn();

    const result = await attemptModelFallback({
      firstResult: TRANSIENT_ERROR,
      failedModel: 'local',
      source: 'default',
      parentModel: 'claude-opus-5-5',
      traceWriter: undefined,
      rerun,
    });

    expect(rerun).not.toHaveBeenCalled();
    expect(result).toBe(TRANSIENT_ERROR);
  });

  it('does NOT retry when parentModel is undefined', async () => {
    const rerun = vi.fn();

    const result = await attemptModelFallback({
      firstResult: MODEL_REJECTION_ERROR,
      failedModel: 'local',
      source: 'default',
      parentModel: undefined,
      traceWriter: undefined,
      rerun,
    });

    expect(rerun).not.toHaveBeenCalled();
    expect(result).toBe(MODEL_REJECTION_ERROR);
  });

  it('does NOT retry when parentModel === failedModel', async () => {
    const rerun = vi.fn();

    const result = await attemptModelFallback({
      firstResult: MODEL_REJECTION_ERROR,
      failedModel: 'sonnet',
      source: 'default',
      parentModel: 'sonnet',
      traceWriter: undefined,
      rerun,
    });

    expect(rerun).not.toHaveBeenCalled();
    expect(result).toBe(MODEL_REJECTION_ERROR);
  });

  it('passes through success results untouched', async () => {
    const rerun = vi.fn();

    const result = await attemptModelFallback({
      firstResult: SUCCESS_RESULT,
      failedModel: 'local',
      source: 'default',
      parentModel: 'claude-opus-5-5',
      traceWriter: undefined,
      rerun,
    });

    expect(rerun).not.toHaveBeenCalled();
    expect(result).toBe(SUCCESS_RESULT);
  });

  it('retries on floor-tier model rejection', async () => {
    const rerun = vi.fn().mockResolvedValue({ content: 'Floor fallback result.' });

    const result = await attemptModelFallback({
      firstResult: MODEL_REJECTION_ERROR,
      failedModel: 'sonnet',
      source: 'floor',
      parentModel: 'claude-opus-5-5',
      traceWriter: undefined,
      rerun,
    });

    expect(rerun).toHaveBeenCalledWith('claude-opus-5-5');
    expect(result.content).toContain('[model-fallback]');
  });
});
