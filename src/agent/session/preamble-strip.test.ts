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

  it('detects a bare kebab-case tag with no colon, like [placeholder-prevent]', () => {
    // Regression: every first turn now opens with `[placeholder-prevent] ...`.
    // The colon/space-only matcher missed it, so the dashboard used the raw
    // preamble as the session title.
    expect(isPreamble('[placeholder-prevent] Prefer running commands yourself.')).toBe(true);
    expect(isPreamble('[note] this is mine')).toBe(false);
  });

  it('peels a jev rules digest sitting between the bridge marker and the user message', () => {
    const bridge = 'Read any referenced file for deeper context before acting — these are pointers, not full content.';
    const digest = [
      '[jev rules] Active project rules:',
      '',
      'FORBID:',
      '  - No raw process.env reads. Use env.ts.',
      '',
      '2 rule(s) loaded. Edits violating these rules at >=0.80 confidence will be blocked.',
    ].join('\n');
    const text = ['[placeholder-prevent] Prefer running commands.', bridge, digest, '', 'can you check gsc'].join('\n');
    expect(extractUserContent(text)).toBe('can you check gsc');
  });

  it('peels a truncated jev rules digest, including the space-joined block shape', () => {
    const bridge = 'Read any referenced file for deeper context before acting — these are pointers, not full content.';
    const digest = '[jev rules] Active project rules:\n\nFORBID:\n  - something long\n  ... (truncated)';
    // Content-block turns (e.g. with an image) are summarized by joining
    // blocks with a single space, so the user text follows on the same line.
    expect(extractUserContent(`${bridge}\n${digest} why no titles [+ 1 image(s)]`)).toBe(
      'why no titles [+ 1 image(s)]',
    );
  });

  it('renders a skill dispatch typed after a jev digest as /<skill> <args>', () => {
    const bridge = 'Read any referenced file for deeper context before acting — these are pointers, not full content.';
    const text = `${bridge}\n[jev rules] Active project rules:\n  - r\n\n1 rule(s) loaded. Edits violating these rules at >=0.80 confidence will be blocked. <command-name>/god</command-name>\n<command-message>god</command-message>\n<command-args>ship it</command-args> Use the skill tool.`;
    expect(extractUserContent(text)).toBe('/god ship it');
  });
});

