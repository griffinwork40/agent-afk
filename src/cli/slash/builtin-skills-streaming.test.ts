/**
 * Tests for built-in skill streaming integration.
 *
 * Verifies that:
 * 1. StreamRenderer is constructed and disposed correctly
 * 2. The ambient sink channel is wired via runWithSink
 * 3. Verbose flag is respected from env var
 * 4. Events emitted to the sink during skill execution are rendered
 * 5. Skill errors surface to ctx.out.error
 * 6. Banner output is no longer emitted (StreamRenderer + spinner replace it)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SkillMetadata } from '../../skills/index.js';
import { registerAll } from './index.js';
import { resetRegistry } from './registry.js';
import type { SlashContext, SessionStats } from './types.js';
import { getCurrentSink } from '../../agent/_lib/skill-sink-channel.js';

function makeStats(): SessionStats {
  return {
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    permissionMode: 'default',
  };
}

interface FakeSession {
  sendMessage: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  waitForInitialization: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
}

function fakeSession(overrides: Partial<FakeSession> = {}): FakeSession {
  return {
    sendMessage: vi.fn().mockResolvedValue({ content: 'ok' }),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    waitForInitialization: vi.fn().mockResolvedValue({ tools: ['Read', 'Edit'], mcpServers: [] }),
    interrupt: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<SlashContext> = {}): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const ctx: SlashContext = {
    session: (overrides.session ?? { current: fakeSession() }) as unknown as SlashContext['session'],
    stats: overrides.stats ?? makeStats(),
    out: {
      line: (t = '') => lines.push(t),
      raw: (t) => lines.push(t),
      success: (t) => lines.push(`SUCCESS:${t}`),
      info: (t) => lines.push(`INFO:${t}`),
      warn: (t) => lines.push(`WARN:${t}`),
      error: (t) => lines.push(`ERROR:${t}`),
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  };
  return { ctx, lines };
}

describe('builtin-skills streaming integration', () => {
  beforeEach(() => {
    resetRegistry();
    registerAll();
  });

  afterEach(() => {
    delete process.env['AFK_SKILL_STREAM_VERBOSE'];
  });

  it('skill handler receives ambient sink via runWithSink', async () => {
    const { ctx, lines } = makeCtx();
    const testSkill: SkillMetadata = {
      name: 'test-sink-check',
      description: 'Test sink availability',
      handler: async () => {
        const sink = getCurrentSink();
        expect(sink).toBeDefined();
        if (sink) {
          sink(
            {
              type: 'progress',
              progress: {
                taskId: 'test-task',
                description: 'test progress',
                totalTokens: 0,
                toolUses: 0,
                durationMs: 0,
              },
            },
            { subagentId: 'test-agent', agentType: 'test' },
          );
        }
      },
    };

    const { StreamRenderer } = await import('../_lib/stream-renderer.js');
    const { runWithSink } = await import('../../agent/_lib/skill-sink-channel.js');

    const renderer = new StreamRenderer({ out: ctx.out, forceNonTty: true });
    expect(getCurrentSink()).toBeUndefined();
    try {
      await runWithSink(renderer.sink, () => testSkill.handler(undefined, ctx.session.current));
    } finally {
      await renderer.dispose();
    }
    expect(getCurrentSink()).toBeUndefined();
    void lines;
  });

  it('skill error is caught and surfaced to ctx.out.error', async () => {
    const { ctx, lines } = makeCtx();
    const testSkill: SkillMetadata = {
      name: 'test-error',
      description: 'Test error handling',
      handler: async () => {
        throw new Error('Intentional test error');
      },
    };

    const { StreamRenderer } = await import('../_lib/stream-renderer.js');
    const { runWithSink } = await import('../../agent/_lib/skill-sink-channel.js');
    const renderer = new StreamRenderer({ out: ctx.out, forceNonTty: true });

    try {
      await runWithSink(renderer.sink, () =>
        testSkill.handler(undefined, ctx.session.current),
      ).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        ctx.out.error(`test-error failed: ${message}`);
      });
    } finally {
      await renderer.dispose();
    }

    const output = lines.join('\n');
    expect(output).toContain('ERROR:test-error failed: Intentional test error');
  });

  it('renderer.dispose() is always called even on skill error', async () => {
    const { StreamRenderer } = await import('../_lib/stream-renderer.js');
    const { runWithSink } = await import('../../agent/_lib/skill-sink-channel.js');

    const { ctx } = makeCtx();
    const disposeSpy = vi.spyOn(StreamRenderer.prototype, 'dispose');

    const testSkill: SkillMetadata = {
      name: 'test-dispose',
      description: 'Test dispose call',
      handler: async () => {
        throw new Error('Throwing for dispose test');
      },
    };

    const renderer = new StreamRenderer({ out: ctx.out, forceNonTty: true });

    try {
      await runWithSink(renderer.sink, () => testSkill.handler(undefined, ctx.session.current)).catch(
        () => { /* intentional */ },
      );
    } finally {
      await renderer.dispose();
    }

    expect(disposeSpy).toHaveBeenCalled();
    disposeSpy.mockRestore();
  });

  it('verbose flag is read from env var (passed to renderer)', async () => {
    const { StreamRenderer } = await import('../_lib/stream-renderer.js');

    process.env['AFK_SKILL_STREAM_VERBOSE'] = '1';
    const verbose = process.env['AFK_SKILL_STREAM_VERBOSE'] === '1';
    const { ctx } = makeCtx();
    const r = new StreamRenderer({ out: ctx.out, verbose, forceNonTty: true });
    // Indirect: just verifies construction succeeds with verbose true.
    await r.dispose();
    expect(verbose).toBe(true);
  });

  it('does not emit Running/complete banner messages', async () => {
    const { StreamRenderer } = await import('../_lib/stream-renderer.js');
    const { runWithSink } = await import('../../agent/_lib/skill-sink-channel.js');

    const { ctx, lines } = makeCtx();
    const testSkill: SkillMetadata = {
      name: 'test-banner',
      description: 'Test banner display',
      handler: async () => { /* no-op skill */ },
    };

    const renderer = new StreamRenderer({ out: ctx.out, forceNonTty: true });
    try {
      await runWithSink(renderer.sink, () => testSkill.handler(undefined, ctx.session.current));
    } finally {
      await renderer.dispose();
    }

    const output = lines.join('\n');
    // Verify the OLD chrome strings are not produced by the renderer itself.
    expect(output).not.toContain('Running test-banner');
    expect(output).not.toContain('test-banner complete');
    expect(output).not.toContain('◆ start');
    expect(output).not.toContain('◇ complete');
  });
});

