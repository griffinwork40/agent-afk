import { describe, it, expect } from 'vitest';
import { deriveSessionFacet } from './derive.js';
import { SessionFacetSchema, type StoredSessionInput } from './schema.js';

function richSession(): StoredSessionInput {
  return {
    sessionId: 'sess-123',
    name: 'add-user-auth-flow',
    model: 'opus',
    startedAt: 1_000_000,
    savedAt: 1_000_000 + 5 * 60_000, // +5 min
    totalTurns: 2,
    totalCostUsd: 0,
    totalTokens: 100,
    totalDurationMs: 5 * 60_000,
    turns: [
      {
        user: '/deploy the auth service',
        assistant: 'Done — deployed.',
        timestamp: 1,
        toolEvents: [
          { toolName: 'read_file', toolUseId: 'a', input: JSON.stringify({ file_path: '/src/a.ts' }) },
          { toolName: 'write_file', toolUseId: 'b', input: JSON.stringify({ file_path: '/src/b.ts', content: 'x' }) },
          { toolName: 'edit_file', toolUseId: 'c', input: JSON.stringify({ file_path: '/src/a.ts' }) },
          { toolName: 'bash', toolUseId: 'd', input: JSON.stringify({ command: 'git commit -m "x"' }) },
          { toolName: 'bash', toolUseId: 'e', input: JSON.stringify({ command: 'ls' }), isError: true },
          { toolName: 'agent', toolUseId: 'f', input: JSON.stringify({ id_prefix: 'verify', prompt: '…' }) },
          { toolName: 'skill', toolUseId: 'g', input: JSON.stringify({ name: 'review', arguments: '' }) },
          { toolName: 'compose', toolUseId: 'h', input: JSON.stringify({ nodes: [] }) },
        ],
      },
      {
        user: 'thanks',
        assistant: 'You are welcome.',
        timestamp: 2,
        toolEvents: [{ toolName: 'read_file', toolUseId: 'i', input: JSON.stringify({ file_path: '/src/b.ts' }) }],
      },
    ],
  };
}

