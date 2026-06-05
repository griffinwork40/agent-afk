/**
 * Unit tests for the phase reducer.
 *
 * Tests use synthetic OutputEvent values — no SDK, no I/O.
 * `Date.now` is replaced by an injected `now` parameter so decay transitions
 * are deterministic.
 */

import { describe, it, expect } from 'vitest';
import { reducePhase } from './phase-reducer.js';
import type { Phase } from './phase-reducer.js';
import type { OutputEvent, SubagentProgressMeta } from '../types.js';

const T0 = 1_000_000; // arbitrary base timestamp

/** Helper: make a tool_use_detail event with the given tool name and command. */
function toolUse(toolName: string, command?: string): OutputEvent {
  const toolInput =
    command !== undefined
      ? JSON.stringify({ command })
      : JSON.stringify({});
  return {
    type: 'chunk',
    chunk: { type: 'tool_use_detail', toolUseId: 'u1', toolName, toolInput },
  };
}

function toolResult(isError: boolean): OutputEvent {
  return {
    type: 'chunk',
    chunk: { type: 'tool_result', toolUseId: 'u1', content: 'output', isError },
  };
}

function contentChunk(): OutputEvent {
  return { type: 'chunk', chunk: { type: 'content', content: 'hello' } };
}

function thinkingChunk(): OutputEvent {
  return { type: 'chunk', chunk: { type: 'thinking', content: 'thinking...' } };
}

function noMeta(): SubagentProgressMeta | undefined {
  return undefined;
}

// Short helper to run reducer with no decay (lastEventAt = now).
function reduce(prev: Phase, event: OutputEvent, meta?: SubagentProgressMeta): Phase {
  return reducePhase(prev, event, meta, T0, T0);
}

