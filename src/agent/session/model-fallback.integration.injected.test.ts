/**
 * Integration tests: injected-provider path for `models.fallback` (A1–A6).
 *
 * Contract: when a session injects BOTH a `provider` AND a `providerFactory`,
 * and a fallback model is configured, `buildProviderQuery` routes through
 * ProviderRouter instead of calling the injected provider directly. The
 * injected provider serves its own family; the factory builds any other family.
 *
 * The same fake-wire harness as model-fallback.integration.test.ts is used
 * (SDK clients only are faked; the real AgentSession + ProviderRouter run).
 * The injected provider is a REAL AnthropicDirectProvider so its `query()`
 * method satisfies ProviderRouter's call site.
 *
 * Fallback control: the JSON config read is mocked, so the real
 * fallback-model.ts (routing predicate + injected-first factory) runs.
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
import { AnthropicDirectProvider } from '../providers/anthropic-direct/index.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible/index.js';
import { providerForModel } from '../providers/index.js';
import type { ModelProvider } from '../provider.js';
import {
  anthropicText,
  fallbackNotices,
  installWire,
  ofType,
  openaiText,
  runTurn,
  streamedText,
  terminals,
  uninstallWire,
  usageLimit429,
  modelNotFound404,
  type WireLog,
  type WireStep,
} from './__test-utils__/model-fallback-wire.js';

useTmpAfkHome();

const PRIMARY = 'claude-sonnet-4-6';
const FALLBACK = 'claude-haiku-5-5';
const OPENAI_FALLBACK = 'gpt-4o';
const API_KEY = 'sk-ant-api03-test';

/** Build a real AnthropicDirectProvider (wire-faked at SDK level). */
function makeRealProvider(): AnthropicDirectProvider {
  return new AnthropicDirectProvider();
}

/** Count `query()` calls on one provider INSTANCE (each inner the router builds is one call). */
function countQueries(provider: ModelProvider): { n: number } {
  const counter = { n: 0 };
  const real = provider.query.bind(provider);
  (provider as { query: ModelProvider['query'] }).query = (args) => {
    counter.n += 1;
    return real(args);
  };
  return counter;
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

// ---------------------------------------------------------------------------
// A1: injected + factory + fallback + primary rejects → switch
// ---------------------------------------------------------------------------
describe('A1: injected provider + factory + fallback: 429 → switch', () => {
  it('one model-fallback notice, fallback answer, one done terminal, no error', async () => {
    script((model) =>
      model === PRIMARY
        ? usageLimit429()
        : { events: anthropicText(model, 'answer from fallback') },
    );
    const injected = makeRealProvider();
    // Factory: for the anthropic family (PRIMARY) returns the injected instance;
    // for other models also returns a real provider (the router will call query on it).
    const factory = (_model: string | undefined): AnthropicDirectProvider => injected;

    const session = new AgentSession({
      model: PRIMARY,
      apiKey: API_KEY,
      permissionMode: 'bypassPermissions',
      autoResumeOnUsageLimit: false,
      provider: injected,
      providerFactory: factory,
    });
    try {
      const events = await runTurn(session, 'hello injected');
      const notices = fallbackNotices(events);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.fallback).toMatchObject({ from: PRIMARY });
      expect(notices[0]!.fallback).toMatchObject({ to: FALLBACK });
      expect(notices[0]!.fallback).toMatchObject({ reason: "usage-limit" });
      expect(streamedText(events)).toContain('answer from fallback');
      expect(terminals(events)).toHaveLength(1);
      expect(terminals(events)[0]!.type).toBe('done');
      expect(ofType(events, 'error')).toHaveLength(0);
      // Wire: primary failed, fallback served.
      expect(wire.bodies[0]?.model).toBe(PRIMARY);
      expect(wire.bodies[1]?.model).toBe(FALLBACK);
    } finally {
      await session.close();
    }
  });

  it('A1b: the injected INSTANCE serves the failed attempt and, same family, the replay', async () => {
    script((model) => (model === PRIMARY ? usageLimit429() : { events: anthropicText(model, 'ok') }));
    const injected = makeRealProvider();
    const injectedQueries = countQueries(injected);
    // A factory that does NOT memoize: it builds a new object every call. The
    // session must still use the injected instance for its own family.
    const strangers: Array<{ n: number }> = [];
    const factory = (): AnthropicDirectProvider => {
      const fresh = makeRealProvider();
      strangers.push(countQueries(fresh));
      return fresh;
    };
    const session = new AgentSession({
      model: PRIMARY,
      apiKey: API_KEY,
      permissionMode: 'bypassPermissions',
      autoResumeOnUsageLimit: false,
      provider: injected,
      providerFactory: factory,
    });
    try {
      const events = await runTurn(session, 'identity check');
      expect(fallbackNotices(events)).toHaveLength(1);
      // Two inners were built (failed attempt, replay), both on the injected object.
      expect(injectedQueries.n).toBe(2);
      expect(strangers.every((c) => c.n === 0)).toBe(true);
    } finally {
      await session.close();
    }
  });
});

