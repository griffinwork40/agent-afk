import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  formatTerminalStateForTelegram,
  pushTerminalStateToTelegram,
  doneHasCorroboratingEvidence,
  classifyDoneEvidence,
  isVerificationCommand,
  resetAfkPushBudget,
  afkPushCount,
  MAX_PUSHES_PER_SESSION,
} from './afk-push.js';
import type { TerminalState } from './terminal-state.js';
import type { ToolEvent } from '../../slash/types.js';

function done(extra: Partial<TerminalState> = {}): TerminalState {
  return { kind: 'done', rawBody: '', ...extra };
}

let toolSeq = 0;
function tool(toolName: string, isError?: boolean, input = ''): ToolEvent {
  toolSeq += 1;
  return { toolName, toolUseId: `tu-${toolSeq}`, input, ...(isError !== undefined && { isError }) };
}

describe('formatTerminalStateForTelegram', () => {
  it('renders a kind label header for each terminal state', () => {
    expect(formatTerminalStateForTelegram(done())).toContain('AFK');
    expect(formatTerminalStateForTelegram(done()).toLowerCase()).toContain('done');
    expect(
      formatTerminalStateForTelegram({ kind: 'blocked', rawBody: '' }).toLowerCase(),
    ).toContain('blocked');
    expect(
      formatTerminalStateForTelegram({ kind: 'asking', rawBody: '' }).toLowerCase(),
    ).toContain('asking');
  });

  it('includes the structured fields for the state kind', () => {
    const msg = formatTerminalStateForTelegram(
      done({ whatWasDone: 'migrated the field', evidence: 'src/x.ts:10', deferred: 'phase 2' }),
    );
    expect(msg).toContain('migrated the field');
    expect(msg).toContain('src/x.ts:10');
    expect(msg).toContain('phase 2');
  });

  it('is an allowlist by construction — only fields for THIS kind appear', () => {
    // A done verdict that also (nonsensically) carries blocked/asking fields:
    // the formatter must ignore the off-kind fields entirely.
    const msg = formatTerminalStateForTelegram(
      done({
        whatWasDone: 'the real summary',
        whatBlocks: 'SHOULD-NOT-APPEAR-blocked',
        question: 'SHOULD-NOT-APPEAR-question',
      }),
    );
    expect(msg).toContain('the real summary');
    expect(msg).not.toContain('SHOULD-NOT-APPEAR');
  });

  it('scrubs secrets that leaked into a structured field', () => {
    const msg = formatTerminalStateForTelegram(
      done({ whatWasDone: 'set key sk-ant-abcdefgh12345678 in config' }),
    );
    expect(msg).not.toContain('sk-ant-abcdefgh12345678');
    expect(msg).toContain('REDACTED');
  });

  it('falls back to rawBody only when no structured field is present', () => {
    expect(formatTerminalStateForTelegram(done({ rawBody: 'fallback body text' }))).toContain(
      'fallback body text',
    );
  });
});

describe('pushTerminalStateToTelegram — rate limiting', () => {
  beforeEach(() => resetAfkPushBudget());

  it('calls the push impl with the formatted message', async () => {
    const push = vi.fn().mockResolvedValue(null);
    await pushTerminalStateToTelegram(done({ whatWasDone: 'hello' }), push);
    expect(push).toHaveBeenCalledTimes(1);
    expect(String(push.mock.calls[0]?.[0])).toContain('hello');
    expect(afkPushCount()).toBe(1);
  });

  it('stops pushing after the per-session cap and sends exactly one mute notice', async () => {
    const push = vi.fn().mockResolvedValue(null);
    // Exhaust the budget.
    for (let i = 0; i < MAX_PUSHES_PER_SESSION; i++) {
      await pushTerminalStateToTelegram(done({ whatWasDone: `turn ${i}` }), push);
    }
    expect(push).toHaveBeenCalledTimes(MAX_PUSHES_PER_SESSION);

    // Next call: a single "muted" notice, not the verdict.
    await pushTerminalStateToTelegram(done({ whatWasDone: 'over budget' }), push);
    expect(push).toHaveBeenCalledTimes(MAX_PUSHES_PER_SESSION + 1);
    expect(String(push.mock.calls[MAX_PUSHES_PER_SESSION]?.[0]).toLowerCase()).toContain('muted');

    // Further calls: silent (no more pushes).
    await pushTerminalStateToTelegram(done({ whatWasDone: 'still over' }), push);
    expect(push).toHaveBeenCalledTimes(MAX_PUSHES_PER_SESSION + 1);
  });

  it('resetAfkPushBudget restores a fresh budget', async () => {
    const push = vi.fn().mockResolvedValue(null);
    for (let i = 0; i < MAX_PUSHES_PER_SESSION; i++) {
      await pushTerminalStateToTelegram(done(), push);
    }
    resetAfkPushBudget();
    expect(afkPushCount()).toBe(0);
    await pushTerminalStateToTelegram(done({ whatWasDone: 'fresh' }), push);
    expect(afkPushCount()).toBe(1);
  });

  it('is best-effort — a throwing push impl never propagates', async () => {
    const push = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(
      pushTerminalStateToTelegram(done({ whatWasDone: 'x' }), push),
    ).resolves.toBeUndefined();
  });

  it('forwards the unverified flag to the formatter', async () => {
    const push = vi.fn().mockResolvedValue(null);
    await pushTerminalStateToTelegram(done({ whatWasDone: 'maybe' }), push, { unverified: true });
    expect(String(push.mock.calls[0]?.[0]).toLowerCase()).toContain('unverified');
  });
});