describe('phase-reducer', () => {
  // ---- Read tools → investigating -----------------------------------------
  it('tool_use_detail read_file → investigating', () => {
    expect(reduce('idle', toolUse('read_file'))).toBe('investigating');
  });

  it('tool_use_detail glob → investigating', () => {
    expect(reduce('idle', toolUse('glob'))).toBe('investigating');
  });

  // ---- Write tools → editing ----------------------------------------------
  it('tool_use_detail write_file → editing', () => {
    expect(reduce('investigating', toolUse('write_file'))).toBe('editing');
  });

  it('tool_use_detail edit_file → editing', () => {
    expect(reduce('idle', toolUse('edit_file'))).toBe('editing');
  });

  // ---- Shell test runner → testing ----------------------------------------
  it('tool_use_detail bash vitest → testing', () => {
    expect(reduce('idle', toolUse('bash', 'pnpm vitest run'))).toBe('testing');
  });

  it('tool_use_detail bash pytest → testing', () => {
    expect(reduce('idle', toolUse('bash', 'pytest tests/'))).toBe('testing');
  });

  it('tool_use_detail bash go test → testing', () => {
    expect(reduce('idle', toolUse('bash', 'go test ./...'))).toBe('testing');
  });

  // ---- Shell build → building ---------------------------------------------
  it('tool_use_detail bash pnpm build → building', () => {
    expect(reduce('investigating', toolUse('bash', 'pnpm build'))).toBe('building');
  });

  it('tool_use_detail bash tsc → building', () => {
    expect(reduce('editing', toolUse('bash', 'tsc --noEmit'))).toBe('building');
  });

  // ---- Subagent/skill/dag dispatch ----------------------------------------
  it('tool_use_detail agent → waiting_on_subagent', () => {
    expect(reduce('idle', toolUse('agent'))).toBe('waiting_on_subagent');
  });

  it('tool_use_detail skill → waiting_on_subagent', () => {
    expect(reduce('investigating', toolUse('skill'))).toBe('waiting_on_subagent');
  });

  it('tool_use_detail compose → waiting_on_subagent', () => {
    expect(reduce('idle', toolUse('compose'))).toBe('waiting_on_subagent');
  });

  // ---- EnterPlanMode → risky_pending --------------------------------------
  it('tool_use_detail EnterPlanMode → risky_pending', () => {
    expect(reduce('idle', toolUse('EnterPlanMode'))).toBe('risky_pending');
  });

  // ---- tool_result isError in active phase → blocked_by_hook -------------
  it('tool_result isError=true from editing → blocked_by_hook', () => {
    expect(reduce('editing', toolResult(true))).toBe('blocked_by_hook');
  });

  it('tool_result isError=true from testing → blocked_by_hook', () => {
    expect(reduce('testing', toolResult(true))).toBe('blocked_by_hook');
  });

  it('tool_result isError=true from building → blocked_by_hook', () => {
    expect(reduce('building', toolResult(true))).toBe('blocked_by_hook');
  });

  it('tool_result isError=false does not change phase', () => {
    expect(reduce('editing', toolResult(false))).toBe('editing');
  });

  it('tool_result isError=true from idle does not change phase', () => {
    // Error from a phase that is not an active-work phase → no transition.
    expect(reduce('idle', toolResult(true))).toBe('idle');
  });

  // ---- content/thinking chunk in idle → investigating ---------------------
  it('content chunk from idle → investigating', () => {
    expect(reduce('idle', contentChunk())).toBe('investigating');
  });

  it('thinking chunk from idle → investigating', () => {
    expect(reduce('idle', thinkingChunk())).toBe('investigating');
  });

  it('content chunk from non-idle phase → no change', () => {
    expect(reduce('editing', contentChunk())).toBe('editing');
  });

  // ---- progress with subagentId ≠ __main__ → waiting_on_subagent ----------
  it('progress with non-main subagentId → waiting_on_subagent', () => {
    const event: OutputEvent = {
      type: 'progress',
      progress: {
        taskId: 't1',
        description: 'running',
        totalTokens: 0,
        toolUses: 0,
        durationMs: 0,
      },
    };
    const meta: SubagentProgressMeta = { subagentId: 'sub-abc' };
    expect(reducePhase('idle', event, meta, T0, T0)).toBe('waiting_on_subagent');
  });

  it('progress with subagentId __main__ does not change phase', () => {
    const event: OutputEvent = {
      type: 'progress',
      progress: {
        taskId: 't1',
        description: 'running',
        totalTokens: 0,
        toolUses: 0,
        durationMs: 0,
      },
    };
    const meta: SubagentProgressMeta = { subagentId: '__main__' };
    expect(reducePhase('idle', event, meta, T0, T0)).toBe('idle');
  });

  // ---- Terminal events ----------------------------------------------------
  it('done → ready_for_review', () => {
    expect(reduce('editing', { type: 'done' })).toBe('ready_for_review');
  });

  it('error → interrupted', () => {
    expect(reduce('editing', { type: 'error', error: new Error('oops') })).toBe('interrupted');
  });

  it('paused → interrupted', () => {
    expect(
      reduce('investigating', { type: 'paused', reason: 'usage-limit' }),
    ).toBe('interrupted');
  });

  it('resumed → investigating', () => {
    expect(reduce('interrupted', { type: 'resumed', hotSwapped: false })).toBe('investigating');
  });

  // ---- Decay transitions --------------------------------------------------
  it('ready_for_review decays to idle after 30s silence', () => {
    const old = T0 - 31_000;
    expect(reducePhase('ready_for_review', contentChunk(), noMeta(), T0, old)).toBe('idle');
  });

  it('investigating decays to idle after 30s silence', () => {
    const old = T0 - 31_000;
    expect(reducePhase('investigating', contentChunk(), noMeta(), T0, old)).toBe('idle');
  });

  it('editing does NOT decay to idle after 30s silence', () => {
    const old = T0 - 31_000;
    // Editing phase should not decay — only ready_for_review and investigating do.
    const result = reducePhase('editing', contentChunk(), noMeta(), T0, old);
    expect(result).toBe('editing');
  });

  it('no decay when within 30s window', () => {
    const recent = T0 - 10_000;
    expect(
      reducePhase('ready_for_review', contentChunk(), noMeta(), T0, recent),
    ).toBe('ready_for_review');
  });
});
