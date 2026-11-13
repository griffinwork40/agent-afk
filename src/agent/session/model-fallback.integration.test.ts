/**
 * Contract: integration of the main-session fallback model (`models.fallback`) across the REAL
 * AgentSession → ProviderRouter (+ ModelFallbackController) → real provider
 * retry tiers (anthropic-direct, openai-compatible) → fake SDK client.
 *
 * Faked: only the wire (`messages.create` / `chat.completions.create` via the
 * providers' client-factory seams) and the `models.fallback` config read
 * (`getConfiguredFallbackModel`, the router's `getFallbackModel` dep), so no
 * test touches ~/.afk. Every assertion is on what a session consumer sees
 * (OutputEvents, session metadata, the on-disk message journal) plus the
 * request bodies that reached the wire.
 *
 * `autoResumeOnUsageLimit: false` makes "today's behaviour" a fail-fast
 * `paused` + error instead of a 30-minute park, so nothing sleeps.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fallbackModel = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('./fallback-model.js', () => ({ getConfiguredFallbackModel: () => fallbackModel.value }));
vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));

import { AgentSession } from './agent-session.js';
import { resetSlotBindings } from './model-slots.js';
import { loadJournalMessages, readJournalRecords } from '../journal/index.js';
import { useTmpAfkHome } from '../journal/__test-utils__/helpers.js';
import type { AgentConfig } from '../types.js';
import {
  anthropicText, fallbackNotices, installWire, modelNotFound404, occurrences, ofType, runTurn,
  streamedText, terminals, uninstallWire, usageLimit429, type WireLog, type WireStep,
} from './__test-utils__/model-fallback-wire.js';

useTmpAfkHome();

const PRIMARY = 'claude-sonnet-4-6';
const FALLBACK = 'claude-haiku-5-5';

function makeSession(extra: Partial<AgentConfig> = {}): AgentSession {
  return new AgentSession({
    model: PRIMARY,
    apiKey: 'sk-ant-api03-test',
    permissionMode: 'bypassPermissions',
    autoResumeOnUsageLimit: false,
    ...extra,
  });
}

/** Journal records for the session (call after close so the writer flushed). */
function journal(sessionId: string): ReturnType<typeof readJournalRecords> {
  return readJournalRecords(sessionId);
}
/** User messages in the FOLDED journal (what a resume would replay) that contain `text`. */
function foldedUserMessagesContaining(sessionId: string, text: string): number {
  return (loadJournalMessages(sessionId) ?? []).filter(
    (m) => m.role === 'user' && JSON.stringify(m.content).includes(text),
  ).length;
}
function modelSwitchMarks(sessionId: string): Array<Record<string, unknown> | undefined> {
  return journal(sessionId).flatMap((r) => (r.kind === 'mark' && r.label === 'model_switch' ? [r.detail] : []));
}

let wire: WireLog;
function script(fn: (model: string, n: number) => WireStep): void {
  wire = installWire(fn);
}

beforeEach(() => {
  resetSlotBindings();
  fallbackModel.value = FALLBACK;
});
afterEach(() => {
  uninstallWire();
  resetSlotBindings();
  vi.unstubAllEnvs();
});

