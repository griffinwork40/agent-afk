/**
 * Tests for runSkillDispatchTurn — the shared core that owns the arm →
 * preflight → build → stream → dispose sequence for skill-slash dispatch.
 *
 * Coverage:
 *   - Payload shape: breadcrumb + instruction (and image tail when attached)
 *   - Preflight callback: invoked inside the armed renderer; manifest
 *     prepended to payload when provided
 *   - Preflight failure isolation: thrown callback → falls back to no
 *     manifest, dispatch still runs
 *   - Renderer lifecycle: dispose always runs, even on stream error
 *   - Errors propagate to caller for per-skill formatting
 */

import { describe, it, expect, vi } from 'vitest';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { SkillMetadata } from '../../../skills/index.js';
import type { ImageAttachment } from '../../input/attachments.js';
import type { SlashContext, SessionStats } from '../types.js';
import type { OutputEvent } from '../../../agent/types.js';
import { runSkillDispatchTurn } from './run-skill-dispatch-turn.js';

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
    planMode: false,
  };
}

function fakeContent(text: string): OutputEvent {
  return {
    type: 'chunk',
    chunk: { type: 'content', content: text },
  };
}

interface FakeSession {
  sendMessageStream: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
}

function fakeSession(events: OutputEvent[] = []): FakeSession {
  async function* gen(): AsyncIterable<OutputEvent> {
    for (const e of events) yield e;
  }
  return {
    sendMessageStream: vi.fn().mockImplementation(() => gen()),
    interrupt: vi.fn().mockResolvedValue(undefined),
  };
}

function makeCtx(session: FakeSession): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const ctx: SlashContext = {
    session: { current: session } as unknown as SlashContext['session'],
    stats: makeStats(),
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

function makeSkill(name = 'mint'): SkillMetadata {
  return {
    name,
    description: `${name} skill`,
    handler: async () => undefined,
  };
}

describe('runSkillDispatchTurn — payload shape', () => {
  it('sends a 2-block payload when no preflight and no attachments', async () => {
    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);

    await runSkillDispatchTurn(ctx, {
      skillName: 'mint',
      skillMeta: makeSkill('mint'),
      args: 'idea',
    });

    expect(session.sendMessageStream).toHaveBeenCalledTimes(1);
    const msg = session.sendMessageStream.mock.calls[0]?.[0] as ContentBlockParam[];
    expect(msg).toHaveLength(2);
    expect(msg[0]).toMatchObject({ type: 'text' });
    expect((msg[0] as { type: 'text'; text: string }).text).toContain('mint');
  });

  it('appends image blocks at the tail when attachments are passed', async () => {
    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);
    const img: ImageAttachment = {
      id: 'img-1',
      mediaType: 'image/png',
      bytes: Buffer.from('data'),
      sizeBytes: 4,
    };

    await runSkillDispatchTurn(ctx, {
      skillName: 'forge',
      skillMeta: makeSkill('forge'),
      args: 'idea',
      attachments: [img],
    });

    const msg = session.sendMessageStream.mock.calls[0]?.[0] as ContentBlockParam[];
    expect(msg).toHaveLength(3);
    expect(msg[2]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    });
  });

  it('prepends manifest block when preflight returns a string', async () => {
    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);
    const manifest = '<preflight-context skill="review">data</preflight-context>';

    await runSkillDispatchTurn(ctx, {
      skillName: 'review',
      skillMeta: makeSkill('review'),
      args: '',
      preflight: async () => manifest,
    });

    const msg = session.sendMessageStream.mock.calls[0]?.[0] as ContentBlockParam[];
    expect(msg).toHaveLength(3);
    expect(msg[0]).toEqual({ type: 'text', text: manifest });
  });

  it('stays at 2 blocks when preflight returns undefined', async () => {
    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);

    await runSkillDispatchTurn(ctx, {
      skillName: 'mint',
      skillMeta: makeSkill('mint'),
      args: '',
      preflight: async () => undefined,
    });

    const msg = session.sendMessageStream.mock.calls[0]?.[0] as ContentBlockParam[];
    expect(msg).toHaveLength(2);
  });

  it('preserves [manifest, breadcrumb, instruction, image] ordering with both', async () => {
    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);
    const manifest = '<m>x</m>';
    const img: ImageAttachment = {
      id: 'img-1',
      mediaType: 'image/jpeg',
      bytes: Buffer.from('j'),
      sizeBytes: 1,
    };

    await runSkillDispatchTurn(ctx, {
      skillName: 'review',
      skillMeta: makeSkill('review'),
      args: '277',
      preflight: async () => manifest,
      attachments: [img],
    });

    const msg = session.sendMessageStream.mock.calls[0]?.[0] as ContentBlockParam[];
    expect(msg).toHaveLength(4);
    expect(msg[0]).toEqual({ type: 'text', text: manifest });
    expect(msg[1]).toMatchObject({ type: 'text' });
    expect(msg[2]).toMatchObject({ type: 'text' });
    expect(msg[3]).toMatchObject({ type: 'image', source: { media_type: 'image/jpeg' } });
  });
});

