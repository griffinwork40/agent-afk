/**
 * Tests for src/cli/slash/_lib/skill-sink-channel.ts
 *
 * Verifies AsyncLocalStorage-based ambient sink channel for subagent
 * progress streaming. Tests context isolation, propagation across awaits,
 * concurrency, nesting, error handling, and return value propagation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SubagentProgressSink, OutputEvent } from '../../agent/types/session-types.js';

describe('skill-sink-channel', () => {
  let runWithSink: <T>(sink: SubagentProgressSink, fn: () => Promise<T>) => Promise<T>;
  let getCurrentSink: () => SubagentProgressSink | undefined;

  beforeEach(async () => {
    const mod = await import('./_lib/skill-sink-channel.js');
    runWithSink = mod.runWithSink;
    getCurrentSink = mod.getCurrentSink;
  });

  it('getCurrentSink() returns undefined outside any runWithSink scope', () => {
    expect(getCurrentSink()).toBeUndefined();
  });

  it('runWithSink(sink, fn) makes the sink available via getCurrentSink() inside fn', async () => {
    const sinkA = vi.fn<(event: OutputEvent, meta: any) => void>();
    const result = await runWithSink(sinkA, async () => {
      return getCurrentSink();
    });
    expect(result).toBe(sinkA);
  });

  it('sink propagates across awaits', async () => {
    const sinkA = vi.fn<(event: OutputEvent, meta: any) => void>();
    await runWithSink(sinkA, async () => {
      await Promise.resolve();
      expect(getCurrentSink()).toBe(sinkA);
    });
  });

  it('concurrent isolation — each parallel context sees its own sink', async () => {
    const sinkA = vi.fn<(event: OutputEvent, meta: any) => void>();
    const sinkB = vi.fn<(event: OutputEvent, meta: any) => void>();

    const [resultA, resultB] = await Promise.all([
      runWithSink(sinkA, async () => {
        await Promise.resolve();
        return getCurrentSink();
      }),
      runWithSink(sinkB, async () => {
        await Promise.resolve();
        return getCurrentSink();
      }),
    ]);

    expect(resultA).toBe(sinkA);
    expect(resultB).toBe(sinkB);
  });

  it('nested calls use the innermost sink', async () => {
    const sinkA = vi.fn<(event: OutputEvent, meta: any) => void>();
    const sinkB = vi.fn<(event: OutputEvent, meta: any) => void>();

    await runWithSink(sinkA, async () => {
      expect(getCurrentSink()).toBe(sinkA);
      await runWithSink(sinkB, async () => {
        expect(getCurrentSink()).toBe(sinkB);
      });
      expect(getCurrentSink()).toBe(sinkA);
    });
  });

  it('errors thrown inside fn propagate unchanged (sync throw)', async () => {
    const sink = vi.fn<(event: OutputEvent, meta: any) => void>();
    const testError = new Error('test sync error');

    await expect(
      runWithSink(sink, async () => {
        throw testError;
      }),
    ).rejects.toBe(testError);
  });

  it('errors thrown inside fn propagate unchanged (rejected promise)', async () => {
    const sink = vi.fn<(event: OutputEvent, meta: any) => void>();
    const testError = new Error('test async error');

    await expect(
      runWithSink(sink, async () => {
        return Promise.reject(testError);
      }),
    ).rejects.toBe(testError);
  });

  it('fn return value is propagated', async () => {
    const sink = vi.fn<(event: OutputEvent, meta: any) => void>();
    const result = await runWithSink(sink, async () => {
      return 42;
    });
    expect(result).toBe(42);
  });
});
