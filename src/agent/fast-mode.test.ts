import { describe, expect, it } from 'vitest';
import {
  FastModeController,
  resolveFastModeStatus,
  OPENAI_FAST_MODEL_FALLBACK,
  type FastModeContext,
} from './fast-mode.js';

const eligible: FastModeContext = {
  resolvedModelId: 'claude-opus-5', providerFamily: 'anthropic-direct',
  hasCustomEndpoint: false, executionPath: 'top-level',
};

const eligibleOpenAI: FastModeContext = {
  resolvedModelId: 'gpt-6-sol', providerFamily: 'openai-compatible',
  hasCustomEndpoint: false, executionPath: 'top-level',
};

describe('FastModeController — Anthropic', () => {
  it('defaults off and snapshots immutably', () => {
    const controller = new FastModeController();
    expect(controller.getPreference()).toBe('off');
    controller.setPreference('on');
    const snapshot = controller.snapshotTurn(eligible);
    controller.setPreference('off');
    expect(snapshot).toMatchObject({ preference: 'on', effective: true });
  });

  it.each(['claude-opus-5', 'claude-opus-5-20260724', 'claude-opus-5-5', 'claude-opus-5-5-20260922', 'claude-opus-4-8', 'claude-opus-4-8-20260201'])('accepts supported anchored Anthropic model %s', (model) => {
    expect(resolveFastModeStatus('on', { ...eligible, resolvedModelId: model }).effective).toBe(true);
  });

  it.each([
    ['claude-sonnet-5', 'unsupported-model'], ['x-claude-opus-5', 'unsupported-model'],
    ['claude-opus-50', 'unsupported-model'], ['claude-opus-4-7', 'unsupported-model'],
  ] as const)('rejects Anthropic model %s', (model, reason) => {
    expect(resolveFastModeStatus('on', { ...eligible, resolvedModelId: model })).toMatchObject({ effective: false, reason });
  });

  it.each([
    [{ hasCustomEndpoint: true }, 'custom-endpoint'],
    [{ executionPath: 'subagent' }, 'excluded-execution-path'],
    [{ executionPath: 'skill' }, 'excluded-execution-path'],
    [{ executionPath: 'compaction' }, 'excluded-execution-path'],
    [{ executionPath: 'summarization' }, 'excluded-execution-path'],
    [{ executionPath: 'one-shot' }, 'excluded-execution-path'],
    [{ executionPath: 'auxiliary' }, 'excluded-execution-path'],
  ] as const)('Anthropic: retains preference while inactive %#', (patch, reason) => {
    const controller = new FastModeController('on');
    expect(controller.resolveStatus({ ...eligible, ...patch } as FastModeContext)).toMatchObject({ preference: 'on', effective: false, reason });
    expect(controller.getPreference()).toBe('on');
    expect(controller.resolveStatus(eligible).effective).toBe(true);
  });
});

describe('FastModeController — OpenAI', () => {
  it('accepts a gpt-6-sol session (catalog-eligible via modelEligible=true)', () => {
    const status = resolveFastModeStatus('on', { ...eligibleOpenAI, modelEligible: true });
    expect(status.effective).toBe(true);
  });

  it('accepts eligible model via fallback regex (gpt-6-sol)', () => {
    const status = resolveFastModeStatus('on', eligibleOpenAI);
    expect(status.effective).toBe(true);
  });

  it.each([
    'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
    'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-reserve',
    'gpt-5.5-20260901', 'gpt-6-sol-2026-09-01',
  ])('accepts OpenAI fast-eligible model %s', (model) => {
    expect(resolveFastModeStatus('on', { ...eligibleOpenAI, resolvedModelId: model }).effective).toBe(true);
  });

  it.each([
    'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3', 'o1', 'codex-auto-review',
  ])('rejects non-fast OpenAI model %s', (model) => {
    const status = resolveFastModeStatus('on', { ...eligibleOpenAI, resolvedModelId: model });
    expect(status.effective).toBe(false);
    expect(status.reason).toBe('unsupported-model');
  });

  it('rejects openai-compatible with custom endpoint', () => {
    const status = resolveFastModeStatus('on', { ...eligibleOpenAI, hasCustomEndpoint: true });
    expect(status.effective).toBe(false);
    expect(status.reason).toBe('custom-endpoint');
  });

  it('rejects openai-compatible subagents (excluded-execution-path)', () => {
    const status = resolveFastModeStatus('on', { ...eligibleOpenAI, executionPath: 'subagent' });
    expect(status.effective).toBe(false);
    expect(status.reason).toBe('excluded-execution-path');
  });

  it('respects modelEligible=false over regex (catalog says no)', () => {
    const status = resolveFastModeStatus('on', {
      ...eligibleOpenAI,
      resolvedModelId: 'gpt-6-sol',
      modelEligible: false,
    });
    expect(status.effective).toBe(false);
    expect(status.reason).toBe('unsupported-model');
  });

  it('unsupported-provider still fires for unknown families', () => {
    const status = resolveFastModeStatus('on', {
      ...eligible,
      providerFamily: 'some-unknown-provider',
    });
    expect(status.effective).toBe(false);
    expect(status.reason).toBe('unsupported-provider');
  });
});

describe('OPENAI_FAST_MODEL_FALLBACK regex', () => {
  it.each([
    'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
    'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-reserve',
    'gpt-5.5-20260901', 'gpt-6-sol-2026-09-01',
  ])('matches %s', (m) => expect(OPENAI_FAST_MODEL_FALLBACK.test(m)).toBe(true));

  it.each([
    'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3', 'gpt-5-mini', 'gpt-5',
    'claude-opus-5', 'codex-auto-review',
  ])('does not match %s', (m) => expect(OPENAI_FAST_MODEL_FALLBACK.test(m)).toBe(false));
});
