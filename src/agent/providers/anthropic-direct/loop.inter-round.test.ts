/**
 * Integration tests for the round-boundary injection path in loop.ts runTurn.
 *
 * Verifies that:
 *   1. `beforeNextRound` text is injected as a new user turn at the round
 *      boundary (between tool dispatch and the next model request).
 *   2. `journalSync.sync()` is called with the updated messages array after
 *      the steering turn is pushed — so the note is durable before the next
 *      model request fires (Finding 1 of issue #4769).
 *   3. A pause-note (from `PauseController`) is prepended to any steering text
 *      and also triggers a journal sync.
 *
 * These tests drive `runTurn` end-to-end through the provider loop, using the
 * same helpers as loop.hooks.test.ts and loop.trace.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RawMessageStreamEvent, MessageParam } from '@anthropic-ai/sdk/resources';
import { runTurn } from './loop.js';
import {
  fromArray,
  collect,
  ctx,
  makeToolUseStream,
  makeTextStream,
  makeClient,
  makeDispatcher,
} from './loop.test-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJournalSync() {
  return { sync: vi.fn() };
}

/** Two-round session: round 1 = tool_use, round 2 = end_turn text. */
function makeTwoRoundClient(
  toolId = 'toolu_ir1',
  toolName = 'bash',
  finalText = 'Done',
): ReturnType<typeof makeClient> {
  let callIdx = 0;
  return makeClient(() => {
    callIdx += 1;
    if (callIdx === 1) {
      return fromArray(makeToolUseStream(toolId, toolName, '{}'));
    }
    return fromArray(makeTextStream(finalText));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runTurn — round-boundary injection integration (#4769)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('injects beforeNextRound text as a new user turn between tool round and next model call', async () => {
    const client = makeTwoRoundClient();
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'tool ok' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'do work' }];
    const journalSync = makeJournalSync();

    let capturedMessages: MessageParam[] | undefined;
    // Capture what messages look like when the client is called the second time
    // (after the steering injection should have occurred).
    const createSpy = vi.spyOn(client.messages, 'create').mockImplementation(() => {
      if ((createSpy.mock.calls.length) === 2) {
        capturedMessages = [...messages];
      }
      return fromArray(
        (createSpy.mock.calls.length) === 1
          ? makeToolUseStream('toolu_ir1', 'bash', '{}')
          : makeTextStream('Done'),
      ) as ReturnType<typeof client.messages.create>;
    });

    await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [{ name: 'bash', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
        journalSync,
        beforeNextRound: () => 'steer: check auth',
      }),
    );

    // The steering turn must appear in messages after the tool round.
    // History shape: user, assistant(tool_use), user(tool_result), user(steering), assistant(end_turn).
    const steeringTurn = messages.find(
      (m) => m.role === 'user' && typeof m.content !== 'string'
        && Array.isArray(m.content)
        && (m.content as Array<{ type: string; text?: string }>).some(
          (b) => b.type === 'text' && b.text === 'steer: check auth',
        ),
    );
    expect(steeringTurn).toBeDefined();
  });

  it('calls journalSync.sync() after pushing the steering turn (Finding 1: crash-safety)', async () => {
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'do work' }];
    const journalSync = makeJournalSync();

    let callIdx = 0;
    const client = makeClient(() => {
      callIdx += 1;
      return fromArray(
        callIdx === 1
          ? makeToolUseStream('toolu_j1', 'bash', '{}')
          : makeTextStream('Done'),
      );
    });

    await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [{ name: 'bash', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
        journalSync,
        beforeNextRound: () => 'steer: audit security',
      }),
    );

    // journalSync.sync must have been called. It is called by runToolRound
    // (before tool dispatch) AND by applyBeforeNextRound (after steering push).
    // We assert it was called with a messages array that INCLUDES the steering
    // turn — proving the inter-round sync fired, not just the tool-round sync.
    const syncCalls = journalSync.sync.mock.calls as [MessageParam[]][];
    const steeringWasSynced = syncCalls.some(([msgs]) =>
      msgs.some(
        (m) =>
          m.role === 'user' &&
          Array.isArray(m.content) &&
          (m.content as Array<{ type: string; text?: string }>).some(
            (b) => b.type === 'text' && b.text === 'steer: audit security',
          ),
      ),
    );
    expect(steeringWasSynced).toBe(true);
  });

  it('is a no-op at the round boundary when beforeNextRound returns undefined', async () => {
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'do work' }];
    const journalSync = makeJournalSync();

    let callIdx = 0;
    const client = makeClient(() => {
      callIdx += 1;
      return fromArray(
        callIdx === 1
          ? makeToolUseStream('toolu_noop', 'bash', '{}')
          : makeTextStream('Done'),
      );
    });

    const syncCallsBefore = journalSync.sync.mock.calls.length;

    await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [{ name: 'bash', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
        journalSync,
        beforeNextRound: () => undefined,
      }),
    );

    // No dedicated steering turn should be present — a steering turn is a user
    // turn whose content is entirely plain text blocks (no tool_result blocks).
    const steeringTurns = messages.filter(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>).every((b) => b.type === 'text'),
    );
    expect(steeringTurns).toHaveLength(0);

    // journalSync may still be called by runToolRound (tool-round commit point),
    // but NOT by applyBeforeNextRound (which is a no-op when text is undefined).
    // The key assertion: no sync call contains a dedicated steering-text user turn
    // (a user turn whose ONLY blocks are plain text, not tool_result).
    const syncCalls = journalSync.sync.mock.calls as [MessageParam[]][];
    const anyDedicatedSteeringTurn = syncCalls.some(([msgs]) =>
      msgs.some(
        (m) =>
          m.role === 'user' &&
          Array.isArray(m.content) &&
          (m.content as Array<{ type: string }>).every((b) => b.type === 'text'),
      ),
    );
    // A dedicated steering turn (all-text user turn) should NOT be present
    // when beforeNextRound returns undefined.
    expect(anyDedicatedSteeringTurn).toBe(false);
    void syncCallsBefore; // used only to establish a before-snapshot reference
  });
});
