import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeAgentTask, type AgentTaskContext } from './scheduler.execute-agent-task.js';
import type { AgentSession } from '../session/agent-session.js';
import type { ScheduledTask } from './triggers.js';

const task: ScheduledTask = {
  taskId: 'fallback-task', command: 'run task', trigger: 'cron', cronExpression: '* * * * *',
};
const note = 'Primary unavailable. Continuing on fallback.';

function fakeSession(text: unknown, failure?: Error) {
  return {
    sendMessage: failure
      ? vi.fn().mockRejectedValue(failure)
      : vi.fn().mockResolvedValue({ content: 'done', metadata: { successfulToolNames: [] } }),
    getSessionMetadata: vi.fn().mockReturnValue({ modelFallback: { text } }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/** Convenience wrapper for the common success case using the default note. */
function fakeSessionWithNote(failure?: Error) {
  return fakeSession(note, failure);
}

function makeContext(sessions: ReturnType<typeof fakeSession>[]) {
  const memoryClose = vi.fn();
  const stateClose = vi.fn();
  const dispose = vi.fn();
  let attempt = 0;
  const ctx: AgentTaskContext = {
    options: {},
    queueDir: join(tmpdir(), 'afk-fallback-test-queue'),
    idleDetector: { increment: vi.fn(), decrement: vi.fn() } as never,
    now: () => 0,
    spawnSession: vi.fn(async () => ({
      session: sessions[attempt++] as unknown as AgentSession,
      memoryStore: { close: memoryClose } as never,
      stateStore: { close: stateClose } as never,
      dispose,
      elicitationKey: `fallback-test-${attempt}`,
    })),
    writeTelemetry: vi.fn(),
    retrySleep: async () => {},
  };
  return { ctx, memoryClose, stateClose, dispose };
}

describe('scheduled task fallback diagnostics', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it('captures fallback metadata before teardown when the turn rejects', async () => {
    const failure = new Error('fallback failed');
    const session = fakeSessionWithNote(failure);
    session.close.mockImplementation(async () => {
      session.getSessionMetadata.mockReturnValue({ modelFallback: { text: undefined } });
    });
    const { ctx, memoryClose, stateClose, dispose } = makeContext([session]);

    const record = await executeAgentTask(ctx, task, 'cron');

    expect(record).toMatchObject({ status: 'error', errorMessage: failure.message, modelFallbackNote: note });
    expect(ctx.writeTelemetry).toHaveBeenCalledExactlyOnceWith(record, task);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(`[daemon] task ${task.taskId}: ${note}`);
    expect(session.close).toHaveBeenCalledOnce();
    expect(memoryClose).toHaveBeenCalledOnce();
    expect(stateClose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(ctx.idleDetector.decrement).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, '', 123])('omits absent/invalid fallback metadata (%s)', async (text) => {
    const { ctx } = makeContext([fakeSession(text)]);
    const record = await executeAgentTask(ctx, task, 'cron');
    expect(record.status).toBe('success');
    expect(record).not.toHaveProperty('modelFallbackNote');
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([false, true])('ignores a throwing metadata accessor (failed turn: %s)', async (fails) => {
    const session = fakeSessionWithNote(fails ? new Error('original failure') : undefined);
    session.getSessionMetadata.mockImplementation(() => { throw new Error('metadata failure'); });
    const { ctx } = makeContext([session]);
    const record = await executeAgentTask(ctx, task, 'cron');
    expect(record.status).toBe(fails ? 'error' : 'success');
    expect(record.modelFallbackNote).toBeUndefined();
    if (fails) expect(record.errorMessage).toBe('original failure');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it.each([false, true])('bounds the same note in logs and telemetry (failed turn: %s)', async (fails) => {
    const text = 'word '.repeat(200);
    const expected = `${text.slice(0, 400)}… [truncated]`;
    const { ctx } = makeContext([fakeSession(text, fails ? new Error('turn failure') : undefined)]);
    const record = await executeAgentTask(ctx, task, 'cron');
    expect(record.modelFallbackNote).toBe(expected);
    expect(ctx.writeTelemetry).toHaveBeenCalledWith(record, task, ...(!fails ? [{ responseText: 'done' }] : []));
    expect(console.error).toHaveBeenCalledExactlyOnceWith(`[daemon] task ${task.taskId}: ${expected}`);
  });

  it('redacts secrets before truncation, including a secret crossing the boundary', async () => {
    const secret = 'sk-ant-api03-supersecretkey1234567890abcdef';
    const text = `${'word '.repeat(78)}${secret} ${'word '.repeat(100)}`;
    const { ctx } = makeContext([fakeSession(text)]);
    const record = await executeAgentTask(ctx, task, 'cron');
    expect(record.modelFallbackNote).toContain('[REDACTED');
    expect(record.modelFallbackNote).not.toContain('sk-ant');
    expect(record.modelFallbackNote).toHaveLength(400 + '… [truncated]'.length);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(`[daemon] task ${task.taskId}: ${record.modelFallbackNote}`);
  });

  it('does not truncate a note exactly at the limit', async () => {
    const text = 'word '.repeat(80);
    const { ctx } = makeContext([fakeSession(text)]);
    const record = await executeAgentTask(ctx, task, 'cron');
    expect(record.modelFallbackNote).toBe(text);
  });

  it('retains a failed attempt switch when the retry succeeds without switching', async () => {
    const transient = Object.assign(new Error('temporary failure'), { status: 503 });
    const { ctx } = makeContext([fakeSessionWithNote(transient), fakeSession(undefined)]);
    const record = await executeAgentTask(ctx, { ...task, maxAttempts: 2 }, 'cron');
    expect(record).toMatchObject({ status: 'success', attempts: 2, modelFallbackNote: note });
    expect(ctx.writeTelemetry).toHaveBeenCalledOnce();
  });

  it('uses the latest switch note when retries exhaust', async () => {
    const transient = Object.assign(new Error('temporary failure'), { status: 503 });
    const { ctx } = makeContext([fakeSessionWithNote(transient), fakeSession('Second switch.', transient)]);
    const record = await executeAgentTask(ctx, { ...task, maxAttempts: 2 }, 'cron');
    expect(record).toMatchObject({ status: 'error', attempts: 2, modelFallbackNote: 'Second switch.' });
    expect(ctx.writeTelemetry).toHaveBeenCalledOnce();
  });
});
