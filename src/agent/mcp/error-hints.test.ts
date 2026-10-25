import { describe, expect, it, vi } from 'vitest';
import { applyMcpErrorHints, chromeDevtoolsActivePortRule, type McpErrorHintRule } from './error-hints.js';
import type { RealChromeProbeResult } from '../../browser/real-chrome-probe.js';

const ACTIVE_PORT_ERR =
  'Could not connect to Chrome. Check if Chrome is running.\n' +
  'Cause: Could not find DevToolsActivePort for chrome at /Users/u/Library/Application Support/Google/Chrome/DevToolsActivePort';

const cdConfig = { command: 'npx', args: ['chrome-devtools-mcp@1.11.0', '--autoConnect'] };

function probeReturning(state: RealChromeProbeResult['state']) {
  return vi.fn(
    (channel: RealChromeProbeResult['channel']): RealChromeProbeResult => ({
      state,
      channel,
      platform: 'darwin',
      userDataDir: '/d',
      ...(state === 'blocked' ? { errorCode: 'EPERM' } : {}),
    }),
  );
}

describe('chromeDevtoolsActivePortRule', () => {
  it('appends the macOS TCC diagnosis when the probe says blocked', () => {
    const probe = probeReturning('blocked');
    const rules = [chromeDevtoolsActivePortRule({ probe })];
    const out = applyMcpErrorHints('chrome-devtools', cdConfig, { content: ACTIVE_PORT_ERR, isError: true }, rules);
    expect(out.isError).toBe(true);
    expect(out.content.startsWith(ACTIVE_PORT_ERR)).toBe(true);
    expect(out.content).toContain('[afk diagnosis]');
    expect(out.content).toContain('Files & Folders');
    expect(out.content).toMatch(/retrying the same call will fail/);
  });

  it('appends the enable-debugging step when the probe says missing', () => {
    const rules = [chromeDevtoolsActivePortRule({ probe: probeReturning('missing') })];
    const out = applyMcpErrorHints('chrome-devtools', cdConfig, { content: ACTIVE_PORT_ERR, isError: true }, rules);
    expect(out.content).toContain('chrome://inspect/#remote-debugging');
  });

  it('adds nothing when the probe now reads ok (transient failure)', () => {
    const rules = [chromeDevtoolsActivePortRule({ probe: probeReturning('ok') })];
    const result = { content: ACTIVE_PORT_ERR, isError: true };
    expect(applyMcpErrorHints('chrome-devtools', cdConfig, result, rules)).toBe(result);
  });

  it('probes the channel named in the server args', () => {
    const probe = probeReturning('missing');
    const rules = [chromeDevtoolsActivePortRule({ probe })];
    applyMcpErrorHints('chrome-devtools', { ...cdConfig, args: [...cdConfig.args, '--channel', 'canary'] }, { content: ACTIVE_PORT_ERR, isError: true }, rules);
    expect(probe).toHaveBeenCalledWith('canary');
  });

  it('matches a renamed server by its chrome-devtools-mcp package arg', () => {
    const rules = [chromeDevtoolsActivePortRule({ probe: probeReturning('blocked') })];
    const out = applyMcpErrorHints('my-chrome', cdConfig, { content: ACTIVE_PORT_ERR, isError: true }, rules);
    expect(out.content).toContain('[afk diagnosis]');
  });

  it('ignores other servers, other errors, and successful results', () => {
    const probe = probeReturning('blocked');
    const rules = [chromeDevtoolsActivePortRule({ probe })];
    const other = { content: ACTIVE_PORT_ERR, isError: true };
    expect(applyMcpErrorHints('jev', { command: 'npx', args: ['jev-mcp'] }, other, rules)).toBe(other);
    const unrelated = { content: 'Timed out', isError: true };
    expect(applyMcpErrorHints('chrome-devtools', cdConfig, unrelated, rules)).toBe(unrelated);
    const ok = { content: ACTIVE_PORT_ERR };
    expect(applyMcpErrorHints('chrome-devtools', cdConfig, ok, rules)).toBe(ok);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('applyMcpErrorHints', () => {
  it('swallows a throwing rule and returns the original result', () => {
    const bad: McpErrorHintRule = { id: 'bad', appliesTo: () => true, hint: () => { throw new Error('x'); } };
    const result = { content: 'err', isError: true };
    expect(applyMcpErrorHints('s', {}, result, [bad])).toBe(result);
  });

  it('logs the rule id and error message to stderr when a rule throws', () => {
    const written: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown, ...rest: unknown[]) => {
      written.push(String(chunk));
      return true;
    };
    try {
      const bad: McpErrorHintRule = { id: 'my-rule', appliesTo: () => true, hint: () => { throw new Error('boom'); } };
      applyMcpErrorHints('s', {}, { content: 'err', isError: true }, [bad]);
    } finally {
      process.stderr.write = origWrite;
    }
    expect(written.some((line) => line.includes('my-rule') && line.includes('boom'))).toBe(true);
  });
});
