import { describe, expect, it } from 'vitest';
import { FastModeController, resolveFastModeStatus, type FastModeContext } from './fast-mode.js';

const eligible: FastModeContext = {
  resolvedModelId: 'claude-opus-5', providerFamily: 'anthropic-direct',
  hasCustomEndpoint: false, executionPath: 'top-level',
};

describe('FastModeController', () => {
  it('defaults off and snapshots immutably', () => {
    const controller = new FastModeController();
    expect(controller.getPreference()).toBe('off');
    controller.setPreference('on');
    const snapshot = controller.snapshotTurn(eligible);
    controller.setPreference('off');
    expect(snapshot).toMatchObject({ preference: 'on', effective: true });
  });

  it.each(['claude-opus-5', 'claude-opus-5-20260724', 'claude-opus-4-8', 'claude-opus-4-8-20260201'])('accepts supported anchored model %s', (model) => {
    expect(resolveFastModeStatus('on', { ...eligible, resolvedModelId: model }).effective).toBe(true);
  });

  it.each([
    ['claude-sonnet-5', 'unsupported-model'], ['x-claude-opus-5', 'unsupported-model'],
    ['claude-opus-50', 'unsupported-model'], ['claude-opus-4-7', 'unsupported-model'],
  ] as const)('rejects %s', (model, reason) => {
    expect(resolveFastModeStatus('on', { ...eligible, resolvedModelId: model })).toMatchObject({ effective: false, reason });
  });

  it.each([
    [{ providerFamily: 'openai-compatible' }, 'unsupported-provider'],
    [{ hasCustomEndpoint: true }, 'custom-endpoint'],
    [{ executionPath: 'subagent' }, 'excluded-execution-path'],
    [{ executionPath: 'skill' }, 'excluded-execution-path'],
    [{ executionPath: 'compaction' }, 'excluded-execution-path'],
    [{ executionPath: 'summarization' }, 'excluded-execution-path'],
    [{ executionPath: 'one-shot' }, 'excluded-execution-path'],
    [{ executionPath: 'auxiliary' }, 'excluded-execution-path'],
  ] as const)('retains preference while inactive %#', (patch, reason) => {
    const controller = new FastModeController('on');
    expect(controller.resolveStatus({ ...eligible, ...patch } as FastModeContext)).toMatchObject({ preference: 'on', effective: false, reason });
    expect(controller.getPreference()).toBe('on');
    expect(controller.resolveStatus(eligible).effective).toBe(true);
  });
});
