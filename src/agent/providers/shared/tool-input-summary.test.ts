import { describe, it, expect } from 'vitest';
import { summarizeToolInput } from './tool-input-summary.js';

/**
 * Regression coverage for the "0 clue what the agent is running" bug: a
 * multi-line bash command rendered as a bare `$ bash cd <dir>` because the
 * summarizer kept only `command.split('\n')[0]`. It now flattens the whole
 * command to one line instead of dropping everything after the first newline.
 *
 * Because that flattened summary is EXTERNALIZED (session sidecar via
 * saveSession, events.jsonl via session-ledger, telegram streaming) rather than
 * display-only, inline secrets are redacted at this source — see the redaction
 * describe block below (codex P1 on #511).
 */
describe('summarizeToolInput — bash command flattening', () => {
  it('flattens a multi-line command instead of keeping only the first line', () => {
    // The exact screenshot shape: `cd <dir>` on its own line, real work below.
    const out = summarizeToolInput('bash', {
      command: 'cd agent-afk\ngrep -rn "injection blocks" src/',
    });
    // Leading-space contract (facets/derive.ts relies on it) is preserved.
    expect(out.startsWith(' ')).toBe(true);
    // The meaningful verb now survives — previously discarded at the first \n.
    expect(out).toContain('grep -rn "injection blocks" src/');
    // No raw newline leaks into the one-line label.
    expect(out).not.toContain('\n');
  });

  it('drops line-continuation backslashes so `cd && \\<newline> cmd` reads as one command', () => {
    const out = summarizeToolInput('bash', {
      command: 'cd agent-afk && \\\n  grep -rn "foo" src/',
    });
    // Backslash-newline collapses to a single space (no stray `\` or double space).
    expect(out).toBe(' cd agent-afk && grep -rn "foo" src/');
  });

  it('collapses arbitrary interior whitespace runs to single spaces', () => {
    const out = summarizeToolInput('bash', {
      command: 'echo   a\t\tb\n\n   c',
    });
    expect(out).toBe(' echo a b c');
  });

  it('leaves a single-line command intact (still contains the whole command)', () => {
    const out = summarizeToolInput('bash', { command: 'echo hello' });
    expect(out).toBe(' echo hello');
  });

  it('does NOT strip the `cd <dir> &&` wrapper at this layer (display layer owns that)', () => {
    // stripBashCdPrefix lives in the CLI tool-lane formatter; the provider
    // summary preserves the full flattened command including the cd wrapper.
    const out = summarizeToolInput('bash', {
      command: 'cd agent-afk && git status',
    });
    expect(out).toBe(' cd agent-afk && git status');
  });

  it('caps a pathological long one-liner with an ellipsis', () => {
    // Long but non-secret-like (short space-separated tokens) so the secret
    // redactor is a no-op and this exercises the length cap, not redaction.
    const long = 'echo ' + 'word '.repeat(100);
    const out = summarizeToolInput('bash', { command: long });
    // ' ' + 160 chars (159 + '…').
    expect(out.length).toBe(1 + 160);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith(' echo ')).toBe(true);
  });

  it('reads the `cmd` alias as well as `command`', () => {
    const out = summarizeToolInput('bash', { cmd: 'ls -la\npwd' });
    expect(out).toBe(' ls -la pwd');
  });
});

