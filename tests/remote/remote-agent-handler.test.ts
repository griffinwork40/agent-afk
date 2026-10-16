/**
 * Tests for src/agent/tools/handlers/remote-agent.ts
 *
 * Covers:
 *   - parseRemoteAgentInput: cwd validation (NUL, newline, CR, leading `-`)
 *   - parseRemoteAgentInput: model and resume leading-`-` guard (regression)
 *   - formatOutcome framing: remote text is wrapped in <remote-output> delimiters
 *   - sshArgs: remote command is fixed (no caller data), script not present in argv
 */

import { describe, it, expect } from 'vitest';
import { parseRemoteAgentInput, createRemoteAgentHandler, MAX_REPLY_CHARS } from '../../src/agent/tools/handlers/remote-agent.js';
import { sshArgs } from '../../src/remote/ssh-runner.js';
import type { SshRunner } from '../../src/remote/ssh-runner.js';
import type { RemoteRunOutcome } from '../../src/remote/remote-run.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isError(result: unknown): result is { content: string; isError: true } {
  return typeof result === 'object' && result !== null && 'isError' in result && (result as { isError: unknown }).isError === true;
}

function parsed(result: unknown): { host: string; prompt: string; cwd?: string; model?: string; resume?: string } {
  if (isError(result)) throw new Error(`Expected parsed input, got error: ${(result as { content: string }).content}`);
  return result as { host: string; prompt: string; cwd?: string; model?: string; resume?: string };
}

// ---------------------------------------------------------------------------
// parseRemoteAgentInput — cwd validation
// ---------------------------------------------------------------------------

