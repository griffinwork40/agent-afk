/**
 * Tests for D: formatTaskCompletion shows/hides modelFallbackNote,
 * and the execute-agent-task path reads modelFallback.text from session metadata.
 *
 * D1: formatTaskCompletion includes the modelFallbackNote line when present.
 * D2: formatTaskCompletion produces no extra line when modelFallbackNote absent.
 * D3: executeAgentTask telemetry record includes modelFallbackNote when session
 *     metadata has modelFallback.text, AND console.error logs the note.
 * D4: executeAgentTask telemetry record has no modelFallbackNote when absent.
 *
 * The execute-agent-task harness is built minimally: we stub spawnSession to
 * return a fake AgentSession whose sendMessage resolves immediately, and whose
 * getSessionMetadata() returns a controlled value. We also stub writeTelemetry
 * to capture the record.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatTaskCompletion } from './daemon.js';
import { executeAgentTask, type AgentTaskContext } from '../../agent/daemon/scheduler.execute-agent-task.js';
import type { TelemetryRecord } from '../../agent/daemon/scheduler.js';
import type { ScheduledTask } from '../../agent/daemon/triggers.js';

// ---------------------------------------------------------------------------
// D1 / D2: formatTaskCompletion
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<TelemetryRecord> = {}): TelemetryRecord {
  return {
    taskId: 'test-task',
    command: 'do something',
    trigger: 'cron',
    triggeredAt: new Date(0).toISOString(),
    durationMs: 500,
    status: 'success',
    responseExcerpt: 'done',
    ...overrides,
  };
}

describe('D1/D2: formatTaskCompletion — modelFallbackNote', () => {
  it('D1: includes modelFallbackNote as its own line when present', () => {
    const note = 'Your model was switched from claude-sonnet-4-6 to claude-haiku-5-5 (usage-limit).';
    const result = formatTaskCompletion(makeRecord({ modelFallbackNote: note }), { responseText: 'done' });
    expect(result).toContain(note);
    // It should appear as a distinct line (not embedded in another word).
    const lines = result.split('\n');
    expect(lines.some((l) => l === note)).toBe(true);
  });

  it('D2: no modelFallbackNote line when field is absent', () => {
    const result = formatTaskCompletion(makeRecord(), { responseText: 'done' });
    expect(result).not.toContain('switched');
    expect(result).not.toContain('modelFallback');
    // Baseline: has success header.
    expect(result).toContain('✅ daemon task: test-task (success)');
  });

  it('D2b: no modelFallbackNote line when field is explicitly undefined', () => {
    const result = formatTaskCompletion(
      makeRecord({ modelFallbackNote: undefined }),
      { responseText: 'done' },
    );
    // Should produce only the standard lines.
    const lines = result.split('\n').filter((l) => l !== '');
    // header, trigger line, response text = 3 lines
    expect(lines).toHaveLength(3);
  });

  it('D1b: modelFallbackNote appears AFTER gateRecoveryNote', () => {
    const recoveryNote = 'Gate recovered after 1 block.';
    const fallbackNote = 'Switched to haiku.';
    const result = formatTaskCompletion(
      makeRecord({ gateRecoveryNote: recoveryNote, modelFallbackNote: fallbackNote }),
      { responseText: 'done' },
    );
    const idxRecovery = result.indexOf(recoveryNote);
    const idxFallback = result.indexOf(fallbackNote);
    expect(idxRecovery).toBeGreaterThanOrEqual(0);
    expect(idxFallback).toBeGreaterThan(idxRecovery);
  });
});

// ---------------------------------------------------------------------------
// D3 / D4: executeAgentTask reads modelFallback.text from session metadata
// ---------------------------------------------------------------------------

/** Minimal fake AgentSession that resolves sendMessage immediately. */
function makeFakeSession(modelFallbackText: string | undefined) {
  return {
    sendMessage: vi.fn().mockResolvedValue({
      content: 'task response',
      metadata: { successfulToolNames: [] },
    }),
    getSessionMetadata: vi.fn().mockReturnValue(
      modelFallbackText !== undefined
        ? { modelFallback: { from: 'a', to: 'b', reason: 'usage-limit', text: modelFallbackText } }
        : {},
    ),
    close: vi.fn().mockResolvedValue(undefined),
    sessionId: 'fake-session-id',
    cwd: '/tmp',
    abortSignal: new AbortController().signal,
  };
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    taskId: 'task-1',
    command: 'run test',
    trigger: 'cron',
    cronExpression: '* * * * *',
    executor: 'agent',
    notifyOn: 'failure',
    ...overrides,
  };
}

function makeCtx(fakeSession: ReturnType<typeof makeFakeSession>): {
  ctx: AgentTaskContext;
  capturedRecords: TelemetryRecord[];
} {
  const capturedRecords: TelemetryRecord[] = [];
  const ctx: AgentTaskContext = {
    options: {},
    queueDir: '/tmp/queue',
    idleDetector: { increment: vi.fn(), decrement: vi.fn() } as never,
    now: () => Date.now(),
    spawnSession: vi.fn().mockResolvedValue({
      session: fakeSession,
      memoryStore: { close: vi.fn() } as never,
      stateStore: { close: vi.fn() } as never,
      mcpManager: undefined,
      dispose: vi.fn(),
      elicitationKey: 'ek-1',
    }),
    writeTelemetry: (record) => {
      capturedRecords.push(record as TelemetryRecord);
    },
  };
  return { ctx, capturedRecords };
}

describe('D3/D4: executeAgentTask — modelFallbackNote in telemetry', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('D3: telemetry record includes modelFallbackNote and console.error logs it', async () => {
    const noteText = 'Your model was switched from claude-sonnet-4-6 to claude-haiku-5-5 (usage-limit). Run /model claude-sonnet-4-6 to switch back.';
    const session = makeFakeSession(noteText);
    const { ctx, capturedRecords } = makeCtx(session);
    const task = makeTask();

    await executeAgentTask(ctx, task, 'cron');

    expect(capturedRecords).toHaveLength(1);
    expect(capturedRecords[0]!.modelFallbackNote).toBe(noteText);

    // console.error should have been called with the daemon log line.
    const errorCalls = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(errorCalls.some((msg: string) => msg.includes('[daemon] task task-1:') && msg.includes(noteText))).toBe(true);
  });

  it('D4: telemetry record has no modelFallbackNote when session had no switch', async () => {
    const session = makeFakeSession(undefined);
    const { ctx, capturedRecords } = makeCtx(session);
    const task = makeTask();

    await executeAgentTask(ctx, task, 'cron');

    expect(capturedRecords).toHaveLength(1);
    expect(capturedRecords[0]!.modelFallbackNote).toBeUndefined();

    // console.error must NOT have been called with a [daemon] task fallback line.
    const errorCalls = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(errorCalls.some((msg: string) => msg.includes('[daemon] task task-1:'))).toBe(false);
  });
});
