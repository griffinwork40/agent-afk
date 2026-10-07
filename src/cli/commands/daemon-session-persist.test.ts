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
});
