/**
 * Tests for `handleNoticeEvent` — model-fallback notice updates stats.model
 * and fires onModelFallback; other notice kinds are no-ops.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleNoticeEvent } from './turn-handler.notice.js';
import type { NoticeEvent } from './turn-handler.notice.js';
import type { SessionStats } from '../../slash/types.js';
import type { TurnHandles } from './shared.js';

function makeStats(model = 'opus'): SessionStats {
  return {
    model: model as SessionStats['model'],
    totalTurns: 0,
    totalCostUsd: 0,
    unpricedTurns: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    permissionMode: 'default',
    thinkingUi: 'summary',
  };
}

function makeH(onModelFallback?: (to: string) => void): Pick<TurnHandles, 'onModelFallback'> {
  return { onModelFallback };
}

describe('handleNoticeEvent — model-fallback', () => {
  it('updates stats.model to the fallback target', () => {
    const stats = makeStats('opus');
    const event: NoticeEvent = {
      type: 'notice',
      text: 'opus hit its limit. Continuing on sonnet.',
      kind: 'model-fallback',
      fallback: { from: 'opus', to: 'sonnet', reason: 'usage-limit' },
    };
    handleNoticeEvent(event, stats, makeH());
    expect(stats.model).toBe('sonnet');
  });

  it('fires onModelFallback with the new model', () => {
    const stats = makeStats('opus');
    const cb = vi.fn();
    const event: NoticeEvent = {
      type: 'notice',
      text: 'switching',
      kind: 'model-fallback',
      fallback: { from: 'opus', to: 'haiku', reason: 'credit-exhausted' },
    };
    handleNoticeEvent(event, stats, makeH(cb));
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith('haiku');
  });

  it('is a no-op for truncation notices', () => {
    const stats = makeStats('opus');
    const cb = vi.fn();
    const event: NoticeEvent = { type: 'notice', text: 'truncated', kind: 'truncation' };
    handleNoticeEvent(event, stats, makeH(cb));
    expect(stats.model).toBe('opus');
    expect(cb).not.toHaveBeenCalled();
  });

  it('is a no-op for refusal notices', () => {
    const stats = makeStats('opus');
    const event: NoticeEvent = { type: 'notice', text: 'refused', kind: 'refusal' };
    handleNoticeEvent(event, stats, makeH());
    expect(stats.model).toBe('opus');
  });

  it('is a no-op for model-fallback notice without fallback payload', () => {
    const stats = makeStats('opus');
    const cb = vi.fn();
    const event: NoticeEvent = {
      type: 'notice',
      text: 'no payload',
      kind: 'model-fallback',
    };
    handleNoticeEvent(event, stats, makeH(cb));
    expect(stats.model).toBe('opus');
    expect(cb).not.toHaveBeenCalled();
  });

  it('swallows onModelFallback errors (best-effort)', () => {
    const stats = makeStats('opus');
    const throwing = () => { throw new Error('repaint failed'); };
    const event: NoticeEvent = {
      type: 'notice',
      text: 'switching',
      kind: 'model-fallback',
      fallback: { from: 'opus', to: 'sonnet', reason: 'usage-limit' },
    };
    expect(() => handleNoticeEvent(event, stats, makeH(throwing))).not.toThrow();
    // stats still updated despite callback error
    expect(stats.model).toBe('sonnet');
  });
});