describe('runSkillDispatchTurn — preflight failure isolation', () => {
  it('swallows synchronous throws from preflight and falls back to 2-block dispatch', async () => {
    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);

    await runSkillDispatchTurn(ctx, {
      skillName: 'mint',
      skillMeta: makeSkill('mint'),
      args: '',
      preflight: async () => {
        throw new Error('preflight broke');
      },
    });

    expect(session.sendMessageStream).toHaveBeenCalledTimes(1);
    const msg = session.sendMessageStream.mock.calls[0]?.[0] as ContentBlockParam[];
    // 2 blocks — no manifest prepended on failure
    expect(msg).toHaveLength(2);
  });

  it('preflight is awaited (async preflight is consumed)', async () => {
    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);
    const order: string[] = [];

    await runSkillDispatchTurn(ctx, {
      skillName: 'review',
      skillMeta: makeSkill('review'),
      args: '',
      preflight: async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push('preflight-done');
        return undefined;
      },
    });

    order.push('after-dispatch');
    expect(order).toEqual(['preflight-done', 'after-dispatch']);
  });
});

describe('runSkillDispatchTurn — error propagation', () => {
  it('stream errors propagate to the caller for per-skill formatting', async () => {
    const session = fakeSession();
    session.sendMessageStream.mockImplementation(async function* () {
      throw new Error('stream blew up');
    });
    const { ctx } = makeCtx(session);

    await expect(
      runSkillDispatchTurn(ctx, {
        skillName: 'mint',
        skillMeta: makeSkill('mint'),
        args: '',
      }),
    ).rejects.toThrow('stream blew up');
  });
});

// ---------------------------------------------------------------------------
// Soft-stop (ESC) tests — mirrors runTurn's ESC soft-stop suite
// (turn-handler.test.ts) but scoped to the skill-dispatch loop. Closes the
// gap PR #546 called out as deferred: ESC during a /skill turn was silently
// dropped because `runSkillDispatchTurn` never wired `setSoftStopHandler`.
//
// Tests assert against session state (interrupt called, handler cleared),
// NOT against the renderer string — visible-success-with-silent-stop is
// exactly the failure mode the soft-stop UX exists to prevent.
// ---------------------------------------------------------------------------

describe('runSkillDispatchTurn — ESC soft-stop', () => {
  /**
   * Build a fake session whose stream fires the installed soft-stop
   * handler after `fireAfterIndex` events have been yielded. The
   * handler-install plumbing receives the installed closure via
   * `ctx.setSoftStopHandler` (mirrors how `surface.setSoftStopHandler`
   * stores it on the InputSurface).
   */
  function makeSoftStopCtx(events: OutputEvent[], fireAfterIndex: number): {
    ctx: SlashContext;
    session: FakeSession;
    setSoftStopHandler: ReturnType<typeof vi.fn>;
  } {
    let installedHandler: (() => void) | null = null;
    let yieldedCount = 0;

    async function* gen(): AsyncIterable<OutputEvent> {
      for (const e of events) {
        if (yieldedCount === fireAfterIndex && installedHandler) {
          installedHandler();
        }
        yield e;
        yieldedCount++;
      }
    }
    const session: FakeSession = {
      sendMessageStream: vi.fn().mockImplementation(() => gen()),
      interrupt: vi.fn().mockResolvedValue(undefined),
    };

    const setSoftStopHandler = vi.fn((handler: (() => void) | null) => {
      installedHandler = handler;
    });

    const { ctx } = makeCtx(session);
    ctx.setSoftStopHandler = setSoftStopHandler;
    return { ctx, session, setSoftStopHandler };
  }

  it('calls session.interrupt() when soft-stop fires mid-stream', async () => {
    const events: OutputEvent[] = [
      fakeContent('partial'),
      fakeContent('more partial'),
    ];
    const { ctx, session } = makeSoftStopCtx(events, /*fireAfterIndex*/ 0);

    await runSkillDispatchTurn(ctx, {
      skillName: 'mint',
      skillMeta: makeSkill('mint'),
      args: '',
    });

    // Core assertion: ESC was honored — stream halted via interrupt.
    expect(session.interrupt).toHaveBeenCalledTimes(1);
  });

  it('clears the soft-stop handler in finally after dispatch completes', async () => {
    const { ctx, setSoftStopHandler } = makeSoftStopCtx([fakeContent('ok')], -1);

    await runSkillDispatchTurn(ctx, {
      skillName: 'mint',
      skillMeta: makeSkill('mint'),
      args: '',
    });

    // setSoftStopHandler is called twice: install at start, null in finally.
    const calls = setSoftStopHandler.mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0]?.[0]).toBeTypeOf('function');
    expect(calls[1]?.[0]).toBeNull();
  });

  it('does NOT call session.interrupt() on a normal dispatch (no ESC)', async () => {
    const { ctx, session } = makeSoftStopCtx(
      [fakeContent('full'), fakeContent('answer')],
      /*fireAfterIndex*/ -1, // never fire
    );

    await runSkillDispatchTurn(ctx, {
      skillName: 'mint',
      skillMeta: makeSkill('mint'),
      args: '',
    });

    expect(session.interrupt).not.toHaveBeenCalled();
  });

  it('clears handler even when the stream throws', async () => {
    // Regression: finally MUST clear the handler even on stream errors,
    // otherwise the next /skill dispatch inherits a stale closure that
    // flips an out-of-scope flag.
    const setSoftStopHandler = vi.fn();
    const session = fakeSession();
    session.sendMessageStream.mockImplementation(async function* () {
      throw new Error('boom');
    });
    const { ctx } = makeCtx(session);
    ctx.setSoftStopHandler = setSoftStopHandler;

    await expect(
      runSkillDispatchTurn(ctx, {
        skillName: 'mint',
        skillMeta: makeSkill('mint'),
        args: '',
      }),
    ).rejects.toThrow('boom');

    // Final call must clear to null even on the error path.
    const calls = setSoftStopHandler.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1]?.[0]).toBeNull();
  });
});
