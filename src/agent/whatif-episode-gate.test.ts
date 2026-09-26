/**
 * Tests for the what-if episode gate.
 *
 * @module agent/whatif-episode-gate.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isWhatifEpisode,
  createWhatifEpisodeGate,
  resetWhatifEpisodeGateForTests,
  EPISODE_BLOCK_REASON,
} from './whatif-episode-gate.js';
import type { HookContext } from './hooks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePreToolUse(
  toolName: string,
  input: unknown = {},
  opts: { parentSessionId?: string } = {},
): HookContext {
  return {
    event: 'PreToolUse',
    toolName,
    input,
    ...(opts.parentSessionId !== undefined ? { parentSessionId: opts.parentSessionId } : {}),
  } as HookContext;
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'whatif-gate-'));
  vi.unstubAllEnvs();
  resetWhatifEpisodeGateForTests();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
  resetWhatifEpisodeGateForTests();
});

// ---------------------------------------------------------------------------
// isWhatifEpisode()
// ---------------------------------------------------------------------------

describe('isWhatifEpisode', () => {
  it('returns false when env var is unset', () => {
    vi.stubEnv('AFK_WHATIF_EPISODE', '');
    expect(isWhatifEpisode()).toBe(false);
  });

  it('returns true when set to "1"', () => {
    vi.stubEnv('AFK_WHATIF_EPISODE', '1');
    expect(isWhatifEpisode()).toBe(true);
  });

  it('returns true when set to "true"', () => {
    vi.stubEnv('AFK_WHATIF_EPISODE', 'true');
    expect(isWhatifEpisode()).toBe(true);
  });

  it('returns false for other truthy-looking strings', () => {
    vi.stubEnv('AFK_WHATIF_EPISODE', 'yes');
    expect(isWhatifEpisode()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gate disabled (no episode mode)
// ---------------------------------------------------------------------------

describe('gate disabled — no-op when episode mode is off', () => {
  it('returns {} for any event when not in episode mode', () => {
    vi.stubEnv('AFK_WHATIF_EPISODE', '');
    const gate = createWhatifEpisodeGate();
    const result = gate(makePreToolUse('write_file', { file_path: '/tmp/x', content: 'y' }));
    expect(result).toEqual({});
  });

  it('does not write to the log file when disabled', () => {
    vi.stubEnv('AFK_WHATIF_EPISODE', '');
    const logPath = join(tmp, 'gate-log.jsonl');
    vi.stubEnv('AFK_WHATIF_TOOL_LOG', logPath);
    const gate = createWhatifEpisodeGate();
    gate(makePreToolUse('write_file'));
    // Log file should not be created.
    expect(() => readFileSync(logPath, 'utf-8')).toThrow();
  });

  it('passes non-PreToolUse events through unchanged', () => {
    vi.stubEnv('AFK_WHATIF_EPISODE', '1');
    const gate = createWhatifEpisodeGate();
    const ctx = { event: 'SessionStart', sessionId: 'abc' } as HookContext;
    expect(gate(ctx)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Read-only tools — verdict 'executed'
// ---------------------------------------------------------------------------

describe('read-only tools execute', () => {
  beforeEach(() => {
    vi.stubEnv('AFK_WHATIF_EPISODE', '1');
  });

  it('allows read_file (read category)', () => {
    const gate = createWhatifEpisodeGate();
    expect(gate(makePreToolUse('read_file', { file_path: '/tmp/x' }))).toEqual({});
  });

  it('allows glob (read category)', () => {
    const gate = createWhatifEpisodeGate();
    expect(gate(makePreToolUse('glob', { pattern: '**/*.ts' }))).toEqual({});
  });

  it('allows memory_search (read category)', () => {
    const gate = createWhatifEpisodeGate();
    expect(gate(makePreToolUse('memory_search', { query: 'test' }))).toEqual({});
  });

  it('allows web_scrape', () => {
    const gate = createWhatifEpisodeGate();
    expect(gate(makePreToolUse('web_scrape', { url: 'https://example.com' }))).toEqual({});
  });

  it('allows get_runtime_state', () => {
    const gate = createWhatifEpisodeGate();
    expect(gate(makePreToolUse('get_runtime_state', {}))).toEqual({});
  });

  it('allows list_schedules', () => {
    const gate = createWhatifEpisodeGate();
    expect(gate(makePreToolUse('list_schedules', {}))).toEqual({});
  });

  it('allows get_schedule_history', () => {
    const gate = createWhatifEpisodeGate();
    expect(gate(makePreToolUse('get_schedule_history', { taskId: 'foo' }))).toEqual({});
  });

  it('allows worktree with action "list"', () => {
    const gate = createWhatifEpisodeGate();
    expect(gate(makePreToolUse('worktree', { action: 'list' }))).toEqual({});
  });

  it('allows test_run without coverage', () => {
    const gate = createWhatifEpisodeGate();
    expect(gate(makePreToolUse('test_run', { file: 'src/foo.test.ts' }))).toEqual({});
  });

  it('allows web_request GET', () => {
    const gate = createWhatifEpisodeGate();
    expect(gate(makePreToolUse('web_request', { url: 'https://x.com', method: 'GET' }))).toEqual({});
  });

  it('allows web_request HEAD', () => {
    const gate = createWhatifEpisodeGate();
    expect(gate(makePreToolUse('web_request', { url: 'https://x.com', method: 'HEAD' }))).toEqual({});
  });

  it('allows web_request OPTIONS', () => {
    const gate = createWhatifEpisodeGate();
    expect(gate(makePreToolUse('web_request', { url: 'https://x.com', method: 'OPTIONS' }))).toEqual({});
  });

  it('allows web_request with absent method (defaults GET)', () => {
    const gate = createWhatifEpisodeGate();
    expect(gate(makePreToolUse('web_request', { url: 'https://x.com' }))).toEqual({});
  });

  it('allows non-mutating bash (git log)', () => {
    const gate = createWhatifEpisodeGate();
    expect(gate(makePreToolUse('bash', { command: 'git log --oneline -5' }))).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Mutating tools — verdict 'recorded' + block
// ---------------------------------------------------------------------------

describe('mutating tools are recorded and blocked', () => {
  beforeEach(() => {
    vi.stubEnv('AFK_WHATIF_EPISODE', '1');
  });

  it('blocks write_file', () => {
    const gate = createWhatifEpisodeGate();
    const result = gate(makePreToolUse('write_file', { file_path: '/tmp/x', content: 'y' }));
    expect(result).toEqual({ decision: 'block', reason: EPISODE_BLOCK_REASON });
  });

  it('blocks edit_file', () => {
    const gate = createWhatifEpisodeGate();
    const result = gate(makePreToolUse('edit_file', { file_path: '/tmp/x', old_string: 'a', new_string: 'b' }));
    expect(result).toEqual({ decision: 'block', reason: EPISODE_BLOCK_REASON });
  });

  it('blocks mutating bash (rm -rf)', () => {
    const gate = createWhatifEpisodeGate();
    const result = gate(makePreToolUse('bash', { command: 'rm -rf /tmp/sandbox' }));
    expect(result).toEqual({ decision: 'block', reason: EPISODE_BLOCK_REASON });
  });

  it('blocks web_request POST', () => {
    const gate = createWhatifEpisodeGate();
    const result = gate(makePreToolUse('web_request', { url: 'https://api.x.com/v2', method: 'POST', body: {} }));
    expect(result).toEqual({ decision: 'block', reason: EPISODE_BLOCK_REASON });
  });

  it('blocks agent delegation', () => {
    const gate = createWhatifEpisodeGate();
    const result = gate(makePreToolUse('agent', { prompt: 'do stuff' }));
    expect(result).toEqual({ decision: 'block', reason: EPISODE_BLOCK_REASON });
  });

  it('blocks skill delegation', () => {
    const gate = createWhatifEpisodeGate();
    const result = gate(makePreToolUse('skill', { name: 'my-skill' }));
    expect(result).toEqual({ decision: 'block', reason: EPISODE_BLOCK_REASON });
  });

  it('blocks send_telegram', () => {
    const gate = createWhatifEpisodeGate();
    const result = gate(makePreToolUse('send_telegram', { message: 'hello' }));
    expect(result).toEqual({ decision: 'block', reason: EPISODE_BLOCK_REASON });
  });

  it('blocks worktree create', () => {
    const gate = createWhatifEpisodeGate();
    const result = gate(makePreToolUse('worktree', { action: 'create', name: 'my-wt' }));
    expect(result).toEqual({ decision: 'block', reason: EPISODE_BLOCK_REASON });
  });

  it('blocks test_run with coverage=true', () => {
    const gate = createWhatifEpisodeGate();
    const result = gate(makePreToolUse('test_run', { coverage: true }));
    expect(result).toEqual({ decision: 'block', reason: EPISODE_BLOCK_REASON });
  });

  it('blocks browser_open', () => {
    const gate = createWhatifEpisodeGate();
    const result = gate(makePreToolUse('browser_open', { url: 'https://x.com' }));
    expect(result).toEqual({ decision: 'block', reason: EPISODE_BLOCK_REASON });
  });

  it('blocks memory_update', () => {
    const gate = createWhatifEpisodeGate();
    const result = gate(makePreToolUse('memory_update', { content: 'fact', target: 'fact' }));
    expect(result).toEqual({ decision: 'block', reason: EPISODE_BLOCK_REASON });
  });
});

// ---------------------------------------------------------------------------
// Latch: after first recorded verdict, all subsequent calls are blocked
// ---------------------------------------------------------------------------

describe('latch after first recorded verdict', () => {
  beforeEach(() => {
    vi.stubEnv('AFK_WHATIF_EPISODE', '1');
  });

  it('blocks all subsequent calls (even read-only) after first recorded verdict', () => {
    const gate = createWhatifEpisodeGate();
    // First: trigger the latch with a mutating write
    const first = gate(makePreToolUse('write_file'));
    expect(first).toMatchObject({ decision: 'block' });

    // Second: even a read-only tool is now blocked
    const second = gate(makePreToolUse('read_file'));
    expect(second).toMatchObject({ decision: 'block', reason: EPISODE_BLOCK_REASON });
  });

  it('latch persists across multiple gate instances in the same process', () => {
    const gate1 = createWhatifEpisodeGate();
    gate1(makePreToolUse('write_file'));

    // A second gate instance reads the same module-scope latch
    const gate2 = createWhatifEpisodeGate();
    const result = gate2(makePreToolUse('read_file'));
    expect(result).toMatchObject({ decision: 'block' });
  });

  it('resetWhatifEpisodeGateForTests clears the latch', () => {
    const gate = createWhatifEpisodeGate();
    gate(makePreToolUse('write_file'));
    resetWhatifEpisodeGateForTests();

    // After reset, a read-only tool should execute again
    const gate2 = createWhatifEpisodeGate();
    expect(gate2(makePreToolUse('read_file'))).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Subagent context is NOT exempt (tree-wide)
// ---------------------------------------------------------------------------

describe('subagent context is not exempt', () => {
  beforeEach(() => {
    vi.stubEnv('AFK_WHATIF_EPISODE', '1');
  });

  it('blocks write_file even in a subagent context', () => {
    const gate = createWhatifEpisodeGate();
    const ctx = makePreToolUse('write_file', {}, { parentSessionId: 'parent-123' });
    const result = gate(ctx);
    expect(result).toEqual({ decision: 'block', reason: EPISODE_BLOCK_REASON });
  });

  it('allows read_file in a subagent context', () => {
    const gate = createWhatifEpisodeGate();
    const ctx = makePreToolUse('read_file', {}, { parentSessionId: 'parent-123' });
    expect(gate(ctx)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Tool log shape
// ---------------------------------------------------------------------------

describe('tool log lines shape', () => {
  it('appends a JSON line for each call (executed + recorded)', () => {
    vi.stubEnv('AFK_WHATIF_EPISODE', '1');
    const logPath = join(tmp, 'gate-log.jsonl');
    vi.stubEnv('AFK_WHATIF_TOOL_LOG', logPath);
    const gate = createWhatifEpisodeGate();

    // read-only call → executed
    gate(makePreToolUse('read_file', { file_path: '/tmp/x' }));
    // mutating call → recorded
    gate(makePreToolUse('write_file', { file_path: '/tmp/y', content: 'z' }));

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first['tool']).toBe('read_file');
    expect(first['verdict']).toBe('executed');
    expect(typeof first['ts']).toBe('number');
    expect(first['subagent']).toBe(false);

    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(second['tool']).toBe('write_file');
    expect(second['verdict']).toBe('recorded');
    expect(second['subagent']).toBe(false);
  });

  it('marks subagent:true for subagent contexts', () => {
    vi.stubEnv('AFK_WHATIF_EPISODE', '1');
    const logPath = join(tmp, 'gate-log-sub.jsonl');
    vi.stubEnv('AFK_WHATIF_TOOL_LOG', logPath);
    const gate = createWhatifEpisodeGate();

    gate(makePreToolUse('read_file', {}, { parentSessionId: 'parent-abc' }));
    const line = JSON.parse(readFileSync(logPath, 'utf-8').trim()) as Record<string, unknown>;
    expect(line['subagent']).toBe(true);
  });

  it('swallows write errors when log path is invalid', () => {
    vi.stubEnv('AFK_WHATIF_EPISODE', '1');
    vi.stubEnv('AFK_WHATIF_TOOL_LOG', '/nonexistent-dir/gate-log.jsonl');
    const gate = createWhatifEpisodeGate();
    // Must not throw even when log write fails
    expect(() => gate(makePreToolUse('read_file', {}))).not.toThrow();
  });
});