describe('isVerificationCommand', () => {
  it.each([
    // Package-manager test/lint/check scripts
    ['pnpm test', true],
    ['pnpm run test', true],
    ['pnpm lint', true],
    ['pnpm run lint', true],
    ['npm test', true],
    ['npm run check', true],
    ['yarn test', true],
    ['yarn typecheck', true],
    ['bun test', true],
    ['pnpm run typecheck', true],
    ['pnpm run type-check', true],
    ['pnpm build', true],
    ['npm run build', true],
    ['pnpm run verify', true],
    // pnpm exec / npx + runner
    ['pnpm exec vitest run src/foo.test.ts', true],
    ['npx jest --coverage', true],
    ['npx tsc --noEmit', true],
    // Direct test runners
    ['vitest run', true],
    ['jest', true],
    ['pytest', true],
    ['mocha', true],
    // Compilers / type-checkers
    ['tsc --noEmit', true],
    ['tsc', true],
    ['gcc -o main main.c', true],
    ['rustc main.rs', true],
    ['javac Main.java', true],
    // Make / cargo / go
    ['make test', true],
    ['make check', true],
    ['cargo test', true],
    ['cargo check', true],
    ['cargo clippy', true],
    ['cargo build', true],
    ['go test ./...', true],
    ['go vet ./...', true],
    ['go build', true],
    // Swift / dotnet / ruby
    ['swift test', true],
    ['swift build', true],
    ['dotnet test', true],
    ['dotnet build', true],
    ['rake test', true],
    ['bundle exec rspec', true],
    // Python
    ['python -m pytest', true],
    ['python3 -m unittest', true],
    // NON-verification commands
    ['ls -la', false],
    ['cat src/foo.ts', false],
    ['grep -rn "test" src/', false],
    ['git status', false],
    ['git diff', false],
    ['git log --oneline', false],
    ['git add .', false],
    ['git commit -m "fix"', false],
    ['pnpm install', false],
    ['npm install', false],
    ['yarn add lodash', false],
    ['cd src && pwd', false],
    ['echo "hello"', false],
    ['mkdir -p dist', false],
    ['rm -rf dist', false],
    ['node server.js', false],
    ['pnpm dev', false],
    ['npm start', false],
    ['pnpm format', false],
    ['prettier --write .', false],
    ['', false],
  ])('%s -> %s', (cmd, expected) => {
    expect(isVerificationCommand(cmd)).toBe(expected);
  });
});

describe('classifyDoneEvidence', () => {
  it('returns no-code-changes when no tool events', () => {
    expect(classifyDoneEvidence([])).toBe('no-code-changes');
  });

  it('returns no-code-changes for read-only tools', () => {
    expect(classifyDoneEvidence([
      tool('read_file'), tool('grep'), tool('glob'),
    ])).toBe('no-code-changes');
  });

  it('returns no-code-changes for bash-only turns (no code mutation)', () => {
    expect(classifyDoneEvidence([
      tool('bash', false, ' ls -la'),
      tool('bash', false, ' git status'),
    ])).toBe('no-code-changes');
  });

  it('returns unverified for edit_file with no verification', () => {
    expect(classifyDoneEvidence([tool('edit_file')])).toBe('unverified');
  });

  it('returns unverified for write_file with no verification', () => {
    expect(classifyDoneEvidence([tool('write_file')])).toBe('unverified');
  });

  it('returns unverified when edit followed by non-verification bash', () => {
    expect(classifyDoneEvidence([
      tool('edit_file'),
      tool('bash', false, ' ls -la'),
    ])).toBe('unverified');
  });

  it('returns verified when edit followed by successful test', () => {
    expect(classifyDoneEvidence([
      tool('edit_file'),
      tool('bash', false, ' pnpm test'),
    ])).toBe('verified');
  });

  it('returns verified when edit followed by successful lint', () => {
    expect(classifyDoneEvidence([
      tool('edit_file'),
      tool('bash', false, ' pnpm lint'),
    ])).toBe('verified');
  });

  it('returns verified when edit followed by successful typecheck', () => {
    expect(classifyDoneEvidence([
      tool('edit_file'),
      tool('bash', false, ' tsc --noEmit'),
    ])).toBe('verified');
  });

  it('returns unverified when test ran BEFORE edit (stale verification)', () => {
    expect(classifyDoneEvidence([
      tool('bash', false, ' pnpm test'),
      tool('edit_file'),
    ])).toBe('unverified');
  });

  it('returns unverified when edit -> test -> edit (stale verification)', () => {
    expect(classifyDoneEvidence([
      tool('edit_file'),
      tool('bash', false, ' pnpm test'),
      tool('edit_file'),
    ])).toBe('unverified');
  });

  it('returns unverified when test failed after edit', () => {
    expect(classifyDoneEvidence([
      tool('edit_file'),
      tool('bash', true, ' pnpm test'),
    ])).toBe('unverified');
  });

  it('returns no-code-changes when edit_file itself failed', () => {
    expect(classifyDoneEvidence([
      tool('edit_file', true),
    ])).toBe('no-code-changes');
  });

  it('returns verified for multiple mutations followed by one verification', () => {
    expect(classifyDoneEvidence([
      tool('edit_file'),
      tool('write_file'),
      tool('edit_file'),
      tool('bash', false, ' pnpm exec vitest run src/foo.test.ts'),
    ])).toBe('verified');
  });

  it('returns verified for edit followed by cargo test', () => {
    expect(classifyDoneEvidence([
      tool('write_file'),
      tool('bash', false, ' cargo test'),
    ])).toBe('verified');
  });

  it('returns verified for edit followed by go test', () => {
    expect(classifyDoneEvidence([
      tool('edit_file'),
      tool('bash', false, ' go test ./...'),
    ])).toBe('verified');
  });

  it('ignores non-verification bash between edit and verification', () => {
    expect(classifyDoneEvidence([
      tool('edit_file'),
      tool('bash', false, ' git diff'),
      tool('bash', false, ' pnpm test'),
    ])).toBe('verified');
  });
});