describe('model fallback — real session + router + anthropic tiers', () => {
  it('1. usage-limit 429 on the first request switches to the fallback and replays once', async () => {
    script((model) => (model === PRIMARY ? usageLimit429() : { events: anthropicText(model, 'fallback answer') }));
    const session = makeSession();
    await session.waitForInitialization();
    const sessionId = session.sessionId ?? '';
    try {
      const events = await runTurn(session, 'hello there');

      expect(ofType(events, 'paused')).toHaveLength(0);
      const notices = fallbackNotices(events);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.fallback).toEqual({ from: PRIMARY, to: FALLBACK, reason: 'usage-limit' });
      expect(streamedText(events)).toContain('fallback answer');
      expect(terminals(events)).toHaveLength(1);
      expect(terminals(events)[0]!.type).toBe('done');

      // Wire: one failed primary request, then one fallback request.
      expect(wire.bodies.map((b) => b.model)).toEqual([PRIMARY, FALLBACK]);
      const replay = wire.bodies[1]!.body;
      expect(occurrences(replay, 'hello there')).toBe(1);
      expect(JSON.stringify(replay['messages'])).not.toContain('usage limit');
      expect((replay['messages'] as unknown[]).filter((m) => (m as { role: string }).role === 'user')).toHaveLength(1);

      expect(session.getSessionMetadata().model).toBe(FALLBACK);
    } finally {
      await session.close();
    }
    expect(sessionId).not.toBe('');
    expect(foldedUserMessagesContaining(sessionId, 'hello there')).toBe(1);
    expect(modelSwitchMarks(sessionId)).toEqual([{ model: FALLBACK }]);
  });

  it('2. a second turn stays on the fallback; a fallback usage limit then pauses as today', async () => {
    script((model, n) => {
      if (model === PRIMARY) return usageLimit429();
      return n === 0 ? { events: anthropicText(model, 'first') } : n === 1 ? { events: anthropicText(model, 'second') } : usageLimit429();
    });
    const session = makeSession();
    await session.waitForInitialization();
    const sessionId = session.sessionId ?? '';
    try {
      const t1 = await runTurn(session, 'turn one');
      expect(fallbackNotices(t1)).toHaveLength(1);

      const t2 = await runTurn(session, 'turn two');
      expect(fallbackNotices(t2)).toHaveLength(0);
      expect(ofType(t2, 'paused')).toHaveLength(0);
      expect(streamedText(t2)).toContain('second');
      expect(terminals(t2)).toHaveLength(1);
      expect(wire.bodies.map((b) => b.model)).toEqual([PRIMARY, FALLBACK, FALLBACK]);
      // No swap back: the only switch notice is turn one's (now history);
      // turn two's own user message carries none.
      const msgs = wire.bodies[2]!.body['messages'] as Array<{ role: string; content: unknown }>;
      expect(occurrences(wire.bodies[2]!.body, 'Your model was switched')).toBe(1);
      expect(JSON.stringify(msgs[msgs.length - 1]!.content)).not.toContain('Your model was switched');

      const t3 = await runTurn(session, 'turn three');
      expect(ofType(t3, 'paused')).toHaveLength(1);
      expect(fallbackNotices(t3)).toHaveLength(0);
      expect(terminals(t3)).toHaveLength(1);
      expect(wire.bodies.map((b) => b.model)).toEqual([PRIMARY, FALLBACK, FALLBACK, FALLBACK]);
      expect(session.getSessionMetadata().model).toBe(FALLBACK);
    } finally {
      await session.close();
    }
    expect(modelSwitchMarks(sessionId)).toHaveLength(1);
  });

  it('3. a 404 naming the primary model switches with reason model-rejected', async () => {
    script((model) => (model === PRIMARY ? modelNotFound404(PRIMARY) : { events: anthropicText(model, 'ok from fallback') }));
    const session = makeSession();
    try {
      const events = await runTurn(session, 'hi');
      const notices = fallbackNotices(events);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.fallback).toEqual({ from: PRIMARY, to: FALLBACK, reason: 'model-rejected' });
      expect(ofType(events, 'error')).toHaveLength(0);
      expect(streamedText(events)).toContain('ok from fallback');
      expect(terminals(events)).toHaveLength(1);
      expect(session.getSessionMetadata().model).toBe(FALLBACK);
    } finally {
      await session.close();
    }
  });

  it('5. no fallback configured: the usage limit pauses exactly as today', async () => {
    fallbackModel.value = undefined;
    script(() => usageLimit429());
    const session = makeSession();
    try {
      const events = await runTurn(session, 'hello');
      expect(ofType(events, 'paused')).toHaveLength(1);
      expect(fallbackNotices(events)).toHaveLength(0);
      expect(terminals(events)).toHaveLength(1);
      expect(wire.bodies.map((b) => b.model)).toEqual([PRIMARY]);
      expect(session.getSessionMetadata().model).toBe(PRIMARY);
    } finally {
      await session.close();
    }
  });

  it('7. a subagent fork with a fallback configured never switches', async () => {
    script(() => usageLimit429());
    const session = makeSession({ isSubagentFork: true });
    try {
      const events = await runTurn(session, 'child work');
      expect(fallbackNotices(events)).toHaveLength(0);
      expect(ofType(events, 'paused')).toHaveLength(1);
      expect(wire.bodies.map((b) => b.model)).toEqual([PRIMARY]);
      expect(session.getSessionMetadata().model).toBe(PRIMARY);
    } finally {
      await session.close();
    }
  });
});
