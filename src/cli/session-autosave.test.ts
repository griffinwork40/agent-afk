import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionAutosaver, createTurnCollector } from './session-autosave.js';
import { getSessionsDir } from '../paths.js';
import type { OutputEvent } from '../agent/types.js';

let tmp: string;
let saved: string | undefined;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-autosave-test-'));
  saved = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmp;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (saved === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = saved;
});

function readSidecar(id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(getSessionsDir(), `${id}.json`), 'utf8')) as Record<string, unknown>;
}

describe('createSessionAutosaver', () => {
  it('writes a sidecar /resume can list, with source, cwd and auto-derived name', () => {
    const saver = createSessionAutosaver({ model: 'sonnet', source: 'web', cwd: '/w', sessionId: 's-web' });
    saver.saveTurn('fix the login bug please', 'done', { totalCostUsd: 0.1, durationMs: 5 });
    const sc = readSidecar('s-web');
    expect(sc).toMatchObject({ sessionId: 's-web', source: 'web', cwd: '/w', name: 'fix-the-login-bug-please', totalTurns: 1 });
    expect(typeof sc['savedAt']).toBe('number');
    expect(sc['model']).toBe('sonnet');
  });

  it('keeps an explicit name instead of deriving one', () => {
    const saver = createSessionAutosaver({ model: 'sonnet', source: 'daemon', name: 'nightly-job', sessionId: 's-d' });
    saver.saveTurn('a long scheduled prompt', 'ok', undefined);
    expect(readSidecar('s-d')['name']).toBe('nightly-job');
  });

  it('holds turns in memory until a session id is known, then flushes them all', () => {
    const saver = createSessionAutosaver({ model: 'sonnet', source: 'web' });
    saver.saveTurn('first', 'a', undefined);
    expect(fs.existsSync(getSessionsDir()) ? fs.readdirSync(getSessionsDir()) : []).toEqual([]);
    saver.saveTurn('second', 'b', { sessionId: 'late-id' });
    expect(readSidecar('late-id')['totalTurns']).toBe(2);
  });

  it('never throws and reports only the first failure', () => {
    fs.mkdirSync(path.dirname(getSessionsDir()), { recursive: true });
    fs.writeFileSync(getSessionsDir(), 'not a directory');
    const onError = vi.fn();
    const saver = createSessionAutosaver({ model: 'sonnet', source: 'web', sessionId: 'x', onError });
    expect(() => saver.saveTurn('a', 'b', undefined)).not.toThrow();
    saver.saveTurn('c', 'd', undefined);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('createTurnCollector', () => {
  it('collects the final assistant text, done metadata, and tool events', () => {
    const c = createTurnCollector();
    const events = [
      { type: 'chunk', chunk: { type: 'tool_use_detail', toolName: 'bash', toolUseId: 't1', toolInput: 'ls' } },
      { type: 'chunk', chunk: { type: 'tool_result', toolUseId: 't1', content: 'a b', isError: false } },
      { type: 'message', message: { role: 'assistant', content: 'final answer' } },
      { type: 'done', metadata: { totalCostUsd: 0.2 } },
    ] as unknown as OutputEvent[];
    for (const e of events) c.observe(e);
    const r = c.result();
    expect(r.completed).toBe(true);
    expect(r.assistantText).toBe('final answer');
    expect(r.metadata).toEqual({ totalCostUsd: 0.2 });
    expect(r.toolEvents).toEqual([{ toolName: 'bash', toolUseId: 't1', input: 'ls', result: 'a b', isError: false }]);
  });

  it('reports an incomplete turn when no done event arrives', () => {
    const c = createTurnCollector();
    c.observe({ type: 'message', message: { role: 'assistant', content: 'partial' } } as unknown as OutputEvent);
    expect(c.result().completed).toBe(false);
  });
});
