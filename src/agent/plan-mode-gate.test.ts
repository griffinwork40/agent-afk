import { describe, it, expect } from 'vitest';
import { createPlanModeGate } from './plan-mode-gate.js';
import type { PermissionMode } from './types/sdk-types.js';

describe('createPlanModeGate', () => {
  function makeGate(mode: PermissionMode) {
    let current = mode;
    const gate = createPlanModeGate(() => current);
    return { gate, setMode: (m: PermissionMode) => { current = m; } };
  }

  it('returns {} for non-PreToolUse events regardless of mode', () => {
    const { gate } = makeGate('plan');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(gate({ event: 'SessionStart' } as any)).toEqual({});
  });

  it('returns {} when mode is not plan (default)', () => {
    const { gate } = makeGate('default');
    expect(gate({ event: 'PreToolUse', toolName: 'write_file', input: {} })).toEqual({});
  });

  it('blocks write_file in plan mode', () => {
    const { gate } = makeGate('plan');
    const result = gate({ event: 'PreToolUse', toolName: 'write_file', input: {} });
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('write_file');
  });

  it('blocks edit_file in plan mode', () => {
    const { gate } = makeGate('plan');
    const result = gate({ event: 'PreToolUse', toolName: 'edit_file', input: {} });
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('edit_file');
  });

  // Bash is mutation-gated in plan mode via the shared `classifyBashCommand`
  // classifier (tools/readonly-bash.ts): read-only recon passes, state-mutating
  // commands are refused. These tests exercise the REAL classifier through the
  // gate (no mock), so they double as an integration check that the gate wires
  // to it. The file/memory write-tool gate above is the separate, hard
  // no-mutation guarantee.
  it('blocks state-mutating bash (rm) in plan mode', () => {
    const { gate } = makeGate('plan');
    const result = gate({
      event: 'PreToolUse',
      toolName: 'bash',
      input: { command: 'rm file.txt' },
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('state-mutating');
  });

  it('blocks a background launch in plan mode even for a read-only command', () => {
    const { gate } = makeGate('plan');
    const result = gate({
      event: 'PreToolUse',
      toolName: 'bash',
      input: { command: 'cat README.md', run_in_background: true },
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('run_in_background');
  });

  it('blocks state-mutating bash (git commit) in plan mode', () => {
    const { gate } = makeGate('plan');
    const result = gate({
      event: 'PreToolUse',
      toolName: 'bash',
      input: { command: 'git commit -m "wip"' },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks output redirection to a file in plan mode', () => {
    const { gate } = makeGate('plan');
    const result = gate({
      event: 'PreToolUse',
      toolName: 'bash',
      input: { command: 'echo hello > out.txt' },
    });
    expect(result.decision).toBe('block');
  });

  it('allows chained read-only bash (git status && git log) in plan mode', () => {
    // Regression guard for the friction the old substring denylist caused: it
    // listed ` && `, so every chained command was refused — even when both
    // halves were read-only. The classifier parses properly and allows this.
    const { gate } = makeGate('plan');
    const result = gate({
      event: 'PreToolUse',
      toolName: 'bash',
      input: { command: 'git status && git log --oneline -5' },
    });
    expect(result.decision).toBeUndefined();
  });

  it('allows read-only bash (git status) in plan mode', () => {
    const { gate } = makeGate('plan');
    const result = gate({
      event: 'PreToolUse',
      toolName: 'bash',
      input: { command: 'git status' },
    });
    expect(result.decision).toBeUndefined();
  });

  it('allows read-only bash (grep) in plan mode', () => {
    const { gate } = makeGate('plan');
    const result = gate({
      event: 'PreToolUse',
      toolName: 'bash',
      input: { command: 'grep -rn foo src' },
    });
    expect(result.decision).toBeUndefined();
  });

  // Bug fix (schema-as-source-of-truth refactor): memory_update and
  // procedure_write are categorized as 'write' and must be blocked in plan
  // mode. Previously only write_file and edit_file were in the local
  // WRITE_TOOLS set; the persistent-memory tools slipped through.
  it('blocks memory_update in plan mode (was bug: plan mode let agent mutate memory)', () => {
    const { gate } = makeGate('plan');
    const result = gate({ event: 'PreToolUse', toolName: 'memory_update', input: {} });
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('memory_update');
  });

  it('blocks procedure_write in plan mode (was bug: plan mode let agent mutate memory)', () => {
    const { gate } = makeGate('plan');
    const result = gate({ event: 'PreToolUse', toolName: 'procedure_write', input: {} });
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('procedure_write');
  });

  it('allows memory_search (read-only) in plan mode', () => {
    const { gate } = makeGate('plan');
    const result = gate({ event: 'PreToolUse', toolName: 'memory_search', input: {} });
    expect(result.decision).toBeUndefined();
  });

  it('getter-at-call-time: gate respects mode changes after construction', () => {
    const { gate, setMode } = makeGate('plan');
    // In plan mode → block
    expect(
      gate({ event: 'PreToolUse', toolName: 'write_file', input: {} }).decision,
    ).toBe('block');
    // Flip to default → pass through
    setMode('default');
    expect(
      gate({ event: 'PreToolUse', toolName: 'write_file', input: {} }).decision,
    ).toBeUndefined();
  });

  it('skips subagent tool calls in plan mode (parentSessionId set)', () => {
    const { gate } = makeGate('plan');
    // A forked subagent inherits the parent registry; plan mode is a
    // main-session affordance and must not gate the worker's writes.
    const result = gate({
      event: 'PreToolUse',
      toolName: 'write_file',
      input: {},
      parentSessionId: 'parent-session-123',
    });
    expect(result.decision).toBeUndefined();
  });

  it('still blocks the top-level session in plan mode (no parentSessionId)', () => {
    const { gate } = makeGate('plan');
    const result = gate({ event: 'PreToolUse', toolName: 'write_file', input: {} });
    expect(result.decision).toBe('block');
  });

  // test_run coverage guard (issue #1431)
  it('blocks test_run with coverage=true in plan mode (writes artifact files)', () => {
    const { gate } = makeGate('plan');
    const result = gate({
      event: 'PreToolUse',
      toolName: 'test_run',
      input: { coverage: true },
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('coverage');
  });

  it('allows test_run without coverage in plan mode (read-only spawn)', () => {
    const { gate } = makeGate('plan');
    const result = gate({
      event: 'PreToolUse',
      toolName: 'test_run',
      input: { file: 'src/foo.test.ts' },
    });
    expect(result.decision).toBeUndefined();
  });

  it('allows test_run with coverage=false in plan mode', () => {
    const { gate } = makeGate('plan');
    const result = gate({
      event: 'PreToolUse',
      toolName: 'test_run',
      input: { coverage: false },
    });
    expect(result.decision).toBeUndefined();
  });

  it('allows test_run with coverage=true in default mode', () => {
    const { gate } = makeGate('default');
    const result = gate({
      event: 'PreToolUse',
      toolName: 'test_run',
      input: { coverage: true },
    });
    expect(result.decision).toBeUndefined();
  });

  // remote_agent is risk class high: the remote runs bypassPermissions by
  // default, so a single call can mutate arbitrary state on another machine.
  // It is categorized 'web' (not 'write'), so the write-category block does
  // not catch it — the explicit remote_agent check must fire independently.
  it('blocks remote_agent in plan mode', () => {
    const { gate } = makeGate('plan');
    const result = gate({ event: 'PreToolUse', toolName: 'remote_agent', input: { host: 'cm', prompt: 'do stuff' } });
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('remote_agent');
  });

  it('allows remote_agent when not in plan mode', () => {
    const { gate } = makeGate('default');
    const result = gate({ event: 'PreToolUse', toolName: 'remote_agent', input: { host: 'cm', prompt: 'do stuff' } });
    expect(result.decision).toBeUndefined();
  });

  it('does not block remote_agent in a subagent context (plan mode is main-session only)', () => {
    const { gate } = makeGate('plan');
    // parentSessionId marks a forked subagent; plan mode must not gate its calls.
    const result = gate({
      event: 'PreToolUse',
      toolName: 'remote_agent',
      input: { host: 'cm', prompt: 'do stuff' },
      parentSessionId: 'parent-session-123',
    });
    expect(result.decision).toBeUndefined();
  });

  // #4202 follow-up: agent{host} must be plan-mode gated identically to remote_agent.
  it('blocks agent with host in plan mode', () => {
    const { gate } = makeGate('plan');
    const result = gate({ event: 'PreToolUse', toolName: 'agent', input: { prompt: 'task', host: 'my-server' } });
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('agent with `host`');
  });

  it('allows agent without host in plan mode (local subagent)', () => {
    const { gate } = makeGate('plan');
    const result = gate({ event: 'PreToolUse', toolName: 'agent', input: { prompt: 'task' } });
    expect(result.decision).toBeUndefined();
  });

  it('allows agent with host when not in plan mode', () => {
    const { gate } = makeGate('default');
    const result = gate({ event: 'PreToolUse', toolName: 'agent', input: { prompt: 'task', host: 'my-server' } });
    expect(result.decision).toBeUndefined();
  });

  it('does not block agent with host in a subagent context', () => {
    const { gate } = makeGate('plan');
    const result = gate({
      event: 'PreToolUse',
      toolName: 'agent',
      input: { prompt: 'task', host: 'my-server' },
      parentSessionId: 'parent-session-123',
    });
    expect(result.decision).toBeUndefined();
  });
});