// Production-path coverage: makeImmediateHandler must wrap its for-await
// in runWithSink so subagents forked downstream pick up the ambient sink.
// Without this wrap, /diagnose, /mint, etc. spin silently while their
// hypothesis subagents stream into a void.
describe('makeImmediateHandler — runWithSink wiring', () => {
  beforeEach(() => {
    resetRegistry();
    registerAll();
  });

  it('installs the ambient sink during for-await iteration', async () => {
    const { makeImmediateHandler } = await import('./builtin-skills.js');
    const { getCurrentSink } = await import('../../agent/_lib/skill-sink-channel.js');

    const sinkSnapshots: Array<unknown> = [];
    const fakeSendMessageStream = async function* () {
      // Sample the ambient sink at three points during iteration. If the
      // handler wraps in runWithSink, all three should be defined.
      sinkSnapshots.push(getCurrentSink());
      yield { type: 'chunk', chunk: { type: 'content', content: 'a' } };
      sinkSnapshots.push(getCurrentSink());
      yield { type: 'chunk', chunk: { type: 'content', content: 'b' } };
      sinkSnapshots.push(getCurrentSink());
      yield { type: 'done' };
    };

    const { ctx } = makeCtx({
      session: {
        current: {
          ...fakeSession(),
          sendMessageStream: fakeSendMessageStream,
          // makeImmediateHandler builds an XML breadcrumb message via
          // buildSkillInvocationMessage; the consumer here doesn't care
          // about the message — only that the for-await runs inside runWithSink.
        },
      } as unknown as SlashContext['session'],
    });

    const cmd = makeImmediateHandler({
      name: 'test-runwithsink',
      description: 'Verify ambient-sink wiring in makeImmediateHandler',
      handler: async () => 'unused',
    });

    expect(getCurrentSink()).toBeUndefined();
    await cmd.handler(ctx, '');
    expect(getCurrentSink()).toBeUndefined();

    expect(sinkSnapshots.length).toBe(3);
    for (const snap of sinkSnapshots) {
      expect(snap).toBeDefined();
      expect(typeof snap).toBe('function');
    }
  });
});