describe('summarizeToolInput — inline secret redaction (codex P1 on #511)', () => {
  // The flattened summary is externalized (session sidecar, events.jsonl,
  // telegram), so a secret on lines 2+ — previously dropped by the
  // first-line-only slice — must be scrubbed here at the single source.
  it('redacts a bearer token carried after the first line', () => {
    const secret = 'sk-ant-api03-' + 'A'.repeat(24);
    const out = summarizeToolInput('bash', {
      command: `cd repo\ncurl -H "Authorization: Bearer ${secret}" https://api.example.com`,
    });
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
    // Command structure survives so the operator still knows what ran.
    expect(out).toContain('cd repo');
    expect(out).toContain('curl');
    expect(out).not.toContain('\n');
  });

  it('redacts an inline env-assigned API key on a later line', () => {
    const secret = 'sk-ant-api03-' + 'B'.repeat(30);
    const out = summarizeToolInput('bash', {
      command: `cd repo\nexport ANTHROPIC_API_KEY=${secret}`,
    });
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('export ANTHROPIC_API_KEY=');
  });

  it('does not redact a long absolute path in a `cd` argument (path false-positive)', () => {
    // The exact screenshot shape: a subagent running `cd <long abs path> && …`
    // rendered as `$ bash cd [REDACTED] echo …` because the generic token rule
    // swallowed the path. The path must survive so the operator can read it.
    const out = summarizeToolInput('bash', {
      command:
        'cd /Users/griffinlong/Projects/open_source/agent-afk && echo "===== HookDecision ====="',
    });
    expect(out).toContain('/Users/griffinlong/Projects/open_source/agent-afk');
    expect(out).not.toContain('[REDACTED]');
  });

  it('leaves an ordinary git commit command intact (verb + message survive)', () => {
    // Proves redaction does not break derive.ts commit detection, which reads
    // this summary and keys on the `git commit` verb.
    const out = summarizeToolInput('bash', {
      command: 'git commit -m "fix: flatten multi-line bash summaries"',
    });
    expect(out).toBe(' git commit -m "fix: flatten multi-line bash summaries"');
  });

  it('leaves a bare git SHA arg intact (git cat-file -t <sha> — real-session shape)', () => {
    // A full 40-hex SHA is byte-identical to a hex secret; it used to render as
    // `git cat-file -t [REDACTED]`, hiding the id the operator needs to read.
    const sha = 'a1b2c3d4e5f6789012345678901234567890abcd';
    const out = summarizeToolInput('bash', { command: `git cat-file -t ${sha}` });
    expect(out).toBe(` git cat-file -t ${sha}`);
    expect(out).not.toContain('[REDACTED]');
  });

  it('leaves a REF=<sha> assignment intact through the flattener (real-session shape)', () => {
    // Exact shape observed in events.jsonl: `cd <dir> && REF=<sha> && git show
    // $REF:<file>` rendered as `cd <dir> && [REDACTED] && git show $REF:<file>`.
    const sha = 'abcdef1234567890abcdef1234567890abcdef12';
    const out = summarizeToolInput('bash', {
      command: `cd repo && REF=${sha} && git show $REF:src/index.ts | sed -n '1,40p'`,
    });
    expect(out).toContain(`REF=${sha}`);
    expect(out).not.toContain('[REDACTED]');
  });

  it('redacts a non-allowlisted NAME=<sha> assignment through the flattener (allowlist boundary)', () => {
    // Symmetric to the REF= test above: same 40-hex width, but PAT is not on the
    // isGitObjectName allowlist, so it must be redacted end-to-end through the
    // flatten+redact pipeline, not just at the pure redactSecrets unit level.
    const sha = 'abcdef1234567890abcdef1234567890abcdef12';
    const out = summarizeToolInput('bash', {
      command: `cd repo && PAT=${sha} && curl -H "Authorization: token $PAT" https://api`,
    });
    expect(out).not.toContain(`PAT=${sha}`);
    expect(out).toContain('[REDACTED]');
  });
});

describe('summarizeToolInput — other tool shapes unchanged', () => {
  it('surfaces file paths with a leading space', () => {
    expect(summarizeToolInput('read_file', { file_path: '/tmp/x.ts' })).toBe(' /tmp/x.ts');
    expect(summarizeToolInput('read_file', { path: '/tmp/x.ts' })).toBe(' /tmp/x.ts');
  });

  it('surfaces a query/pattern/url/description with a leading space', () => {
    expect(summarizeToolInput('grep', { pattern: 'foo' })).toBe(' foo');
    expect(summarizeToolInput('web_scrape', { url: 'https://x.com' })).toBe(' https://x.com');
  });

  it('wraps a skill name in parens', () => {
    expect(summarizeToolInput('skill', { name: 'diagnose' })).toBe('(diagnose)');
  });

  it('returns empty string for non-object / empty input', () => {
    expect(summarizeToolInput('bash', undefined)).toBe('');
    expect(summarizeToolInput('bash', 'not-an-object')).toBe('');
    expect(summarizeToolInput('bash', {})).toBe('');
  });
});
