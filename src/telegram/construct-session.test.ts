/**
 * Unit tests for constructTelegramSession.
 *
 * Proves the Telegram session-construction path wires the default witness trace
 * writer into the AgentSession config, and that AFK_TRACE_DISABLED=1 suppresses
 * it. Uses the `newSession` injection seam to capture the config that would be
 * handed to `new AgentSession(...)` without constructing a real session.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constructTelegramSession } from './construct-session.js';
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
});
