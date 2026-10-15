import { describe, it, expect, vi } from 'vitest';
import { runRemoteAgent, MAX_RECONNECTS, type RemoteRunRequest } from './remote-run.js';
import { PID_MARKER, EXIT_MARKER, EXIT_AFK_NOT_FOUND } from './remote-script.js';
import type { SshRunner, SshExecResult, SshStreamOptions } from './ssh-runner.js';

const ev = (o: unknown): string => JSON.stringify(o);
const MSG = (content: string): string => ev({ type: 'message', message: { content, timestamp: 't' } });
const DONE = ev({ type: 'done', metadata: { durationMs: 5 } });

/** Each element is one follow-stream connection: the lines it delivers. */
type StreamPlan = string[][];

interface Fake {
  runner: SshRunner;
  calls: { kind: string; script: string; stdin?: string }[];
}

function fakeRunner(opts: { launch?: SshExecResult; streams: StreamPlan; errTail?: string }): Fake {
  const calls: Fake['calls'] = [];
  let streamIdx = 0;
  const runner: SshRunner = {
    async exec(_target, script, o = {}) {
      if (script.includes('cat > "$d/prompt"')) {
        calls.push({ kind: 'launch', script, ...(o.stdin !== undefined ? { stdin: o.stdin } : {}) });
        return opts.launch ?? { code: 0, stdout: `${PID_MARKER} 4242\n`, stderr: '' };
      }
      if (script.includes('tail -c 2000')) {
        calls.push({ kind: 'errtail', script });
        return { code: 0, stdout: opts.errTail ?? '', stderr: '' };
      }
      calls.push({ kind: 'cancel', script });
      return { code: 0, stdout: '', stderr: '' };
    },
    async stream(_target, script, o: SshStreamOptions) {
      calls.push({ kind: 'follow', script });
      const lines = opts.streams[streamIdx++] ?? [];
      for (const line of lines) {
        if (o.signal.aborted) break;
        if (o.onLine(line) === 'stop') break;
      }
      return { code: 255, stdout: '', stderr: 'Connection reset' };
    },
  };
  return { runner, calls };
}

const REQ: RemoteRunRequest = { target: 'user@box', prompt: 'do it', runId: 'r1', sessionId: 's1' };
const noSleep = async (): Promise<void> => {};

describe('runRemoteAgent', () => {
  it('launches with the prompt on stdin and returns the last message on done', async () => {
    const f = fakeRunner({ streams: [[MSG('first'), MSG('final answer'), DONE]] });
    const out = await runRemoteAgent(REQ, new AbortController().signal, { runner: f.runner, sleep: noSleep });
    expect(out).toEqual({ kind: 'done', message: 'final answer', pid: 4242, metadata: { durationMs: 5 } });
    expect(f.calls[0]).toMatchObject({ kind: 'launch', stdin: 'do it' });
    expect(f.calls[1]?.script).toContain('tail -n +1 -f');
  });

  it('reports a remote error event', async () => {
    const f = fakeRunner({ streams: [[ev({ type: 'error', error: { message: 'boom' } })]] });
    const out = await runRemoteAgent(REQ, new AbortController().signal, { runner: f.runner, sleep: noSleep });
    expect(out).toMatchObject({ kind: 'error', reason: 'remote agent error: boom' });
  });

  it('reconnects after a dropped connection from the next unseen line', async () => {
    const f = fakeRunner({ streams: [[MSG('a'), 'not json'], [MSG('b'), DONE]] });
    const sleep = vi.fn(noSleep);
    const out = await runRemoteAgent(REQ, new AbortController().signal, { runner: f.runner, sleep });
    expect(out).toMatchObject({ kind: 'done', message: 'b' });
    const follows = f.calls.filter((c) => c.kind === 'follow');
    expect(follows).toHaveLength(2);
    expect(follows[1]?.script).toContain('tail -n +3 -f');
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('gives up after MAX_RECONNECTS consecutive failures without progress', async () => {
    const f = fakeRunner({ streams: [[MSG('partial')]] });
    const out = await runRemoteAgent(REQ, new AbortController().signal, { runner: f.runner, sleep: noSleep });
    expect(out).toMatchObject({ kind: 'lost', pid: 4242, partial: 'partial' });
    expect(f.calls.filter((c) => c.kind === 'follow')).toHaveLength(MAX_RECONNECTS + 1);
  });

  it('reports the stderr tail when the remote process exits without a result', async () => {
    const f = fakeRunner({ streams: [[MSG('x'), EXIT_MARKER]], errTail: 'Error: not logged in' });
    const out = await runRemoteAgent(REQ, new AbortController().signal, { runner: f.runner, sleep: noSleep });
    expect(out).toMatchObject({ kind: 'error', reason: 'remote afk exited without a result: Error: not logged in' });
  });

  it('fails fast when the host is unreachable', async () => {
    const f = fakeRunner({ launch: { code: 255, stdout: '', stderr: 'ssh: connect to host box port 22: Operation timed out' }, streams: [] });
    const out = await runRemoteAgent(REQ, new AbortController().signal, { runner: f.runner, sleep: noSleep });
    expect(out).toMatchObject({ kind: 'error' });
    expect(out.kind === 'error' && out.reason).toContain('host unreachable');
    expect(f.calls.filter((c) => c.kind === 'follow')).toHaveLength(0);
  });

  it('names a missing afk install', async () => {
    const f = fakeRunner({ launch: { code: EXIT_AFK_NOT_FOUND, stdout: '', stderr: 'afk not found' }, streams: [] });
    const out = await runRemoteAgent(REQ, new AbortController().signal, { runner: f.runner, sleep: noSleep });
    expect(out.kind === 'error' && out.reason).toContain('afk is not installed');
  });

  it('cancels the remote process on abort', async () => {
    const ac = new AbortController();
    const f = fakeRunner({ streams: [[MSG('working')]] });
    const runner: SshRunner = {
      ...f.runner,
      async stream(t, s, o) {
        ac.abort();
        return f.runner.stream(t, s, o);
      },
    };
    const out = await runRemoteAgent(REQ, ac.signal, { runner, sleep: noSleep });
    expect(out).toEqual({ kind: 'aborted', pid: 4242 });
    expect(f.calls.some((c) => c.kind === 'cancel' && c.script.includes('kill "$pid"'))).toBe(true);
  });
});
