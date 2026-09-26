/**
 * Tests for placeholder detection in agent output.
 *
 * Covers:
 *   - Shellable language filtering
 *   - Each placeholder pattern family
 *   - False-positive suppression (real env vars, non-shell blocks)
 *   - Stop hook lifecycle (injection, budget, subagent skip, register read)
 *   - End-to-end: realistic agent output with mixed placeholders
 */

import { describe, it, expect } from 'vitest';
import {
  isShellableBlock,
  detectPlaceholdersInBlocks,
  createPlaceholderDetectHook,
} from './placeholder-detect.js';
import type { StopContext } from './hooks.js';

// ─── isShellableBlock ────────────────────────────────────────────────────────

describe('isShellableBlock', () => {
  it('accepts bash/sh/zsh/shell', () => {
    expect(isShellableBlock('bash')).toBe(true);
    expect(isShellableBlock('sh')).toBe(true);
    expect(isShellableBlock('zsh')).toBe(true);
    expect(isShellableBlock('shell')).toBe(true);
  });

  it('accepts powershell and console variants', () => {
    expect(isShellableBlock('powershell')).toBe(true);
    expect(isShellableBlock('ps1')).toBe(true);
    expect(isShellableBlock('console')).toBe(true);
    expect(isShellableBlock('terminal')).toBe(true);
  });

  it('accepts unlabeled blocks (empty string)', () => {
    expect(isShellableBlock('')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isShellableBlock('Bash')).toBe(true);
    expect(isShellableBlock('SHELL')).toBe(true);
  });

  it('rejects non-shell languages', () => {
    expect(isShellableBlock('typescript')).toBe(false);
    expect(isShellableBlock('python')).toBe(false);
    expect(isShellableBlock('java')).toBe(false);
    expect(isShellableBlock('html')).toBe(false);
    expect(isShellableBlock('json')).toBe(false);
  });
});

// ─── detectPlaceholdersInBlocks — pattern families ───────────────────────────

describe('detectPlaceholdersInBlocks — angle-bracket', () => {
  it('detects angle-bracket placeholders', () => {
    const matches = detectPlaceholdersInBlocks(['ssh <your-user>@<your-host>']);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches.map((m) => m.match)).toContain('<your-user>');
    expect(matches.map((m) => m.match)).toContain('<your-host>');
  });

  it('detects <insert-token-here> style', () => {
    const matches = detectPlaceholdersInBlocks([
      'curl -H "Authorization: Bearer <insert-token-here>"',
    ]);
    expect(matches.some((m) => m.match === '<insert-token-here>')).toBe(true);
  });
});

describe('detectPlaceholdersInBlocks — screaming-snake', () => {
  it('detects YOUR_API_KEY', () => {
    const matches = detectPlaceholdersInBlocks(['export TOKEN=YOUR_API_KEY']);
    expect(matches.some((m) => m.match === 'YOUR_API_KEY')).toBe(true);
  });

  it('detects REPLACE_WITH_TOKEN', () => {
    const matches = detectPlaceholdersInBlocks(['REPLACE_WITH_TOKEN']);
    expect(matches.some((m) => m.match === 'REPLACE_WITH_TOKEN')).toBe(true);
  });

  it('does not flag real env var patterns without placeholder prefix', () => {
    const matches = detectPlaceholdersInBlocks([
      'export NODE_ENV=production\nDATABASE_URL=postgres://...',
    ]);
    expect(matches.filter((m) => m.pattern === 'screaming-snake')).toHaveLength(0);
  });

  it('does not flag SET_HOME — real env var starting with SET', () => {
    const matches = detectPlaceholdersInBlocks(['export SET_HOME=/usr/local']);
    expect(matches.filter((m) => m.pattern === 'screaming-snake')).toHaveLength(0);
  });

  it('does not flag ADD_USER — real env var starting with ADD', () => {
    const matches = detectPlaceholdersInBlocks(['ADD_USER=admin ./setup.sh']);
    expect(matches.filter((m) => m.pattern === 'screaming-snake')).toHaveLength(0);
  });

  it('does not flag UPDATE_DB — real env var starting with UPDATE', () => {
    const matches = detectPlaceholdersInBlocks(['UPDATE_DB=true pnpm migrate']);
    expect(matches.filter((m) => m.pattern === 'screaming-snake')).toHaveLength(0);
  });

  it('does not flag CHANGE_LOG, INSERT_ID, THE_SERVER, ENTER_KEY, PUT_OBJECT', () => {
    const input = [
      'CHANGE_LOG=verbose INSERT_ID=42 THE_SERVER=prod ENTER_KEY=n PUT_OBJECT=1',
    ];
    const matches = detectPlaceholdersInBlocks(input);
    const snakeMatches = matches.filter((m) => m.pattern === 'screaming-snake');
    expect(snakeMatches).toHaveLength(0);
  });

  it('still detects YOUR_API_KEY after prefix tightening', () => {
    const matches = detectPlaceholdersInBlocks(['export TOKEN=YOUR_API_KEY']);
    expect(matches.some((m) => m.match === 'YOUR_API_KEY')).toBe(true);
  });

  it('still detects REPLACE_WITH_TOKEN after prefix tightening', () => {
    const matches = detectPlaceholdersInBlocks(['TOKEN=REPLACE_WITH_TOKEN']);
    expect(matches.some((m) => m.match === 'REPLACE_WITH_TOKEN')).toBe(true);
  });

  it('still detects EXAMPLE_API_KEY and SAMPLE_TOKEN', () => {
    const matches = detectPlaceholdersInBlocks([
      'export KEY=EXAMPLE_API_KEY SECRET=SAMPLE_TOKEN',
    ]);
    expect(matches.some((m) => m.match === 'EXAMPLE_API_KEY')).toBe(true);
    expect(matches.some((m) => m.match === 'SAMPLE_TOKEN')).toBe(true);
  });
});