// ---------------------------------------------------------------------------
// A2: injected + factory + NO fallback → no switch, failure surfaces
// ---------------------------------------------------------------------------
describe('A2: injected + factory + no fallback: failure surfaces directly', () => {
  it('no model-fallback notice; session pauses or errors as today', async () => {
    fallbackModel.value = undefined;
    script(() => usageLimit429());
    const injected = makeRealProvider();
    const factory = (): AnthropicDirectProvider => injected;
    const session = new AgentSession({
      model: PRIMARY,
      apiKey: API_KEY,
      permissionMode: 'bypassPermissions',
      autoResumeOnUsageLimit: false,
      provider: injected,
      providerFactory: factory,
    });
    try {
      const events = await runTurn(session, 'hello no-fallback');
      expect(fallbackNotices(events)).toHaveLength(0);
      expect(ofType(events, 'paused').length + ofType(events, 'error').length).toBeGreaterThanOrEqual(1);
      // Only one wire call: the injected provider, no replay.
      expect(wire.bodies.map((b) => b.model)).toEqual([PRIMARY]);
    } finally {
      await session.close();
    }
  });
});

// ---------------------------------------------------------------------------
// A3: injected + fallback configured + NO providerFactory → no switch
// ---------------------------------------------------------------------------
describe('A3: injected + no factory + fallback: no switch', () => {
  it('no model-fallback notice; failure surfaces directly (protects Telegram/web/ACP)', async () => {
    script(() => usageLimit429());
    const injected = makeRealProvider();
    const session = new AgentSession({
      model: PRIMARY,
      apiKey: API_KEY,
      permissionMode: 'bypassPermissions',
      autoResumeOnUsageLimit: false,
      provider: injected,
      // providerFactory intentionally absent
    });
    try {
      const events = await runTurn(session, 'hello no-factory');
      expect(fallbackNotices(events)).toHaveLength(0);
      expect(ofType(events, 'paused').length + ofType(events, 'error').length).toBeGreaterThanOrEqual(1);
      expect(wire.bodies.map((b) => b.model)).toEqual([PRIMARY]);
    } finally {
      await session.close();
    }
  });
});

// ---------------------------------------------------------------------------
// A4: injected + factory + fallback + isSubagentFork: true → no switch
// ---------------------------------------------------------------------------
describe('A4: isSubagentFork blocks the fallback switch', () => {
  it('no model-fallback notice when isSubagentFork is true', async () => {
    script(() => usageLimit429());
    const injected = makeRealProvider();
    const factory = (): AnthropicDirectProvider => injected;
    const session = new AgentSession({
      model: PRIMARY,
      apiKey: API_KEY,
      permissionMode: 'bypassPermissions',
      autoResumeOnUsageLimit: false,
      provider: injected,
      providerFactory: factory,
      isSubagentFork: true,
    });
    try {
      const events = await runTurn(session, 'child work');
      expect(fallbackNotices(events)).toHaveLength(0);
      expect(ofType(events, 'paused').length + ofType(events, 'error').length).toBeGreaterThanOrEqual(1);
      expect(wire.bodies.map((b) => b.model)).toEqual([PRIMARY]);
    } finally {
      await session.close();
    }
  });
});

