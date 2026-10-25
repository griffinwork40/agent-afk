/**
 * Outcome recording for AI ghost text (terminal-compositor.ghost.record.ts):
 * accept / word-accept / dismiss reach `engine.recordOutcome` for AI-sourced
 * ghosts only, and history (Tier-1) ghosts are never recorded.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { TerminalCompositor } from './terminal-compositor.js';
import type { SuggestEngine, SuggestContext } from './terminal-compositor.js';
import type { SuggestionRecord } from './input/suggest.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
  emit(event: string, ...args: unknown[]): boolean;
};

function makeStdout(): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true;
  s.columns = 80;
  s.rows = 24;
  return s;
}

function makeStdin(): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = vi.fn((raw: boolean) => {
    s.isRaw = raw;
    return s;
  });
  return s;
}

function makeCtx(): SuggestContext {
  return {
    model: 'claude-haiku',
    baseUrl: undefined,
    cwd: '/tmp',
    getHistory: () => [],
    getDropdownTopCandidate: () => null,
    getTranscriptTail: () => '',
    getRecentCommands: () => [],
    llmEnabled: () => false,
  };
}

function makeEngine(opts: {
  tier1?: string | null;
  tier2?: string | null;
  prompt?: string | null;
}): SuggestEngine & { records: SuggestionRecord[] } {
  let prompt: string | null = null;
  const records: SuggestionRecord[] = [];
  return {
    records,
    getDeterministicGhost: () => opts.tier1 ?? null,
    getGhost: () =>
      opts.tier2 === undefined
        ? new Promise<string | null>(() => {})
        : Promise.resolve(opts.tier2),
    async primePromptSuggestion() {
      prompt = opts.prompt ?? null;
    },
    peekPromptSuggestion: () => prompt,
    clearPromptSuggestion() {
      prompt = null;
    },
    recordOutcome(rec) {
      records.push(rec);
    },
    dispose() {},
  };
}

function type(stdin: MockStdin, text: string): void {
  for (const ch of text) stdin.emit('keypress', ch, { name: ch, sequence: ch });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('AI ghost outcome recording', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;

  beforeEach(() => {
    stdout = makeStdout();
    stdin = makeStdin();
  });

  it('Tab on an LLM completion records accepted with the typed buffer', async () => {
    const engine = makeEngine({ tier2: 'hello world' });
    const c = new TerminalCompositor({ stdout, stdin, suggest: { engine, getContext: makeCtx } });
    await c.arm();
    type(stdin, 'hel');
    await flush();
    expect(c.activeGhost).toBe('hello world');

    stdin.emit('keypress', '\t', { name: 'tab', sequence: '\t' });

    expect(engine.records).toEqual([
      { event: 'accepted', source: 'completion', text: 'hello world', buffer: 'hel' },
    ]);
    c.disarm();
  });

  it('Tab on a history (Tier-1) ghost records nothing', async () => {
    const engine = makeEngine({ tier1: 'hello world' });
    const c = new TerminalCompositor({ stdout, stdin, suggest: { engine, getContext: makeCtx } });
    await c.arm();
    type(stdin, 'hel');

    stdin.emit('keypress', '\t', { name: 'tab', sequence: '\t' });

    expect(c.getBuffer().text).toBe('hello world');
    expect(engine.records).toEqual([]);
    c.disarm();
  });

  it('Tab on the empty-prompt proposal records accepted with source prompt', async () => {
    const engine = makeEngine({ prompt: 'run the tests' });
    const c = new TerminalCompositor({ stdout, stdin, suggest: { engine, getContext: makeCtx } });
    await c.arm();
    await engine.primePromptSuggestion(makeCtx());
    c.updateGhost();

    stdin.emit('keypress', '\t', { name: 'tab', sequence: '\t' });

    expect(engine.records).toEqual([
      { event: 'accepted', source: 'prompt', text: 'run the tests' },
    ]);
    c.disarm();
  });

  it('word-accepting the proposal records word_accepted, then accepted when consumed', async () => {
    const engine = makeEngine({ prompt: 'run tests' });
    const c = new TerminalCompositor({ stdout, stdin, suggest: { engine, getContext: makeCtx } });
    await c.arm();
    await engine.primePromptSuggestion(makeCtx());
    c.updateGhost();

    stdin.emit('keypress', undefined, { name: 'right' });
    stdin.emit('keypress', undefined, { name: 'right' });

    expect(c.getBuffer().text).toBe('run tests');
    expect(engine.records.map((r) => [r.event, r.source])).toEqual([
      ['word_accepted', 'prompt'],
      ['accepted', 'prompt'],
    ]);
    // prompt-sourced records never carry `buffer` (only completion records do)
    expect(engine.records[0]).not.toHaveProperty('buffer');
    expect(engine.records[1]).not.toHaveProperty('buffer');
    c.disarm();
  });

  it('Esc at an empty idle prompt records dismissed', async () => {
    const engine = makeEngine({ prompt: 'run the tests' });
    const c = new TerminalCompositor({ stdout, stdin, suggest: { engine, getContext: makeCtx } });
    await c.arm();
    c.setInputMode('idle');
    await engine.primePromptSuggestion(makeCtx());
    c.updateGhost();

    stdin.emit('keypress', undefined, { name: 'escape' });

    expect(engine.records).toEqual([
      { event: 'dismissed', source: 'prompt', text: 'run the tests' },
    ]);
    c.disarm();
  });

  it('a stale completion note does not label a later history ghost', async () => {
    // LLM ghost for "hel", then the user edits to a buffer where Tier-1 owns
    // the ghost: accepting that one must not be attributed to the model.
    const engine = makeEngine({ tier2: 'hello world' });
    const c = new TerminalCompositor({ stdout, stdin, suggest: { engine, getContext: makeCtx } });
    await c.arm();
    type(stdin, 'hel');
    await flush();
    expect(c.activeGhost).toBe('hello world');

    engine.getDeterministicGhost = () => 'help me';
    stdin.emit('keypress', undefined, { name: 'backspace' });
    type(stdin, 'l');
    expect(c.activeGhost).toBe('help me');
    stdin.emit('keypress', '\t', { name: 'tab', sequence: '\t' });

    expect(engine.records).toEqual([]);
    c.disarm();
  });
});
