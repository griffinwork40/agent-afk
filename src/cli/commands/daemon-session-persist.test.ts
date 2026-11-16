import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeDaemonTurnPersister } from './daemon-session-persist.js';
import { getSessionsDir } from '../../paths.js';

let tmp: string;
let saved: string | undefined;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-daemon-persist-test-'));
  saved = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmp;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (saved === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = saved;
});

describe('makeDaemonTurnPersister', () => {
  it('writes a daemon-sourced sidecar named after the task', () => {
    const persist = makeDaemonTurnPersister('sonnet');
    persist({
      task: { taskId: 'morning-brief', command: 'summarize the repo', trigger: 'cron' },
      sessionId: 'daemon-sess-1',
      cwd: '/repo',
      userInput: 'summarize the repo',
      response: { role: 'assistant', content: 'summary', timestamp: new Date(), metadata: { totalCostUsd: 0.05 } },
    });
    const sc = JSON.parse(fs.readFileSync(path.join(getSessionsDir(), 'daemon-sess-1.json'), 'utf8')) as Record<string, unknown>;
    expect(sc).toMatchObject({ source: 'daemon', name: 'morning-brief', cwd: '/repo', totalTurns: 1, model: 'sonnet' });
    expect((sc['turns'] as Array<{ user: string; assistant: string }>)[0]).toMatchObject({
      user: 'summarize the repo',
      assistant: 'summary',
    });
  });

  // Regression for issue #4841: daemon sidecars must be sealed (endedAt set)
  // so a completed run is distinguishable from a live or crashed one.
  it('seals the sidecar with endedAt and exitReason task-complete after the turn (issue #4841)', () => {
    const before = Date.now();
    const persist = makeDaemonTurnPersister('sonnet');
    persist({
      task: { taskId: 'nightly-job', command: 'do the thing', trigger: 'cron' },
      sessionId: 'daemon-sealed-1',
      cwd: '/repo',
      userInput: 'do the thing',
      response: { role: 'assistant', content: 'done', timestamp: new Date(), metadata: { totalCostUsd: 0.01 } },
    });
    const after = Date.now();
    const sidecarPath = path.join(getSessionsDir(), 'daemon-sealed-1.json');
    const sc = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as Record<string, unknown>;
    expect(typeof sc['endedAt']).toBe('number');
    expect(sc['endedAt'] as number).toBeGreaterThanOrEqual(before);
    expect(sc['endedAt'] as number).toBeLessThanOrEqual(after);
    expect(sc['exitReason']).toBe('task-complete');
  });

  // endedAt must appear before turns in the JSON so the startup-recall head
  // read (first 1 KiB) can detect sealed-ness without loading the full file.
  it('writes endedAt before turns in the sidecar JSON (issue #4841)', () => {
    const persist = makeDaemonTurnPersister('sonnet');
    persist({
      task: { taskId: 'head-order-job', command: 'check order', trigger: 'cron' },
      sessionId: 'daemon-head-order-1',
      cwd: '/repo',
      userInput: 'check order',
      response: { role: 'assistant', content: 'ok', timestamp: new Date(), metadata: { totalCostUsd: 0 } },
    });
    const text = fs.readFileSync(path.join(getSessionsDir(), 'daemon-head-order-1.json'), 'utf8');
    expect(text.indexOf('"endedAt"')).toBeGreaterThan(-1);
    expect(text.indexOf('"endedAt"')).toBeLessThan(text.indexOf('"turns"'));
  });
});
