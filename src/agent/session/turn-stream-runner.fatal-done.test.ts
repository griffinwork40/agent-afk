/**
 * Tests for the fatal-turn `done` invariant (issue #4830).
 *
 * Invariant: exactly one terminal `done` event must be emitted per turn,
 * regardless of whether the turn ends on the success path (`turn.completed`)
 * or a fatal path (provider error, budget ceiling, stream stall).
 *
 * Two cases verified:
 *   A) Success path  — `turn.completed` → exactly one `done` with real metadata.
 *   B) Fatal path    — provider `error` → exactly one `done` with `stopReason: 'error'`.
 *
 * We drive `runStream` via `AgentSession.sendMessageStream` to exercise the
 * real production code path, using the shared `createMockProvider` fixture so
 * the stream infrastructure is wired identically to real sessions.
 *
 * @module agent/session/turn-stream-runner.fatal-done.test
 */

import { describe, it, expect } from 'vitest';
import { AgentSession } from '../session/agent-session.js';
import { createMockProvider } from '../__fixtures__/mock-provider.js';
import type { OutputEvent } from '../types.js';

/**
 * Collect all OutputEvents from one sendMessageStream call.
 * Re-throws if the stream itself throws (not an error event).
 */
async function collectEvents(
  session: AgentSession,
  message: string,
): Promise<OutputEvent[]> {
  const events: OutputEvent[] = [];
  for await (const event of session.sendMessageStream(message)) {
    events.push(event);
  }
  return events;
}

describe('fatal-turn done invariant (#4830)', () => {
  it('Case A: success path emits exactly one done with real metadata', async () => {
    const session = new AgentSession({
      model: 'claude-sonnet-5',
      apiKey: 'test-key',
      provider: createMockProvider({ sessionId: 'test-sess-success' }),
    });

    const events = await collectEvents(session, 'hello');
    const doneEvents = events.filter((e) => e.type === 'done');

    expect(doneEvents).toHaveLength(1);
    const done = doneEvents[0] as Extract<OutputEvent, { type: 'done' }>;
    // Real metadata from handleTurnCompleted — stopReason is provider-supplied.
    expect(done.metadata?.stopReason).toBe('end_turn');
    expect(typeof done.metadata?.durationMs).toBe('number');

    await session.close();
  });

  it('Case B: fatal provider error emits exactly one done with stopReason=error', async () => {
    const session = new AgentSession({
      model: 'claude-sonnet-5',
      apiKey: 'test-key',
      provider: createMockProvider({ sessionId: 'test-sess-fatal' }),
    });

    // 'provider-error' triggers the mock's error path (no turn.completed).
    const events = await collectEvents(session, 'provider-error');
    const doneEvents = events.filter((e) => e.type === 'done');
    const errorEvents = events.filter((e) => e.type === 'error');

    // The error event must still be present (the detail record is kept as-is).
    expect(errorEvents).toHaveLength(1);
    // Exactly one synthetic done must follow the error.
    expect(doneEvents).toHaveLength(1);
    const done = doneEvents[0] as Extract<OutputEvent, { type: 'done' }>;
    expect(done.metadata?.stopReason).toBe('error');
    expect(typeof done.metadata?.durationMs).toBe('number');

    await session.close();
  });

  it('Case B ordering: error event comes before the synthetic done', async () => {
    const session = new AgentSession({
      model: 'claude-sonnet-5',
      apiKey: 'test-key',
      provider: createMockProvider({ sessionId: 'test-sess-order' }),
    });

    const events = await collectEvents(session, 'provider-error');
    const errorIdx = events.findIndex((e) => e.type === 'error');
    const doneIdx = events.findIndex((e) => e.type === 'done');

    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(errorIdx);

    await session.close();
  });
});
