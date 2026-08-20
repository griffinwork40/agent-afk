/**
 * Unit tests for plain-mode progress parity:
 *
 * 1. Plain mode emits a completion line per tool call with duration.
 * 2. Plain mode emits subagent start/finish lines.
 * 3. TTY + plain erases the TTFB waiting line before the first token.
 * 4. Piped (non-TTY) mode suppresses the TTFB waiting line entirely.
 * 5. TTY non-plain mode: TTFB waiting line is NOT emitted (compositor path).
 *
 * Strategy: set AFK_PLAIN_OUTPUT in process.env for the plain-output path
 * tests, then restore it. The plain-progress helpers read the env var via
 * isPlainOutputRequested() from config/env.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CompletionWriter } from './shared.js';
import {
  createPlainProgressState,
  recordToolStart,
  emitPlainToolCompletion,
  observePlainSubagentEvent,
  type PlainProgressState,
} from './plain-progress.js';
import {
  createTurnTtfbState,
  emitPlainTtfbWaiting,
  type TurnTtfbState,
} from './turn-handler.ttfb.js';

// ---- helpers ---------------------------------------------------------------

function makeMockWriter(): { writer: CompletionWriter; lines: string[] } {
  const lines: string[] = [];
  const writer: CompletionWriter = {
    fn: (line) => lines.push(line),
    idleFn: (line) => lines.push(line),
  };
  return { writer, lines };
}

function makeMockStdout(isTTY: boolean): NodeJS.WriteStream {
  const written: string[] = [];
  return {
    isTTY,
    write: (s: string) => { written.push(s); return true; },
    _written: written,
  } as unknown as NodeJS.WriteStream;
}

// Strip ANSI escape sequences from a string for readable assertions.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
}

// ---- setup / teardown ------------------------------------------------------

let savedPlain: string | undefined;

beforeEach(() => {
  savedPlain = process.env['AFK_PLAIN_OUTPUT'];
});

afterEach(() => {
  if (savedPlain === undefined) {
    delete process.env['AFK_PLAIN_OUTPUT'];
  } else {
    process.env['AFK_PLAIN_OUTPUT'] = savedPlain;
  }
});

// ---- 1. Tool completion lines ----------------------------------------------

describe('plain-mode tool completion', () => {
  it('emits a completion line with duration when plain output is active', () => {
    process.env['AFK_PLAIN_OUTPUT'] = '1';
    const state: PlainProgressState = createPlainProgressState();
    const { writer, lines } = makeMockWriter();

    // Simulate a tool start.
    const toolUseId = 'tu-001';
    recordToolStart(state, {
      type: 'tool_use_detail',
      toolUseId,
      toolName: 'read_file',
      toolInput: '{"path": "/foo"}',
    });

    // Simulate completion.
    emitPlainToolCompletion(
      state,
      { type: 'tool_result', toolUseId, content: 'ok', isError: false },
      'read_file',
      writer,
    );

    expect(lines).toHaveLength(1);
    const plain = stripAnsi(lines[0]!);
    expect(plain).toMatch(/read_file/);
    expect(plain).toMatch(/ok/);
    // Duration is always present (even 0s) when start was recorded.
    expect(plain).toMatch(/\d+s|0s/);
  });

  it('does NOT emit a completion line when plain output is off', () => {
    delete process.env['AFK_PLAIN_OUTPUT'];
    const state: PlainProgressState = createPlainProgressState();
    const { writer, lines } = makeMockWriter();

    recordToolStart(state, {
      type: 'tool_use_detail',
      toolUseId: 'tu-002',
      toolName: 'bash',
      toolInput: '{}',
    });
    emitPlainToolCompletion(
      state,
      { type: 'tool_result', toolUseId: 'tu-002', content: 'out', isError: false },
      'bash',
      writer,
    );

    expect(lines).toHaveLength(0);
  });

  it('marks an errored tool result accordingly', () => {
    process.env['AFK_PLAIN_OUTPUT'] = '1';
    const state: PlainProgressState = createPlainProgressState();
    const { writer, lines } = makeMockWriter();

    recordToolStart(state, {
      type: 'tool_use_detail',
      toolUseId: 'tu-003',
      toolName: 'write_file',
      toolInput: '{}',
    });
    emitPlainToolCompletion(
      state,
      { type: 'tool_result', toolUseId: 'tu-003', content: 'error text', isError: true },
      'write_file',
      writer,
    );

    expect(lines).toHaveLength(1);
    const plain = stripAnsi(lines[0]!);
    expect(plain).toMatch(/err/);
  });

  it('emits no duration when no matching start was recorded', () => {
    process.env['AFK_PLAIN_OUTPUT'] = '1';
    const state: PlainProgressState = createPlainProgressState();
    const { writer, lines } = makeMockWriter();

    emitPlainToolCompletion(
      state,
      { type: 'tool_result', toolUseId: 'orphan', content: 'ok', isError: false },
      'edit_file',
      writer,
    );

    expect(lines).toHaveLength(1);
    const plain = stripAnsi(lines[0]!);
    // No duration segment (no · Xs in the middle).
    expect(plain).not.toMatch(/· \d+s/);
    expect(plain).toMatch(/edit_file/);
  });
});

// ---- 2. Subagent lifecycle lines -------------------------------------------

describe('plain-mode subagent lifecycle', () => {
  it('emits a start line on the first event from a new subagent', () => {
    process.env['AFK_PLAIN_OUTPUT'] = '1';
    const state: PlainProgressState = createPlainProgressState();
    const { writer, lines } = makeMockWriter();

    observePlainSubagentEvent(
      state,
      { type: 'chunk', chunk: { type: 'content', content: 'hi' } },
      { subagentId: 'sa-1', agentType: 'research-agent' },
      writer,
    );

    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0]!)).toMatch(/worker research-agent started/);
  });

  it('emits a finish line on the done event', () => {
    process.env['AFK_PLAIN_OUTPUT'] = '1';
    const state: PlainProgressState = createPlainProgressState();
    const { writer, lines } = makeMockWriter();
    const meta = { subagentId: 'sa-2', agentType: 'general-purpose' };

    // First event → start.
    observePlainSubagentEvent(
      state,
      { type: 'chunk', chunk: { type: 'content', content: 'work' } },
      meta,
      writer,
    );
    // Done event → finish.
    observePlainSubagentEvent(
      state,
      { type: 'done' },
      meta,
      writer,
    );

    expect(lines).toHaveLength(2);
    expect(stripAnsi(lines[0]!)).toMatch(/started/);
    const finish = stripAnsi(lines[1]!);
    expect(finish).toMatch(/general-purpose/);
    expect(finish).toMatch(/done/);
  });

  it('emits a failed line on the error event', () => {
    process.env['AFK_PLAIN_OUTPUT'] = '1';
    const state: PlainProgressState = createPlainProgressState();
    const { writer, lines } = makeMockWriter();
    const meta = { subagentId: 'sa-3', agentType: 'scout' };

    observePlainSubagentEvent(
      state,
      { type: 'chunk', chunk: { type: 'content', content: 'x' } },
      meta,
      writer,
    );
    observePlainSubagentEvent(
      state,
      { type: 'error', error: new Error('boom') },
      meta,
      writer,
    );

    expect(lines).toHaveLength(2);
    expect(stripAnsi(lines[1]!)).toMatch(/failed/);
  });

  it('does NOT emit lines when plain output is off', () => {
    delete process.env['AFK_PLAIN_OUTPUT'];
    const state: PlainProgressState = createPlainProgressState();
    const { writer, lines } = makeMockWriter();

    observePlainSubagentEvent(
      state,
      { type: 'done' },
      { subagentId: 'sa-4', agentType: 'test' },
      writer,
    );

    expect(lines).toHaveLength(0);
  });
});

// ---- 3. TTFB waiting line — TTY + plain: erase on first token --------------

describe('TTFB waiting line — TTY + plain', () => {
  it('emits the waiting line on TTY + plain', () => {
    process.env['AFK_PLAIN_OUTPUT'] = '1';
    const state: TurnTtfbState = createTurnTtfbState(Date.now());
    const { writer, lines } = makeMockWriter();
    const stdout = makeMockStdout(true);

    emitPlainTtfbWaiting(writer, stdout, state);

    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0]!)).toMatch(/waiting for response/);
    expect(state.waitingLineEmitted).toBe(true);
    expect(state.plainHooks).toBeDefined();
  });

  it('erases the waiting line via plainHooks.onFirstContent on TTY + plain', () => {
    process.env['AFK_PLAIN_OUTPUT'] = '1';
    const state: TurnTtfbState = createTurnTtfbState(Date.now());
    const { writer } = makeMockWriter();
    const stdout = makeMockStdout(true);
    const writtenToStdout = (stdout as unknown as { _written: string[] })._written;

    emitPlainTtfbWaiting(writer, stdout, state);
    expect(state.waitingLineEmitted).toBe(true);

    // Simulate first content arrival via the hooks object.
    state.plainHooks!.onFirstContent(stdout);

    expect(state.waitingLineEmitted).toBe(false);
    // The erase sequence should have been written to stdout.
    expect(writtenToStdout).toContain('\r\x1b[2K');
  });

  it('onFirstContent is a no-op when waiting line was not emitted', () => {
    process.env['AFK_PLAIN_OUTPUT'] = '1';
    const state: TurnTtfbState = createTurnTtfbState(Date.now());
    const { writer } = makeMockWriter();
    const stdout = makeMockStdout(true);
    const writtenToStdout = (stdout as unknown as { _written: string[] })._written;

    // Create hooks WITHOUT emitting (don't call emitPlainTtfbWaiting).
    emitPlainTtfbWaiting(writer, stdout, state);
    // Manually reset flag as if plain mode was disabled mid-call.
    state.waitingLineEmitted = false;

    state.plainHooks!.onFirstContent(stdout);

    // No erase sequence should have been written.
    expect(writtenToStdout.some((s) => s.includes('\x1b[2K'))).toBe(false);
  });
});

// ---- 4. Piped (non-TTY): suppress TTFB waiting line -----------------------

describe('TTFB waiting line — non-TTY (piped)', () => {
  it('suppresses the waiting line when stdout is not a TTY', () => {
    process.env['AFK_PLAIN_OUTPUT'] = '1';
    const state: TurnTtfbState = createTurnTtfbState(Date.now());
    const { writer, lines } = makeMockWriter();
    const stdout = makeMockStdout(false); // piped / non-TTY

    emitPlainTtfbWaiting(writer, stdout, state);

    // Line must NOT be emitted.
    expect(lines).toHaveLength(0);
    expect(state.waitingLineEmitted).toBe(false);
  });
});

// ---- 5. TTY non-plain: TTFB waiting line not emitted -----------------------

describe('TTFB waiting line — TTY non-plain', () => {
  it('does NOT emit the waiting line when plain output is not requested', () => {
    delete process.env['AFK_PLAIN_OUTPUT'];
    const state: TurnTtfbState = createTurnTtfbState(Date.now());
    const { writer, lines } = makeMockWriter();
    const stdout = makeMockStdout(true); // real TTY

    emitPlainTtfbWaiting(writer, stdout, state);

    // The compositor path is active; plain-mode waiting line must not appear.
    expect(lines).toHaveLength(0);
    expect(state.waitingLineEmitted).toBe(false);
    expect(state.plainHooks).toBeUndefined();
  });
});
