/** Exercises the production resume callback and real swap, not a local writer getter. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { InMemoryTraceWriter } from '../../../agent/trace/writer.js';
import { createDefaultTraceWriter } from '../../../agent/trace/factory.js';
import { buildAgentSession } from './bootstrap-session-builder.js';
import { createResumeRequest } from './bootstrap-resume.js';
import { createReplPeerNotifier } from './peer-inbox-notifier.js';
import { writeEnvelope } from '../../../agent/peer/inbox-store.js';
import type { InteractiveCtx } from './shared.js';

vi.mock('../../../agent/trace/factory.js', () => ({ createDefaultTraceWriter: vi.fn() }));
vi.mock('./bootstrap-session-builder.js', () => ({ buildAgentSession: vi.fn() }));
vi.mock('../../slash/plugin-skills.js', () => ({ autoRegisterPluginPassthroughs: vi.fn(async () => undefined) }));
let dir: string;
let oldState: string | undefined;
beforeEach(async () => {
  oldState = process.env['AFK_STATE_DIR'];
  dir = await mkdtemp(join(tmpdir(), 'afk-resume-peer-'));
  process.env['AFK_STATE_DIR'] = dir;
});
afterEach(async () => {
  if (oldState === undefined) delete process.env['AFK_STATE_DIR'];
  else process.env['AFK_STATE_DIR'] = oldState;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  vi.clearAllMocks();
});

describe('production resume trace wiring', () => {
  it.each([true, false])('updates ctx and every cascade holder after swap (tracing=%s)', async (tracing) => {
    const oldWriter = new InMemoryTraceWriter();
    const incomingWriter = tracing ? new InMemoryTraceWriter() : undefined;
    const oldId = randomUUID();
    const newId = randomUUID();
    const close = vi.fn(async () => { await oldWriter.seal({ status: 'succeeded', finalCostUsd: 0, finalTurnCount: 0, closedAt: new Date().toISOString() }); });
    const outgoing = { sessionId: oldId, close };
    const incoming = { sessionId: newId, waitForInitialization: vi.fn().mockResolvedValue({}), close: vi.fn() };
    vi.mocked(buildAgentSession).mockReturnValue(incoming as unknown as ReturnType<typeof buildAgentSession>);
    vi.mocked(createDefaultTraceWriter).mockReturnValue(incomingWriter ? { writer: incomingWriter } as ReturnType<typeof createDefaultTraceWriter> : undefined);
    const sessionRef = { current: outgoing };
    const ctx = {
      session: sessionRef, traceWriter: oldWriter,
      stats: { sessionId: oldId, model: 'sonnet', permissionMode: 'default', turns: [], turnCosts: [], turnTokens: [] },
      contextSampler: { attach: vi.fn(), getRatio: () => undefined, getDetail: () => undefined }, statusLine: { repaint: vi.fn() },
      completionWriter: { fn: vi.fn() }, replRenderer: { writeLine: vi.fn() },
      options: {}, getInFlight: () => false,
    } as unknown as InteractiveCtx;
    const notifier = createReplPeerNotifier(ctx);
    ctx.resetPeerNotifier = () => notifier.resetForNewSession();
    const holders = Array.from({ length: 5 }, () => ({ setTraceWriter: vi.fn() }));
    const infra = {
      subagentExecutor: holders[0], skillExecutor: holders[1], composeExecutor: holders[2],
      rootManager: holders[3], backgroundRegistry: { ...holders[4], cancelAll: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Parameters<typeof createResumeRequest>[3];
    const request = createResumeRequest(() => ctx, ctx.session,
      { model: 'sonnet' } as Parameters<typeof createResumeRequest>[2], infra, vi.fn(), 0);
    const result = await request({ id: newId, resumeId: newId, stored: undefined });
    expect(result.ok).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(ctx.session.current).toBe(incoming);
    expect(ctx.traceWriter).toBe(incomingWriter);
    expect(Object.hasOwn(ctx, 'traceWriter')).toBe(tracing);
    for (const holder of [infra.subagentExecutor, infra.skillExecutor, infra.composeExecutor, infra.rootManager, infra.backgroundRegistry]) {
      expect(holder.setTraceWriter).toHaveBeenCalledOnce();
      expect(holder.setTraceWriter).toHaveBeenCalledWith(incomingWriter);
    }
    await writeEnvelope({ v: 1, messageId: randomUUID(), from: { id: 'sender' }, to: newId,
      hop: 0, ts: new Date().toISOString(), body: 'post-resume message' });
    await notifier.scan();
    expect(notifier.drainInjections()).toContain('post-resume message');
    expect(oldWriter.events.map((event) => event.kind)).toEqual(['session_sealed']);
    if (incomingWriter) expect(incomingWriter.events).toEqual([
      expect.objectContaining({ kind: 'peer_message', payload: expect.objectContaining({ action: 'claimed' }) }),
      expect.objectContaining({ kind: 'peer_message', payload: expect.objectContaining({ action: 'injected' }) }),
    ]);
    notifier.dispose();
  });
});