describe('doneHasCorroboratingEvidence', () => {
  // General corroboration: did observable work happen?
  it('is false for no tool events (no evidence at all)', () => {
    expect(doneHasCorroboratingEvidence([])).toBe(false);
  });

  it('is false when the turn only read (read-only tools are not evidence)', () => {
    expect(
      doneHasCorroboratingEvidence([tool('read_file'), tool('grep'), tool('glob'), tool('list_directory')]),
    ).toBe(false);
  });

  // Code verification: code changed but not verified
  it('is false for edit_file without verification (unverified code)', () => {
    expect(doneHasCorroboratingEvidence([tool('edit_file')])).toBe(false);
    expect(doneHasCorroboratingEvidence([tool('write_file')])).toBe(false);
  });

  it('is true for edit_file followed by successful test', () => {
    expect(doneHasCorroboratingEvidence([
      tool('edit_file'),
      tool('bash', false, ' pnpm test'),
    ])).toBe(true);
  });

  it('is true for bash-only turns (evidence tool present, no code mutation)', () => {
    expect(doneHasCorroboratingEvidence([tool('bash')])).toBe(true);
  });

  it('is false when all evidence tools failed', () => {
    expect(doneHasCorroboratingEvidence([tool('write_file', true)])).toBe(false);
    expect(doneHasCorroboratingEvidence([
      tool('edit_file'),
      tool('bash', true, ' pnpm test'),
    ])).toBe(false); // real edit, failed test
  });

  it('is true when edit + verification succeeded amid failures/reads', () => {
    expect(
      doneHasCorroboratingEvidence([
        tool('read_file'), tool('bash', true), tool('edit_file'), tool('bash', false, ' pnpm lint'),
      ]),
    ).toBe(true);
  });

  // Subagent-only coordinator: no tool events from DONE_EVIDENCE_TOOLS
  it('is false for subagent-only coordinator turn (delegation tools are not evidence)', () => {
    expect(doneHasCorroboratingEvidence([tool('agent'), tool('compose')])).toBe(false);
  });
});

describe('formatTerminalStateForTelegram — verification downgrade', () => {
  it('downgrades a done verdict to "unverified" when opts.unverified is true', () => {
    const msg = formatTerminalStateForTelegram(done({ whatWasDone: 'shipped' }), { unverified: true });
    expect(msg.toLowerCase()).toContain('unverified');
    // The structured field still appears — downgrade annotates, never hides.
    expect(msg).toContain('shipped');
    // A caveat line explains the downgrade.
    expect(msg.toLowerCase()).toContain('no recognized successful verification');
  });

  it('keeps the standard done label when unverified is false or absent', () => {
    expect(formatTerminalStateForTelegram(done()).toLowerCase()).not.toContain('unverified');
    expect(
      formatTerminalStateForTelegram(done(), { unverified: false }).toLowerCase(),
    ).not.toContain('unverified');
  });

  it('only downgrades the done kind — blocked/asking are never relabelled', () => {
    expect(
      formatTerminalStateForTelegram({ kind: 'blocked', rawBody: 'x' }, { unverified: true }).toLowerCase(),
    ).not.toContain('unverified');
    expect(
      formatTerminalStateForTelegram({ kind: 'asking', rawBody: 'x' }, { unverified: true }).toLowerCase(),
    ).not.toContain('unverified');
  });
});