// ---------------------------------------------------------------------------
// A5: cross-family. The injected Anthropic provider serves the failed attempt;
// the provider the FACTORY builds for the fallback's family serves the replay.
// ---------------------------------------------------------------------------
describe('A5: cross-family fallback is served by the factory-built provider', () => {
  it('injected serves the failed attempt once; the factory-built OpenAI provider serves the replay', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test');
    fallbackModel.value = OPENAI_FALLBACK;
    script((model) => (model === PRIMARY ? usageLimit429() : { events: openaiText('openai answer') }));

    const injected = makeRealProvider();
    const injectedQueries = countQueries(injected);
    const openai = new OpenAICompatibleProvider();
    const openaiQueries = countQueries(openai);
    const factoryCalls: Array<string | undefined> = [];
    const factory = (model: string | undefined): ModelProvider => {
      factoryCalls.push(model);
      return providerForModel(model ?? PRIMARY) === 'openai-compatible' ? openai : injected;
    };

    const session = new AgentSession({
      model: PRIMARY,
      apiKey: API_KEY,
      permissionMode: 'bypassPermissions',
      autoResumeOnUsageLimit: false,
      provider: injected,
      providerFactory: factory,
    });
    try {
      const events = await runTurn(session, 'cross family injected');
      const notices = fallbackNotices(events);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.fallback).toEqual({ from: PRIMARY, to: OPENAI_FALLBACK, reason: 'usage-limit' });
      expect(streamedText(events)).toContain('openai answer');
      expect(terminals(events)).toHaveLength(1);
      expect(terminals(events)[0]!.type).toBe('done');
      expect(factoryCalls).toContain(OPENAI_FALLBACK);
      expect(injectedQueries.n).toBe(1);
      expect(openaiQueries.n).toBe(1);
      expect(wire.bodies.map((b) => `${b.wire}:${b.model}`)).toEqual([`anthropic:${PRIMARY}`, `openai:${OPENAI_FALLBACK}`]);
    } finally {
      await session.close();
    }
  });
});

// ---------------------------------------------------------------------------
// A6: session metadata has modelFallback after a switch
// ---------------------------------------------------------------------------
describe('A6: session metadata.modelFallback after switch', () => {
  it('metadata has from/to/reason/text after a 429 switch', async () => {
    script((model) =>
      model === PRIMARY
        ? usageLimit429()
        : { events: anthropicText(model, 'meta test answer') },
    );
    const injected = makeRealProvider();
    const factory = (): AnthropicDirectProvider => injected;
    const session = new AgentSession({
      model: PRIMARY,
      apiKey: API_KEY,
      permissionMode: 'bypassPermissions',
      autoResumeOnUsageLimit: false,
      provider: injected,
      providerFactory: factory,
    });
    try {
      await runTurn(session, 'metadata test');
      const meta = session.getSessionMetadata().modelFallback;
      expect(meta).toBeDefined();
      expect(meta!.from).toBe(PRIMARY);
      expect(meta!.to).toBe(FALLBACK);
      expect(meta!.reason).toBe('usage-limit');
      expect(typeof meta!.text).toBe('string');
      expect(meta!.text.length).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  it('metadata.modelFallback is absent when no switch occurred', async () => {
    script((model) => ({ events: anthropicText(model, 'no switch') }));
    const injected = makeRealProvider();
    const factory = (): AnthropicDirectProvider => injected;
    const session = new AgentSession({
      model: PRIMARY,
      apiKey: API_KEY,
      permissionMode: 'bypassPermissions',
      autoResumeOnUsageLimit: false,
      provider: injected,
      providerFactory: factory,
    });
    try {
      await runTurn(session, 'no switch test');
      expect(session.getSessionMetadata().modelFallback).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('metadata.modelFallback is set after a 404 model-rejected switch', async () => {
    script((model) =>
      model === PRIMARY
        ? modelNotFound404(PRIMARY)
        : { events: anthropicText(model, 'ok') },
    );
    const injected = makeRealProvider();
    const factory = (): AnthropicDirectProvider => injected;
    const session = new AgentSession({
      model: PRIMARY,
      apiKey: API_KEY,
      permissionMode: 'bypassPermissions',
      autoResumeOnUsageLimit: false,
      provider: injected,
      providerFactory: factory,
    });
    try {
      await runTurn(session, 'rejected switch');
      const meta = session.getSessionMetadata().modelFallback;
      expect(meta).toBeDefined();
      expect(meta!.reason).toBe('model-rejected');
    } finally {
      await session.close();
    }
  });
});
