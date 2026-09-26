import { describe, expect, it } from 'vitest';
import { extractUserContent, isPreamble } from './preamble-strip.js';

describe('preamble-strip', () => {
  it('detects bracketed and XML preamble openers', () => {
    expect(isPreamble('[skill-routing: active]\nstuff')).toBe(true);
    expect(isPreamble('<command-name>/x</command-name>')).toBe(true);
    expect(isPreamble('how do I run tests?')).toBe(false);
  });

  it('returns the real user question after a multi-block preamble', () => {
    const text = [
      '[placeholder-prevent] When including shell commands, resolve placeholders.',
      '[agent-workflow-amplifiers: unlocked]',
      '',
      'Treat the plugin as default infrastructure.',
      '- Bugs -> /diagnose',
      '[memory: 3 prior patterns may apply]',
      '1. some pattern',
      '[bridge: prior-session context]',
      'Recent commits:',
      'abc123 chore: release',
      'Read any referenced file for deeper context before acting — these are pointers, not full content.',
      '',
      'why does the daemon keep restarting?',
    ].join('\n');
    expect(extractUserContent(text)).toBe('why does the daemon keep restarting?');
  });

  it('returns plain text unchanged when there is no preamble', () => {
    expect(extractUserContent('[skill-routing: active]\nfix the flaky test')).toBe('fix the flaky test');
  });

  it('returns undefined for pure boilerplate', () => {
    expect(extractUserContent('[skill-routing: active]')).toBeUndefined();
  });
});
