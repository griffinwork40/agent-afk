/**
 * Unit tests for constructTelegramSession.
 *
 * Proves the Telegram session-construction path wires the default witness trace
 * writer into the AgentSession config, and that AFK_TRACE_DISABLED=1 suppresses
 * it. Uses the `newSession` injection seam to capture the config that would be
 * handed to `new AgentSession(...)` without constructing a real session.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constructTelegramSession, createTelegramTraceWriter } from './construct-session.js';
import type { AgentConfig } from '../agent/types.js';
import type { AgentSession } from '../agent/session.js';
import type { TraceWriter } from '../agent/trace/writer.js';

let tmpHome: string;
let savedHome: string | undefined;
let savedDisabled: string | undefined;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'afk-tg-construct-'));
  savedHome = process.env['AFK_HOME'];
  savedDisabled = process.env['AFK_TRACE_DISABLED'];
  process.env['AFK_HOME'] = tmpHome;
  delete process.env['AFK_TRACE_DISABLED'];
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = savedHome;
  if (savedDisabled === undefined) delete process.env['AFK_TRACE_DISABLED'];
  else process.env['AFK_TRACE_DISABLED'] = savedDisabled;
  await rm(tmpHome, { recursive: true, force: true });
});

describe('constructTelegramSession', () => {
  it('threads a default trace writer into the session config', () => {
    let captured: AgentConfig | undefined;
    constructTelegramSession(
      { model: 'sonnet' },
      { newSession: (c): AgentSession => { captured = c; return {} as unknown as AgentSession; } },
    );
    expect(captured?.traceWriter).toBeDefined();
  });

  it('omits the trace writer when AFK_TRACE_DISABLED=1', () => {
    process.env['AFK_TRACE_DISABLED'] = '1';
    let captured: AgentConfig | undefined;
    constructTelegramSession(
      { model: 'sonnet' },
      { newSession: (c): AgentSession => { captured = c; return {} as unknown as AgentSession; } },
    );
    expect(captured?.traceWriter).toBeUndefined();
  });

  it('preserves base config fields when wiring the trace writer', () => {
    let captured: AgentConfig | undefined;
    constructTelegramSession(
      { model: 'sonnet', maxTurns: 100 },
      { newSession: (c): AgentSession => { captured = c; return {} as unknown as AgentSession; } },
    );
    expect(captured?.model).toBe('sonnet');
    expect(captured?.maxTurns).toBe(100);
  });

  it('lets an operator-supplied baseConfig.traceWriter win (escape-hatch parity)', () => {
    const operatorWriter = { __operator: true } as unknown as TraceWriter;
    let captured: AgentConfig | undefined;
    constructTelegramSession(
      { model: 'sonnet', traceWriter: operatorWriter },
      { newSession: (c): AgentSession => { captured = c; return {} as unknown as AgentSession; } },
    );
    expect(captured?.traceWriter).toBe(operatorWriter);
  });

  it('uses a pre-created traceWriter from deps.traceWriter instead of calling the factory', () => {
    const preCreated = { __preCreated: true } as unknown as TraceWriter;
    const factorySpy = vi.fn();
    let captured: AgentConfig | undefined;
    constructTelegramSession(
      { model: 'sonnet' },
      {
        traceWriter: preCreated,
        createTraceWriter: factorySpy,
        newSession: (c): AgentSession => { captured = c; return {} as unknown as AgentSession; },
      },
    );
    expect(captured?.traceWriter).toBe(preCreated);
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it('suppresses tracing when deps.traceWriter is null (explicit disable)', () => {
    let captured: AgentConfig | undefined;
    constructTelegramSession(
      { model: 'sonnet' },
      {
        traceWriter: null,
        newSession: (c): AgentSession => { captured = c; return {} as unknown as AgentSession; },
      },
    );
    expect(captured?.traceWriter).toBeUndefined();
  });

  it('preserves openaiBaseUrl on the config handed to newSession (parity with baseUrl/surface)', () => {
    // Regression guard: telegram.ts is the only surface that must NOT drop
    // config.openaiBaseUrl when constructing the top-level session — see
    // src/agent/providers/openai-compatible/index.ts effectiveBaseURL
    // resolution (`config.openaiBaseUrl ?? this.providerOpts.baseURL`).
    // This test pins the pass-through at the construct-session seam itself;
    // it does not assert the telegram.ts wiring that sets the field.
    let captured: AgentConfig | undefined;
    constructTelegramSession(
      { model: 'gpt-4o', openaiBaseUrl: 'http://localhost:8080/v1' },
      {
        traceWriter: null,
        newSession: (c): AgentSession => { captured = c; return {} as unknown as AgentSession; },
      },
    );
    expect(captured?.openaiBaseUrl).toBe('http://localhost:8080/v1');
    expect(captured?.surface).toBe('telegram');
  });
});

describe('createTelegramTraceWriter', () => {
  it('returns a TraceWriter when the factory succeeds', () => {
    const fakeWriter = { __fake: true } as unknown as TraceWriter;
    const result = createTelegramTraceWriter(() => ({
      writer: fakeWriter,
      tracePath: '/tmp/fake',
      sessionLabel: 'test-label',
    }));
    expect(result).toBe(fakeWriter);
  });

  it('returns null when the factory returns null (tracing disabled)', () => {
    const result = createTelegramTraceWriter(() => null);
    expect(result).toBeNull();
  });
});
