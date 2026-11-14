/**
 * Integration (part 2): main-session fallback model through the REAL
 * AgentSession → ProviderRouter → provider retry tiers, faking only the SDK
 * clients (see model-fallback.integration.test.ts for the harness contract).
 *
 * Covers: no switch once the turn has progressed (streamed text / a completed
 * tool round), the cross-family Anthropic → OpenAI-compatible switch, and the
 * session-id continuity of a fallback swap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fallbackModel = vi.hoisted(() => ({ value: undefined as string | undefined }));
// Control the configured fallback at its true source (the JSON config read), so
// the REAL fallback-model.ts runs: getConfiguredFallbackModel, the routing
// predicate and the injected-first factory are all exercised, not re-implemented.
vi.mock('../../cli/config/json-tier.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadJsonConfig: () => ({
    config: fallbackModel.value !== undefined ? { fallbackModel: fallbackModel.value } : {},
    modelsPartial: {},
    sourcePath: undefined,
  }),
}));
vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));

import { AgentSession } from './agent-session.js';
import { resetSlotBindings } from './model-slots.js';
import { useTmpAfkHome } from '../journal/__test-utils__/helpers.js';
import {
  anthropicPartialText, anthropicText, anthropicToolUse, fallbackNotices, installWire, occurrences, ofType,
  openaiText, runTurn, streamedText, terminals, uninstallWire, usageLimit429, type WireLog, type WireStep,
} from './__test-utils__/model-fallback-wire.js';

useTmpAfkHome();

const PRIMARY = 'claude-sonnet-4-6';
const FALLBACK = 'claude-haiku-5-5';
const OPENAI_FALLBACK = 'gpt-4o';

function makeSession(): AgentSession {
  return new AgentSession({
    model: PRIMARY,
    apiKey: 'sk-ant-api03-test',
    permissionMode: 'bypassPermissions',
    autoResumeOnUsageLimit: false,
  });
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

describe('model fallback — no switch after progress', () => {
  it('4a. usage limit after streamed text: no switch, today\'s paused', async () => {
    script((model) => ({ events: anthropicPartialText(model, 'partial words'), thenThrow: usageLimit429() }));
    const session = makeSession();
    try {
      const events = await runTurn(session, 'hello');
      expect(streamedText(events)).toContain('partial words');
      expect(fallbackNotices(events)).toHaveLength(0);
      expect(ofType(events, 'paused')).toHaveLength(1);
      expect(terminals(events)).toHaveLength(1);
      expect(wire.bodies.map((b) => b.model)).toEqual([PRIMARY]);
      expect(session.getSessionMetadata().model).toBe(PRIMARY);
    } finally {
      await session.close();
    }
  });

  it('4b. usage limit after a completed tool round: no switch, today\'s paused', async () => {
    script((model, n) =>
      n === 0 ? { events: anthropicToolUse(model, 'no_such_tool_xyz', { a: 1 }) } : usageLimit429(),
    );
    const session = makeSession();
    try {
      const events = await runTurn(session, 'use a tool');
      expect(fallbackNotices(events)).toHaveLength(0);
      expect(ofType(events, 'paused')).toHaveLength(1);
      expect(terminals(events)).toHaveLength(1);
      // Round 1 (tool_use) + round 2 (429); never a fallback request.
      expect(wire.bodies.map((b) => b.model)).toEqual([PRIMARY, PRIMARY]);
      expect(session.getSessionMetadata().model).toBe(PRIMARY);
    } finally {
      await session.close();
    }
  });
});

describe('model fallback — cross-family', () => {
  it('6. Anthropic primary usage limit → OpenAI-compatible fallback answers the same turn', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test');
    fallbackModel.value = OPENAI_FALLBACK;
    script((model) => (model === PRIMARY ? usageLimit429() : { events: openaiText('openai answer') }));
    const session = makeSession();
    try {
      const events = await runTurn(session, 'cross family please');
      expect(ofType(events, 'paused')).toHaveLength(0);
      const notices = fallbackNotices(events);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.fallback).toEqual({ from: PRIMARY, to: OPENAI_FALLBACK, reason: 'usage-limit' });
      expect(streamedText(events)).toContain('openai answer');
      expect(terminals(events)).toHaveLength(1);
      expect(terminals(events)[0]!.type).toBe('done');
      expect(wire.bodies.map((b) => `${b.wire}:${b.model}`)).toEqual([`anthropic:${PRIMARY}`, `openai:${OPENAI_FALLBACK}`]);
      expect(occurrences(wire.bodies[1]!.body, 'cross family please')).toBe(1);
      expect(session.getSessionMetadata().model).toBe(OPENAI_FALLBACK);
    } finally {
      await session.close();
    }
  });
});

describe('model fallback — session identity', () => {
  // A rebuilt inner never reads the turn's sessionId: its id comes only from
  // its config or its provider instance's memo, so a fresh instance mints a
  // new one. The router pins forwarded events to the id the session adopted
  // (provider-router.identity.ts); without it the fallback inner's first
  // assistant.message re-stamped the session's id while the journal stayed
  // under the original. Covers first-turn and later-turn swaps, same and
  // cross family, and a turn-boundary /model swap.
  it('the session id survives a fallback swap', async () => {
    script((model) => (model === PRIMARY ? usageLimit429() : { events: anthropicText(model, 'fallback answer') }));
    const session = makeSession();
    await session.waitForInitialization();
    const before = session.sessionId;
    try {
      const events = await runTurn(session, 'hello there');
      expect(fallbackNotices(events)).toHaveLength(1);
      expect(before).toBeDefined();
      expect(session.sessionId, 'session id must not change across the fallback swap').toBe(before);
    } finally {
      await session.close();
    }
  });

  it('the session id survives a fallback swap on a later turn', async () => {
    let primaryCalls = 0;
    script((model) =>
      model === PRIMARY && primaryCalls++ > 0 ? usageLimit429() : { events: anthropicText(model, `answer from ${model}`) },
    );
    const session = makeSession();
    await session.waitForInitialization();
    const before = session.sessionId;
    try {
      expect(fallbackNotices(await runTurn(session, 'turn one'))).toHaveLength(0);
      expect(session.sessionId).toBe(before);
      expect(fallbackNotices(await runTurn(session, 'turn two'))).toHaveLength(1);
      expect(before).toBeDefined();
      expect(session.sessionId, 'session id must not change across a later-turn fallback swap').toBe(before);
    } finally {
      await session.close();
    }
  });

  it('the session id survives a cross-family fallback swap', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test');
    fallbackModel.value = OPENAI_FALLBACK;
    script((model) => (model === PRIMARY ? usageLimit429() : { events: openaiText('openai answer') }));
    const session = makeSession();
    await session.waitForInitialization();
    const before = session.sessionId;
    try {
      expect(fallbackNotices(await runTurn(session, 'cross family'))).toHaveLength(1);
      expect(before).toBeDefined();
      expect(session.sessionId, 'session id must not change across a cross-family fallback swap').toBe(before);
    } finally {
      await session.close();
    }
  });

  it('the session id survives a turn-boundary cross-family /model swap', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test');
    fallbackModel.value = undefined;
    script((model) => (model === OPENAI_FALLBACK ? { events: openaiText('openai answer') } : { events: anthropicText(model, 'claude answer') }));
    const session = makeSession();
    await session.waitForInitialization();
    const before = session.sessionId;
    try {
      await runTurn(session, 'on claude');
      await session.setModel(OPENAI_FALLBACK);
      expect(streamedText(await runTurn(session, 'on openai'))).toContain('openai answer');
      expect(before).toBeDefined();
      expect(session.sessionId, 'session id must not change across a /model swap').toBe(before);
    } finally {
      await session.close();
    }
  });
});