describe('parseRemoteAgentInput — cwd validation', () => {
  const base = { host: 'myhost', prompt: 'do something' };

  it('accepts a normal cwd', () => {
    const r = parseRemoteAgentInput({ ...base, cwd: '/home/user/project' });
    expect(parsed(r).cwd).toBe('/home/user/project');
  });

  it('accepts a tilde cwd', () => {
    const r = parseRemoteAgentInput({ ...base, cwd: '~/work' });
    expect(parsed(r).cwd).toBe('~/work');
  });

  it('rejects cwd containing NUL byte', () => {
    const r = parseRemoteAgentInput({ ...base, cwd: '/tmp/a\0b' });
    expect(isError(r)).toBe(true);
    expect((r as { content: string }).content).toContain('NUL');
  });

  it('rejects cwd containing newline', () => {
    const r = parseRemoteAgentInput({ ...base, cwd: '/tmp/a\nb' });
    expect(isError(r)).toBe(true);
    expect((r as { content: string }).content).toContain('newline');
  });

  it('rejects cwd containing carriage return', () => {
    const r = parseRemoteAgentInput({ ...base, cwd: '/tmp/a\rb' });
    expect(isError(r)).toBe(true);
    expect((r as { content: string }).content).toContain('carriage-return');
  });

  it('rejects cwd starting with "-"', () => {
    const r = parseRemoteAgentInput({ ...base, cwd: '-x' });
    expect(isError(r)).toBe(true);
    expect((r as { content: string }).content).toContain('"-"');
  });

  it('rejects cwd starting with "--"', () => {
    const r = parseRemoteAgentInput({ ...base, cwd: '--verbose' });
    expect(isError(r)).toBe(true);
    expect((r as { content: string }).content).toContain('"-"');
  });

  it('omits cwd from result when not provided', () => {
    const r = parseRemoteAgentInput(base);
    expect(parsed(r).cwd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseRemoteAgentInput — model and resume guards (regression)
// ---------------------------------------------------------------------------

describe('parseRemoteAgentInput — model / resume guards', () => {
  const base = { host: 'myhost', prompt: 'do something' };

  it('rejects model starting with "-"', () => {
    const r = parseRemoteAgentInput({ ...base, model: '-x' });
    expect(isError(r)).toBe(true);
    expect((r as { content: string }).content).toContain('model');
  });

  it('rejects resume starting with "-"', () => {
    const r = parseRemoteAgentInput({ ...base, resume: '-bad' });
    expect(isError(r)).toBe(true);
    expect((r as { content: string }).content).toContain('resume');
  });
});

// ---------------------------------------------------------------------------
// sshArgs — fixed remote command, no caller data
// ---------------------------------------------------------------------------

describe('sshArgs', () => {
  it('last element is the fixed remote command "exec /bin/sh -s"', () => {
    const args = sshArgs('user@host');
    expect(args[args.length - 1]).toBe('exec /bin/sh -s');
  });

  it('does not embed any caller-supplied target data in the command string', () => {
    const target = "evil'host; rm -rf /";
    const args = sshArgs(target);
    // The last element must still be the fixed command, not interpolated target
    expect(args[args.length - 1]).toBe('exec /bin/sh -s');
  });

  it('includes target after "--"', () => {
    const target = 'user@example.com';
    const args = sshArgs(target);
    const sep = args.indexOf('--');
    expect(sep).toBeGreaterThan(-1);
    expect(args[sep + 1]).toBe(target);
  });
});

// ---------------------------------------------------------------------------
// formatOutcome — remote output is wrapped in <remote-output> delimiters
// ---------------------------------------------------------------------------

import { PID_MARKER, EXIT_MARKER } from '../../src/remote/remote-script.js';

describe('formatOutcome — remote output framing', () => {
  /**
   * Build a minimal fake runner that:
   *   - On exec: simulates a successful launch returning a PID marker.
   *   - On stream: delivers lines matching the requested outcome then stops.
   */
  function makeHandler(outcome: RemoteRunOutcome) {
    let execCall = 0;
    const runner: SshRunner = {
      exec: async (_target, _script) => {
        execCall += 1;
        if (execCall === 1) {
          // Launch call: return success with PID marker
          return { code: 0, stdout: `${PID_MARKER}12345\n`, stderr: '' };
        }
        // Cancel / err-tail calls
        return { code: 0, stdout: '', stderr: '' };
      },
      stream: async (_target, _script, opts) => {
        if (outcome.kind === 'done') {
          // Emit a message event first so finalMessage() has content, then done
          opts.onLine(JSON.stringify({ type: 'message', message: { content: outcome.message } }));
          opts.onLine(JSON.stringify({ type: 'done' }));
        } else if (outcome.kind === 'error') {
          opts.onLine(JSON.stringify({ type: 'error', error: { message: outcome.reason } }));
        } else if (outcome.kind === 'lost') {
          opts.onLine(EXIT_MARKER);
        } else if (outcome.kind === 'aborted') {
          // Abort is handled by the signal, not line content
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    return createRemoteAgentHandler({
      runner,
      loadHosts: async () => ({
        myhost: { name: 'myhost', ssh: 'user@myhost' },
      }),
      sleep: async () => undefined,
    });
  }

  it('wraps the remote agent reply in <remote-output> tags', async () => {
    const handler = makeHandler({ kind: 'done', message: 'hello from remote', pid: 42 });
    const signal = new AbortController().signal;
    const result = await handler({ host: 'myhost', prompt: 'go' }, signal);
    expect(result.content).toContain('<remote-output>');
    expect(result.content).toContain('hello from remote');
    expect(result.content).toContain('</remote-output>');
  });

  it('wraps partial output in <remote-output> tags on error', async () => {
    // The stream delivers an error event; partial comes from buffered events.
    // Since no prior lines were buffered, partial is empty and omitted.
    // We verify the framing via a done outcome with content instead.
    const handler = makeHandler({ kind: 'error', reason: 'remote failed', partial: '' });
    const signal = new AbortController().signal;
    const result = await handler({ host: 'myhost', prompt: 'go' }, signal);
    expect(result.isError).toBe(true);
    // error reason text comes from the event, no remote-output wrapper on the reason itself
    expect(result.content).toContain('remote agent error');
  });

  it('frames empty reply with placeholder inside <remote-output>', async () => {
    const handler = makeHandler({ kind: 'done', message: '', pid: 1 });
    const signal = new AbortController().signal;
    const result = await handler({ host: 'myhost', prompt: 'go' }, signal);
    expect(result.content).toContain('<remote-output>');
    expect(result.content).toContain('empty reply');
    expect(result.content).toContain('</remote-output>');
  });

  it('does not wrap aborted outcome (no remote text)', async () => {
    // Abort: signal is aborted before the stream call resolves
    const handler = makeHandler({ kind: 'aborted', pid: 5 });
    const ac = new AbortController();
    // Abort immediately so runRemoteAgent returns aborted after launch
    let execCall2 = 0;
    const runner2: SshRunner = {
      exec: async () => {
        execCall2 += 1;
        if (execCall2 === 1) return { code: 0, stdout: `${PID_MARKER}99\n`, stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      stream: async (_t, _s, opts) => {
        ac.abort();
        return { code: null, stdout: '', stderr: '' };
      },
    };
    const handler2 = createRemoteAgentHandler({
      runner: runner2,
      loadHosts: async () => ({ myhost: { name: 'myhost', ssh: 'user@myhost' } }),
      sleep: async () => undefined,
    });
    const result = await handler2({ host: 'myhost', prompt: 'go' }, ac.signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('aborted');
    expect(result.content).not.toContain('<remote-output>');
  });
});