describe('detectPlaceholdersInBlocks — your-prefix', () => {
  it('detects your-user', () => {
    const matches = detectPlaceholdersInBlocks(['ssh your-user@192.168.1.1']);
    expect(matches.some((m) => m.match === 'your-user')).toBe(true);
  });

  it('detects your_password', () => {
    const matches = detectPlaceholdersInBlocks(['mysql -p your_password']);
    expect(matches.some((m) => m.match === 'your_password')).toBe(true);
  });

  it('detects your-api-key', () => {
    const matches = detectPlaceholdersInBlocks([
      'curl -H "X-API-Key: your-api-key" https://api.com',
    ]);
    expect(matches.some((m) => m.match === 'your-api-key')).toBe(true);
  });
});

describe('detectPlaceholdersInBlocks — example domain', () => {
  it('detects example.com', () => {
    const matches = detectPlaceholdersInBlocks(['curl https://example.com/api/v1']);
    expect(matches.some((m) => m.pattern === 'example-domain')).toBe(true);
  });

  it('detects user@example.com', () => {
    const matches = detectPlaceholdersInBlocks([
      'git config user.email user@example.com',
    ]);
    expect(matches.some((m) => m.match === 'user@example.com')).toBe(true);
  });
});

describe('detectPlaceholdersInBlocks — xxx-run', () => {
  it('detects xxx.xxx.xxx.xxx as IP placeholder', () => {
    const matches = detectPlaceholdersInBlocks(['ssh root@xxx.xxx.xxx.xxx']);
    expect(matches.some((m) => m.pattern === 'xxx-run')).toBe(true);
  });
});

describe('detectPlaceholdersInBlocks — replace-me', () => {
  it('detects REPLACE_ME', () => {
    const matches = detectPlaceholdersInBlocks(['API_KEY=REPLACE_ME']);
    expect(matches.some((m) => m.match === 'REPLACE_ME')).toBe(true);
  });

  it('detects CHANGEME', () => {
    const matches = detectPlaceholdersInBlocks(['password: CHANGEME']);
    expect(matches.some((m) => m.match === 'CHANGEME')).toBe(true);
  });
});

// ─── detectPlaceholdersInBlocks — false-positive resistance ──────────────────

describe('detectPlaceholdersInBlocks — false positives', () => {
  it('deduplicates repeated matches', () => {
    const matches = detectPlaceholdersInBlocks([
      'ssh your-user@host1\nssh your-user@host2',
    ]);
    const yourUserMatches = matches.filter((m) => m.match === 'your-user');
    expect(yourUserMatches).toHaveLength(1);
  });

  it('returns empty for clean commands', () => {
    const matches = detectPlaceholdersInBlocks([
      'ssh griffin@192.168.1.42',
      'open vnc://Griffins-Mac-mini.local',
    ]);
    expect(matches).toHaveLength(0);
  });
});

// ─── End-to-end: realistic shell output ──────────────────────────────────────

