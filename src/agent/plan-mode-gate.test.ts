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

  it('blocks bash with git commit in plan mode', () => {
    const { gate } = makeGate('plan');
    const result = gate({
      event: 'PreToolUse',
      toolName: 'bash',
      input: { command: 'git commit -m "wip"' },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks bash with rm in plan mode', () => {
    const { gate } = makeGate('plan');
    const result = gate({
      event: 'PreToolUse',
      toolName: 'bash',
      input: { command: 'rm file.txt' },
    });
    expect(result.decision).toBe('block');
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
});