describe('deriveSessionFacet', () => {
  it('produces a schema-valid facet', () => {
    const facet = deriveSessionFacet(richSession());
    expect(SessionFacetSchema.safeParse(facet).success).toBe(true);
    expect(facet.facet_version).toBe(5);
    expect(facet.derived_from).toBe('afk-session');
  });

  it('derives identity and timestamps', () => {
    const facet = deriveSessionFacet(richSession());
    expect(facet.session_id).toBe('sess-123');
    expect(facet.source).toBe('cli'); // undefined source → cli
    expect(facet.model).toBe('opus');
    expect(facet.duration_minutes).toBe(5);
    expect(facet.start_time).toBe(new Date(1_000_000).toISOString());
  });

  it('aggregates tool counts and errors mechanically', () => {
    const facet = deriveSessionFacet(richSession());
    expect(facet.tool_counts).toEqual({
      read_file: 2,
      write_file: 1,
      edit_file: 1,
      bash: 2,
      agent: 1,
      skill: 1,
      compose: 1,
    });
    expect(facet.tool_errors).toBe(1);
    expect(facet.tool_error_categories).toEqual({ bash: 1 });
    expect(facet.friction_counts).toEqual({ bash: 1 });
    expect(facet.friction_detail).toBe('1 tool error(s): bash×1');
  });

  it('reconstructs subagent invocations and stamps not_persisted', () => {
    const facet = deriveSessionFacet(richSession());
    expect(facet.subagent_persistence).toBe('not_persisted');
    expect(facet.subagents).toEqual([
      { tool: 'agent', label: 'verify' },
      { tool: 'skill', label: 'review' },
      { tool: 'compose', label: 'compose' },
    ]);
    expect(facet.skills).toEqual(['review']);
  });

  it('extracts slash commands and counts messages', () => {
    const facet = deriveSessionFacet(richSession());
    expect(facet.commands).toEqual(['deploy']);
    expect(facet.total_turns).toBe(2);
    expect(facet.user_message_count).toBe(2);
    expect(facet.assistant_message_count).toBe(2);
  });

  it('derives world changes and evidence pointers', () => {
    const facet = deriveSessionFacet(richSession());
    expect(facet.world_changes).toEqual({
      files_written: 1,
      files_edited: 1,
      bash_commands: 2,
      commits: 1,
      mutated: true,
    });
    expect(facet.evidence_pointers).toEqual(['/src/a.ts', '/src/b.ts']);
  });

  it('classifies outcome and semantic fields for a completed session', () => {
    const facet = deriveSessionFacet(richSession());
    expect(facet.outcome).toBe('fully_achieved');
    expect(facet.primary_success).toBe('You are welcome.');
    expect(facet.session_type).toBe('slash_command');
    expect(facet.goal_categories).toEqual({ slash_command: 1 });
    expect(facet.underlying_goal).toBe('/deploy the auth service');
    expect(facet.brief_summary).toContain('add user auth flow');
    expect(facet.brief_summary).toContain('You are welcome.');
    expect(facet.decisions).toEqual([]);
  });

  it('uses an injected clock for deterministic derived_at', () => {
    const facet = deriveSessionFacet(richSession(), { derivedAt: new Date(0) });
    expect(facet.derived_at).toBe('1970-01-01T00:00:00.000Z');
  });

  it('appends the source session path to evidence when provided', () => {
    const facet = deriveSessionFacet(richSession(), { sourceSessionPath: '/sessions/sess-123.json' });
    expect(facet.evidence_pointers).toEqual(['/src/a.ts', '/src/b.ts', '/sessions/sess-123.json']);
    expect(facet.source_session_path).toBe('/sessions/sess-123.json');
  });

  it('treats a zero-turn session as aborted with empty friction', () => {
    const facet = deriveSessionFacet({
      sessionId: 'empty-1',
      model: 'haiku',
      startedAt: 0,
      savedAt: 0,
      totalTurns: 0,
      turns: [],
    });
    expect(facet.outcome).toBe('aborted');
    expect(facet.primary_success).toBe('none');
    expect(facet.friction_detail).toBe('');
    expect(facet.friction_counts).toEqual({});
    expect(facet.tool_errors).toBe(0);
    expect(facet.brief_summary).toBe('empty session');
    expect(facet.session_type).toBe('task');
  });

  it('marks a session with no completed assistant reply as partially_achieved', () => {
    const facet = deriveSessionFacet({
      sessionId: 'partial-1',
      model: 'sonnet',
      startedAt: 0,
      savedAt: 0,
      totalTurns: 1,
      turns: [{ user: 'hi', assistant: '', timestamp: 1 }],
    });
    expect(facet.outcome).toBe('partially_achieved');
    expect(facet.primary_success).toBe('hi');
    expect(facet.assistant_message_count).toBe(0);
  });

  it('survives malformed tool input without throwing', () => {
    const facet = deriveSessionFacet({
      sessionId: 'bad-input',
      model: 'opus',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [
        {
          user: 'go',
          assistant: 'ok',
          timestamp: 1,
          toolEvents: [
            { toolName: 'bash', toolUseId: 'x', input: 'not-json-at-all' },
            { toolName: 'write_file', toolUseId: 'y' }, // no input field
          ],
        },
      ],
    });
    expect(facet.tool_counts).toEqual({ bash: 1, write_file: 1 });
    expect(facet.world_changes.files_written).toBe(1);
    expect(facet.world_changes.commits).toBe(0);
    expect(facet.evidence_pointers).toEqual([]);
  });

  it('prefers inputRaw over the summarized input for exact field extraction', () => {
    // `input` is the summarized hint a provider emits (NOT valid JSON for field
    // extraction); `inputRaw` carries the exact whitelisted fields. Derivation
    // must read inputRaw — if the wire dropped it, the non-JSON `input` fallback
    // would extract nothing and these assertions would fail.
    const facet = deriveSessionFacet({
      sessionId: 'raw-precedence',
      model: 'opus',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [
        {
          user: 'go',
          assistant: 'ok',
          timestamp: 1,
          toolEvents: [
            { toolName: 'bash', toolUseId: 'a', input: ' git commit', inputRaw: JSON.stringify({ command: 'git commit -m "x"' }) },
            { toolName: 'write_file', toolUseId: 'b', input: ' /src/a.ts', inputRaw: JSON.stringify({ file_path: '/src/a.ts' }) },
          ],
        },
      ],
    });
    expect(facet.world_changes.commits).toBe(1);
    expect(facet.world_changes.bash_commands).toBe(1);
    expect(facet.world_changes.files_written).toBe(1);
    expect(facet.evidence_pointers).toEqual(['/src/a.ts']);
  });

  it('commit detection: counts real git commit, excludes commit-tree, falls back to summarized input', () => {
    // inputRaw path: commit-tree must not increment commits
    const f1 = deriveSessionFacet({
      sessionId: 'commit-re', model: 'opus', startedAt: 0, savedAt: 60_000, totalTurns: 1,
      turns: [{ user: 'go', assistant: 'ok', timestamp: 1, toolEvents: [
        { toolName: 'bash', toolUseId: '1', inputRaw: JSON.stringify({ command: 'git commit -m "real"' }) },
        { toolName: 'bash', toolUseId: '2', inputRaw: JSON.stringify({ command: 'git commit-tree HEAD' }) },
      ] }],
    });
    expect(f1.world_changes.commits).toBe(1);
    // summarized-input fallback: post-fix sidecars omit inputRaw command
    const f2 = deriveSessionFacet({
      sessionId: 'summarized-commit', model: 'opus', startedAt: 0, savedAt: 60_000, totalTurns: 1,
      turns: [{ user: 'go', assistant: 'ok', timestamp: 1, toolEvents: [
        { toolName: 'bash', toolUseId: '1', input: ' git commit -m "real"' },
        { toolName: 'bash', toolUseId: '2', input: ' git commit-tree HEAD' },
      ] }],
    });
    expect(f2.world_changes.commits).toBe(1);
    expect(f2.world_changes.bash_commands).toBe(2);
  });

  it('collapses the duplicate placeholder+real tool events the recorder persists', () => {
    // The Anthropic streaming pipeline records TWO ToolEvent entries per tool
    // call under one toolUseId: an early placeholder (input ' …', no result)
    // pushed during streaming, then the real post-stream entry (summarized
    // input + result). Both land in turns[].toolEvents. Mechanical counts must
    // collapse them by toolUseId — counting each tool ONCE, not twice.
    const facet = deriveSessionFacet({
      sessionId: 'dup-events',
      model: 'opus',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [
        {
          user: 'go',
          assistant: 'ok',
          timestamp: 1,
          toolEvents: [
            // placeholders (emitted first, during streaming — no inputRaw, no result)
            { toolName: 'bash', toolUseId: 'tu_1', input: ' …' },
            { toolName: 'write_file', toolUseId: 'tu_2', input: ' …' },
            { toolName: 'bash', toolUseId: 'tu_3', input: ' …' },
            // real entries (emitted post-stream, SAME ids, with summary + result)
            { toolName: 'bash', toolUseId: 'tu_1', input: ' git commit -m "x"', isError: false },
            {
              toolName: 'write_file',
              toolUseId: 'tu_2',
              input: ' /src/a.ts',
              inputRaw: JSON.stringify({ file_path: '/src/a.ts' }),
              isError: false,
            },
            { toolName: 'bash', toolUseId: 'tu_3', input: ' ls', isError: false },
          ],
        },
      ],
    });
    // Without dedup these would be {bash: 4, write_file: 2}.
    expect(facet.tool_counts).toEqual({ bash: 2, write_file: 1 });
    expect(facet.world_changes.bash_commands).toBe(2);
    expect(facet.world_changes.files_written).toBe(1);
    expect(facet.world_changes.commits).toBe(1);
    expect(facet.evidence_pointers).toEqual(['/src/a.ts']);
  });

  it('counts events without a toolUseId individually (cannot be paired)', () => {
    // Defensive: events lacking a toolUseId can't be deduped, so each must count.
    const facet = deriveSessionFacet({
      sessionId: 'no-id',
      model: 'opus',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [
        {
          user: 'go',
          assistant: 'ok',
          timestamp: 1,
          toolEvents: [
            { toolName: 'read_file', input: JSON.stringify({ file_path: '/a.ts' }) },
            { toolName: 'read_file', input: JSON.stringify({ file_path: '/b.ts' }) },
          ],
        },
      ],
    });
    expect(facet.tool_counts).toEqual({ read_file: 2 });
  });

  it('populates token_breakdown when totalCostUsd is present', () => {
    const facet = deriveSessionFacet({
      sessionId: 'cost-sess',
      model: 'opus',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 0,
      totalCostUsd: 0.05,
      turns: [],
    });
    expect(facet.token_breakdown).toBeDefined();
    expect(facet.token_breakdown?.cost_usd).toBe(0.05);
    // Per-direction fields are omitted (not zero-filled) when StoredSession
    // only carries totalCostUsd — they are not available as per-direction counts.
    expect(facet.token_breakdown?.input).toBeUndefined();
    expect(facet.token_breakdown?.output).toBeUndefined();
    expect(facet.token_breakdown?.cache_read).toBeUndefined();
    expect(facet.token_breakdown?.cache_creation).toBeUndefined();
  });

  it('token_breakdown absent when neither totalCostUsd nor totalTokens set', () => {
    const facet = deriveSessionFacet({
      sessionId: 'no-cost',
      model: 'opus',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 0,
      turns: [],
    });
    expect(facet.token_breakdown).toBeUndefined();
  });

  it('token_breakdown absent when only totalTokens is set (no cost data)', () => {
    const facet = deriveSessionFacet({
      sessionId: 'tokens-only',
      model: 'opus',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 0,
      totalCostUsd: undefined,
      totalTokens: 500,
      turns: [],
    });
    expect(facet.token_breakdown).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // parallel_dispatch metric (#2015)
  // ---------------------------------------------------------------------------

  it('parallel_dispatch: ratio is null for a zero-tool-call session', () => {
    const facet = deriveSessionFacet({
      sessionId: 'no-tools',
      model: 'opus',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [{ user: 'hi', assistant: 'hello', timestamp: 1 }],
    });
    expect(facet.parallel_dispatch).toEqual({
      total_tool_calls: 0,
      parallel_tool_calls: 0,
      parallel_turns: 0,
      tool_turns: 0,
      ratio: null,
    });
  });

  it('parallel_dispatch: all sequential (one tool per turn) yields ratio 0', () => {
    const facet = deriveSessionFacet({
      sessionId: 'sequential',
      model: 'opus',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 2,
      turns: [
        {
          user: 'go',
          assistant: 'ok',
          timestamp: 1,
          toolEvents: [{ toolName: 'bash', toolUseId: 'a', input: '{}' }],
        },
        {
          user: '',
          assistant: 'done',
          timestamp: 2,
          toolEvents: [{ toolName: 'read_file', toolUseId: 'b', input: '{}' }],
        },
      ],
    });
    expect(facet.parallel_dispatch.total_tool_calls).toBe(2);
    expect(facet.parallel_dispatch.parallel_tool_calls).toBe(0);
    expect(facet.parallel_dispatch.parallel_turns).toBe(0);
    expect(facet.parallel_dispatch.tool_turns).toBe(2);
    expect(facet.parallel_dispatch.ratio).toBe(0);
  });

  it('parallel_dispatch: all parallel (all tools in one turn) yields ratio 1', () => {
    const facet = deriveSessionFacet({
      sessionId: 'all-parallel',
      model: 'opus',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [
        {
          user: 'go',
          assistant: 'done',
          timestamp: 1,
          toolEvents: [
            { toolName: 'bash', toolUseId: 'a', input: '{}' },
            { toolName: 'read_file', toolUseId: 'b', input: '{}' },
            { toolName: 'grep', toolUseId: 'c', input: '{}' },
          ],
        },
      ],
    });
    expect(facet.parallel_dispatch.total_tool_calls).toBe(3);
    expect(facet.parallel_dispatch.parallel_tool_calls).toBe(3);
    expect(facet.parallel_dispatch.parallel_turns).toBe(1);
    expect(facet.parallel_dispatch.tool_turns).toBe(1);
    expect(facet.parallel_dispatch.ratio).toBe(1);
  });

  it('parallel_dispatch: mixed turns correctly splits parallel vs sequential', () => {
    // Turn 1: 3 tools (parallel) → contributes 3 parallel_tool_calls
    // Turn 2: 1 tool (sequential) → contributes 0 parallel_tool_calls
    // Turn 3: 2 tools (parallel) → contributes 2 parallel_tool_calls
    // total_tool_calls = 6, parallel_tool_calls = 5, ratio = 5/6
    const facet = deriveSessionFacet({
      sessionId: 'mixed',
      model: 'opus',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 3,
      turns: [
        {
          user: 'step 1',
          assistant: 'ok1',
          timestamp: 1,
          toolEvents: [
            { toolName: 'bash', toolUseId: 'a', input: '{}' },
            { toolName: 'read_file', toolUseId: 'b', input: '{}' },
            { toolName: 'grep', toolUseId: 'c', input: '{}' },
          ],
        },
        {
          user: '',
          assistant: 'ok2',
          timestamp: 2,
          toolEvents: [{ toolName: 'write_file', toolUseId: 'd', input: '{}' }],
        },
        {
          user: '',
          assistant: 'ok3',
          timestamp: 3,
          toolEvents: [
            { toolName: 'bash', toolUseId: 'e', input: '{}' },
            { toolName: 'glob', toolUseId: 'f', input: '{}' },
          ],
        },
      ],
    });
    expect(facet.parallel_dispatch.total_tool_calls).toBe(6);
    expect(facet.parallel_dispatch.parallel_tool_calls).toBe(5);
    expect(facet.parallel_dispatch.parallel_turns).toBe(2);
    expect(facet.parallel_dispatch.tool_turns).toBe(3);
    expect(facet.parallel_dispatch.ratio).toBeCloseTo(5 / 6);
  });

  it('parallel_dispatch: deduplicates placeholder+real event pairs per turn', () => {
    // Each toolUseId appears twice (placeholder + real) — dedup must count each once.
    // 2 unique tools in one turn → parallel turn, ratio = 1.
    const facet = deriveSessionFacet({
      sessionId: 'parallel-dedup',
      model: 'opus',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [
        {
          user: 'go',
          assistant: 'done',
          timestamp: 1,
          toolEvents: [
            // placeholders
            { toolName: 'bash', toolUseId: 'tu_1', input: ' …' },
            { toolName: 'read_file', toolUseId: 'tu_2', input: ' …' },
            // real entries
            { toolName: 'bash', toolUseId: 'tu_1', input: ' ls', isError: false },
            { toolName: 'read_file', toolUseId: 'tu_2', input: ' /a.ts', isError: false },
          ],
        },
      ],
    });
    expect(facet.parallel_dispatch.total_tool_calls).toBe(2);
    expect(facet.parallel_dispatch.parallel_tool_calls).toBe(2);
    expect(facet.parallel_dispatch.parallel_turns).toBe(1);
    expect(facet.parallel_dispatch.ratio).toBe(1);
  });

  it('parallel_dispatch: turns with no toolEvents are ignored', () => {
    // Turns without any tools should not count as "tool turns".
    const facet = deriveSessionFacet({
      sessionId: 'no-tool-turns',
      model: 'opus',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 2,
      turns: [
        { user: 'hello', assistant: 'hi', timestamp: 1 },
        {
          user: '',
          assistant: 'done',
          timestamp: 2,
          toolEvents: [
            { toolName: 'bash', toolUseId: 'x', input: '{}' },
            { toolName: 'bash', toolUseId: 'y', input: '{}' },
          ],
        },
      ],
    });
    expect(facet.parallel_dispatch.tool_turns).toBe(1);
    expect(facet.parallel_dispatch.parallel_turns).toBe(1);
    expect(facet.parallel_dispatch.total_tool_calls).toBe(2);
    expect(facet.parallel_dispatch.parallel_tool_calls).toBe(2);
    expect(facet.parallel_dispatch.ratio).toBe(1);
  });

  it('parallel_dispatch: schema-valid and present in the richSession facet', () => {
    const facet = deriveSessionFacet(richSession());
    // richSession has 2 turns:
    //   turn 0: 8 tool events (7 unique toolUseIds a-h + one implicitly paired)
    //   turn 1: 1 tool event (i)
    // After dedup: turn 0 has 8 unique calls (parallel), turn 1 has 1 (sequential).
    // parallel_tool_calls = 8, total_tool_calls = 9, ratio = 8/9
    expect(facet.parallel_dispatch).toBeDefined();
    expect(typeof facet.parallel_dispatch.ratio).toBe('number');
    expect(facet.parallel_dispatch.ratio).toBeCloseTo(8 / 9);
    expect(facet.parallel_dispatch.parallel_turns).toBe(1);
    expect(facet.parallel_dispatch.tool_turns).toBe(2);
  });

  // yield_tracking (#2016)
  it('yield_tracking: non-daemon sessions have is_scheduled_session=false and null pr fields', () => {
    const facet = deriveSessionFacet(richSession());
    expect(facet.yield_tracking).toEqual({
      is_scheduled_session: false,
      produced_pr: null,
      pr_merged: null,
    });
  });

  it('yield_tracking: daemon source sets is_scheduled_session=true', () => {
    const session = { ...richSession(), source: 'daemon' as const };
    const facet = deriveSessionFacet(session);
    expect(facet.yield_tracking.is_scheduled_session).toBe(true);
    expect(facet.yield_tracking.produced_pr).toBeNull();
    expect(facet.yield_tracking.pr_merged).toBeNull();
  });

  it('yield_tracking: source field maps daemon correctly', () => {
    const session = { ...richSession(), source: 'daemon' as const };
    const facet = deriveSessionFacet(session);
    expect(facet.source).toBe('daemon');
  });

  it('yield_tracking: schema-valid in the base facet', () => {
    const facet = deriveSessionFacet(richSession());
    expect(SessionFacetSchema.safeParse(facet).success).toBe(true);
  });
});