describe('detectPlaceholdersInBlocks — realistic output', () => {
  it('catches the original failure case: ssh your-user@mac-mini-ip', () => {
    const matches = detectPlaceholdersInBlocks([
      '# SSH into the Mac Mini first\nssh your-user@mac-mini-ip\n\n# Enable the screen sharing service\nsudo launchctl load -w /System/Library/LaunchDaemons/com.apple.screensharing.plist',
      'open vnc://mac-mini-ip',
    ]);
    expect(matches.some((m) => m.match === 'your-user')).toBe(true);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('catches curl with placeholder token', () => {
    const matches = detectPlaceholdersInBlocks([
      'curl -X POST https://api.example.com/v1/data \\\n  -H "Authorization: Bearer YOUR_API_TOKEN" \\\n  -H "Content-Type: application/json"',
    ]);
    expect(matches.some((m) => m.match === 'YOUR_API_TOKEN')).toBe(true);
    expect(matches.some((m) => m.pattern === 'example-domain')).toBe(true);
  });

  it('does not flag resolved commands', () => {
    const matches = detectPlaceholdersInBlocks([
      'ssh griffin@192.168.1.42',
      'open vnc://Griffins-Mac-mini.local',
    ]);
    expect(matches).toHaveLength(0);
  });
});

// ─── Stop hook lifecycle ─────────────────────────────────────────────────────

describe('createPlaceholderDetectHook', () => {
  const makeStopContext = (overrides?: Partial<StopContext>): StopContext => ({
    event: 'Stop',
    sessionId: 's-1',
    ...overrides,
  });

  // Helper: fake code-block register with shellable blocks
  const fakeRegister = (blocks: { lang: string; text: string }[]) =>
    () => blocks.map((b) => ({ type: 'code_block' as const, lang: b.lang, text: b.text }));

  it('returns injectContext when shellable blocks contain placeholders', () => {
    const hook = createPlaceholderDetectHook({
      getCodeBlocks: fakeRegister([
        { lang: 'bash', text: 'ssh your-user@host' },
      ]),
    });
    const result = hook(makeStopContext());
    expect(result.injectContext).toBeDefined();
    expect(result.injectContext).toContain('placeholder-detect');
    expect(result.injectContext).toContain('your-user');
  });

  it('returns empty decision when no placeholders found', () => {
    const hook = createPlaceholderDetectHook({
      getCodeBlocks: fakeRegister([
        { lang: 'bash', text: 'ssh griffin@192.168.1.42' },
      ]),
    });
    const result = hook(makeStopContext());
    expect(result.injectContext).toBeUndefined();
  });

  it('returns empty decision when register is empty', () => {
    const hook = createPlaceholderDetectHook({
      getCodeBlocks: () => [],
    });
    const result = hook(makeStopContext());
    expect(result.injectContext).toBeUndefined();
  });

  it('ignores non-shellable language blocks', () => {
    const hook = createPlaceholderDetectHook({
      getCodeBlocks: fakeRegister([
        { lang: 'typescript', text: 'function foo<T>(x: T): Array<string> {}' },
        { lang: 'java', text: 'static final String YOUR_API_KEY = "...";' },
      ]),
    });
    const result = hook(makeStopContext());
    expect(result.injectContext).toBeUndefined();
  });

  it('detects placeholders in unlabeled (empty lang) blocks', () => {
    const hook = createPlaceholderDetectHook({
      getCodeBlocks: fakeRegister([
        { lang: '', text: 'ssh your-user@host' },
      ]),
    });
    const result = hook(makeStopContext());
    expect(result.injectContext).toBeDefined();
  });

  it('skips subagent turns (parentSessionId set)', () => {
    const hook = createPlaceholderDetectHook({
      getCodeBlocks: fakeRegister([
        { lang: 'bash', text: 'ssh your-user@host' },
      ]),
    });
    const result = hook(makeStopContext({ parentSessionId: 'parent-1' }));
    expect(result.injectContext).toBeUndefined();
  });

  it('respects injection budget (max 2 per session)', () => {
    const getter = fakeRegister([
      { lang: 'bash', text: 'ssh your-user@host' },
    ]);
    const hook = createPlaceholderDetectHook({ getCodeBlocks: getter });

    const r1 = hook(makeStopContext());
    expect(r1.injectContext).toBeDefined();

    const r2 = hook(makeStopContext());
    expect(r2.injectContext).toBeDefined();

    // Third injection should be suppressed (budget exhausted)
    const r3 = hook(makeStopContext());
    expect(r3.injectContext).toBeUndefined();
  });

  it('ignores non-Stop events', () => {
    const hook = createPlaceholderDetectHook({
      getCodeBlocks: fakeRegister([
        { lang: 'bash', text: 'ssh your-user@host' },
      ]),
    });
    const result = hook({ event: 'SessionEnd', sessionId: 's-1' });
    expect(result.injectContext).toBeUndefined();
  });

  it('does not block — decision field is never set', () => {
    const hook = createPlaceholderDetectHook({
      getCodeBlocks: fakeRegister([
        { lang: 'bash', text: 'ssh your-user@host' },
      ]),
    });
    const result = hook(makeStopContext());
    expect(result.decision).toBeUndefined();
    expect(result.continue).toBeUndefined();
  });

  it('filters out non-code_block artifact types', () => {
    const hook = createPlaceholderDetectHook({
      getCodeBlocks: () => [
        { type: 'command', lang: '', text: 'ssh your-user@host' },
        { type: 'url', lang: '', text: 'https://example.com' },
      ],
    });
    const result = hook(makeStopContext());
    expect(result.injectContext).toBeUndefined();
  });
});
