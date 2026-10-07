import { describe, it, expect } from 'vitest';
import { deriveSessionFacet, type DeriveOptions } from './derive.js';
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
    expect(facet.facet_version).toBe(11); // v11: trace-backed downgrade signals (#2798 cont.)
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

  it('tool_errors_total = parent errors + subagent errors (#2777)', () => {
    const facet = deriveSessionFacet(richSession(), {
      subagentBreakdown: [
        { subagent_id: 'sub-1', tool_calls: 5, tool_errors: 2, tool_counts: { bash: 5 } },
        { subagent_id: 'sub-2', tool_calls: 3, tool_errors: 1, tool_counts: { read_file: 3 } },
      ],
    });
    // parent tool_errors = 1 (from richSession), subagent = 2 + 1 = 3
    expect(facet.tool_errors).toBe(1);
    expect(facet.tool_errors_total).toBe(4);
  });

  it('tool_errors_total equals tool_errors when no subagent breakdown', () => {
    const facet = deriveSessionFacet(richSession());
    expect(facet.tool_errors_total).toBe(facet.tool_errors);
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

  it('classifies semantic fields for a completed session (no terminal heading → unknown)', () => {
    // richSession last assistant is "You are welcome." — no terminal-state heading
    // → outcome='unknown', outcome_source='none' (#2777)
    const facet = deriveSessionFacet(richSession());
    expect(facet.outcome).toBe('unknown');
    expect(facet.outcome_source).toBe('none');
    // For 'unknown', primary_success uses the last-assistant fallback (not 'none')
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
    expect(facet.outcome_source).toBe('structural');
    expect(facet.primary_success).toBe('none');
    expect(facet.friction_detail).toBe('');
    expect(facet.friction_counts).toEqual({});
    expect(facet.tool_errors).toBe(0);
    expect(facet.tool_errors_total).toBe(0);
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
    expect(facet.outcome_source).toBe('structural');
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
    expect(facet.yield_tracking.is_scheduled_session).toBe(false);
    expect(facet.yield_tracking.produced_pr).toBeNull();
    expect(facet.yield_tracking.pr_merged).toBeNull();
    expect(facet.yield_tracking.pr_url).toBeNull(); // pr_url added v7 (#2777)
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

  // produced_pr detection from gh pr create output (#2777)
  it('yield_tracking: detects produced_pr=true and pr_url from gh pr create bash result', () => {
    const prUrl = 'https://github.com/owner/repo/pull/42';
    const facet = deriveSessionFacet({
      sessionId: 'pr-detected',
      model: 'sonnet',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [{
        user: 'create a PR',
        assistant: 'Done.',
        timestamp: 1,
        toolEvents: [{
          toolName: 'bash',
          toolUseId: 'pr-1',
          input: 'gh pr create --title "feat: add auth"',
          result: `Creating pull request for main...\n${prUrl}\n`,
          isError: false,
        }],
      }],
    });
    expect(facet.yield_tracking.produced_pr).toBe(true);
    expect(facet.yield_tracking.pr_url).toBe(prUrl);
    expect(facet.yield_tracking.pr_merged).toBeNull(); // set async by probe
  });

  it('yield_tracking: no produced_pr when gh pr create has no URL in result', () => {
    const facet = deriveSessionFacet({
      sessionId: 'pr-no-url',
      model: 'sonnet',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [{
        user: 'create a PR',
        assistant: 'Done.',
        timestamp: 1,
        toolEvents: [{
          toolName: 'bash',
          toolUseId: 'pr-1',
          input: 'gh pr create --title "feat: add auth"',
          result: 'error: not a git repository',
          isError: true,
        }],
      }],
    });
    // isError=true → not detected
    expect(facet.yield_tracking.produced_pr).toBeNull();
    expect(facet.yield_tracking.pr_url).toBeNull();
  });

  // item 1: quoted search must NOT be detected as a gh pr create invocation
  it('yield_tracking: rg search for "gh pr create" with PR URL in output is NOT detected (#2781)', () => {
    const prUrl = 'https://github.com/owner/repo/pull/99';
    const facet = deriveSessionFacet({
      sessionId: 'pr-quoted-search',
      model: 'sonnet',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [{
        user: 'find gh pr create',
        assistant: 'ok',
        timestamp: 1,
        toolEvents: [{
          toolName: 'bash',
          toolUseId: 'search-1',
          // A grep/rg command that CONTAINS "gh pr create" inside quotes is not an invocation
          input: JSON.stringify({ command: 'rg -n "gh pr create" src' }),
          result: `src/agent/facets/derive.ts:197: if (/gh pr create/.test(inputStr)) {\n${prUrl}`,
          isError: false,
        }],
      }],
    });
    // The search command is not a `gh pr create` invocation — must not detect PR
    expect(facet.yield_tracking.produced_pr).toBeNull();
    expect(facet.yield_tracking.pr_url).toBeNull();
  });

  // item 1: real gh pr create invocation with a URL line is detected; last URL wins
  it('yield_tracking: real gh pr create with two URL lines records the LAST one (#2781)', () => {
    const url1 = 'https://github.com/owner/repo/pull/10';
    const url2 = 'https://github.com/owner/repo/pull/11';
    const facet = deriveSessionFacet({
      sessionId: 'pr-last-url',
      model: 'sonnet',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [{
        user: 'create PRs',
        assistant: 'Done.',
        timestamp: 1,
        toolEvents: [{
          toolName: 'bash',
          toolUseId: 'pr-two',
          input: JSON.stringify({ command: 'gh pr create --title "feat"' }),
          result: `${url1}\n${url2}`,
          isError: false,
        }],
      }],
    });
    expect(facet.yield_tracking.produced_pr).toBe(true);
    expect(facet.yield_tracking.pr_url).toBe(url2);
  });

  // item 5: truncated bash input ending in '…' with a bare-URL result is detected
  it('yield_tracking: truncated bash input (ends in …) with bare PR URL result is detected (#2781)', () => {
    const prUrl = 'https://github.com/owner/repo/pull/55';
    const facet = deriveSessionFacet({
      sessionId: 'pr-truncated',
      model: 'sonnet',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [{
        user: 'push and create PR',
        assistant: 'Done.',
        timestamp: 1,
        toolEvents: [{
          toolName: 'bash',
          toolUseId: 'pr-trunc',
          // Truncated summary: the `gh pr create` part was cut off entirely
          input: 'cd .afk-worktrees/feat-x && git push -u origin afk/feat-x && \u2026',
          result: `${prUrl}\n`,
          isError: false,
        }],
      }],
    });
    expect(facet.yield_tracking.produced_pr).toBe(true);
    expect(facet.yield_tracking.pr_url).toBe(prUrl);
  });

  it('yield_tracking: truncated non-create input whose multi-line output has a URL line is NOT detected (#2781)', () => {
    const facet = deriveSessionFacet({
      sessionId: 'pr-truncated-neg',
      model: 'sonnet',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [{
        user: 'look at notes',
        assistant: 'Done.',
        timestamp: 1,
        toolEvents: [{
          toolName: 'bash',
          toolUseId: 'pr-trunc-neg',
          input: 'cd .afk-worktrees/feat-x && cat docs/notes/very-long-file-name.md \u2026',
          result: 'See the earlier PR:\nhttps://github.com/other/repo/pull/9\nfor details.\n',
          isError: false,
        }],
      }],
    });
    expect(facet.yield_tracking.produced_pr).toBeNull();
    expect(facet.yield_tracking.pr_url ?? null).toBeNull();
  });

  it('yield_tracking: env-prefixed gh pr create is detected (#2781)', () => {
    const prUrl = 'https://github.com/owner/repo/pull/78';
    const facet = deriveSessionFacet({
      sessionId: 'pr-env-prefixed',
      model: 'sonnet',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [{
        user: 'ship',
        assistant: 'Done.',
        timestamp: 1,
        toolEvents: [{
          toolName: 'bash',
          toolUseId: 'pr-env',
          input: JSON.stringify({ command: 'GH_TOKEN=abc GH_REPO=owner/repo gh pr create --fill' }),
          result: `${prUrl}\n`,
          isError: false,
        }],
      }],
    });
    expect(facet.yield_tracking.pr_url).toBe(prUrl);
  });

  it('yield_tracking: gh pr create chained after git push is detected (#2781)', () => {
    const prUrl = 'https://github.com/owner/repo/pull/77';
    const facet = deriveSessionFacet({
      sessionId: 'pr-chained',
      model: 'sonnet',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [{
        user: 'ship',
        assistant: 'Done.',
        timestamp: 1,
        toolEvents: [{
          toolName: 'bash',
          toolUseId: 'pr-chained',
          input: JSON.stringify({ command: 'cd .afk-worktrees/x && git push && gh pr create --body-file /tmp/b.md' }),
          result: `Warning: 1 uncommitted change\n${prUrl}\n`,
          isError: false,
        }],
      }],
    });
    expect(facet.yield_tracking.pr_url).toBe(prUrl);
  });

  // ---------------------------------------------------------------------------
  // #2795: detection gaps — quoted separators, $(), flattened multi-line
  // ---------------------------------------------------------------------------

  it('yield_tracking: quoted "|" separator does NOT trigger false positive (#2795)', () => {
    // rg "gh pr view|gh pr create " src — the | is inside quotes; stripping
    // quoted spans must prevent it from being treated as a shell separator.
    const prUrl = 'https://github.com/owner/repo/pull/99';
    const facet = deriveSessionFacet({
      sessionId: 'pr-quoted-pipe',
      model: 'sonnet',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [{
        user: 'search',
        assistant: 'ok',
        timestamp: 1,
        toolEvents: [{
          toolName: 'bash',
          toolUseId: 'q-pipe',
          input: JSON.stringify({ command: 'rg "gh pr view|gh pr create " src' }),
          // Even if the result happens to contain a URL line, no PR should be detected
          result: `src/agent/facets/derive.ts:75:\n${prUrl}`,
          isError: false,
        }],
      }],
    });
    expect(facet.yield_tracking.produced_pr).toBeNull();
    expect(facet.yield_tracking.pr_url).toBeNull();
  });

  it('yield_tracking: $() subshell invocation is detected (#2795)', () => {
    // PR=$(gh pr create --fill) — the open-paren before gh pr create is now
    // recognized as a valid invocation boundary.
    const prUrl = 'https://github.com/owner/repo/pull/101';
    const facet = deriveSessionFacet({
      sessionId: 'pr-subshell',
      model: 'sonnet',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [{
        user: 'ship',
        assistant: 'Done.',
        timestamp: 1,
        toolEvents: [{
          toolName: 'bash',
          toolUseId: 'sub-1',
          input: JSON.stringify({ command: 'PR=$(gh pr create --fill) && echo $PR' }),
          result: `${prUrl}\n`,
          isError: false,
        }],
      }],
    });
    expect(facet.yield_tracking.produced_pr).toBe(true);
    expect(facet.yield_tracking.pr_url).toBe(prUrl);
  });

  it('yield_tracking: bare ( subshell invocation is detected (#2795)', () => {
    const prUrl = 'https://github.com/owner/repo/pull/102';
    const facet = deriveSessionFacet({
      sessionId: 'pr-bare-paren',
      model: 'sonnet',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [{
        user: 'ship',
        assistant: 'Done.',
        timestamp: 1,
        toolEvents: [{
          toolName: 'bash',
          toolUseId: 'sub-2',
          input: JSON.stringify({ command: '(gh pr create --title "feat" --body "x")' }),
          result: `${prUrl}\n`,
          isError: false,
        }],
      }],
    });
    expect(facet.yield_tracking.produced_pr).toBe(true);
    expect(facet.yield_tracking.pr_url).toBe(prUrl);
  });

  it('yield_tracking: flattened multi-line with bare PR URL result is detected (#2795)', () => {
    // `git push\ngh pr create --fill` flattened by summarizeToolInput to a
    // space-separated string with no shell separator before `gh`. When the
    // result is a bare PR URL (gh pr create's stdout shape), it should be
    // detected via the word-boundary fallback.
    const prUrl = 'https://github.com/owner/repo/pull/103';
    const facet = deriveSessionFacet({
      sessionId: 'pr-flattened',
      model: 'sonnet',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [{
        user: 'ship',
        assistant: 'Done.',
        timestamp: 1,
        toolEvents: [{
          toolName: 'bash',
          toolUseId: 'flat-1',
          // Stored as a summarized (flattened) input — no inputRaw — so detection
          // must work on the flattened string.
          input: 'git push gh pr create --fill',
          result: `${prUrl}\n`,
          isError: false,
        }],
      }],
    });
    expect(facet.yield_tracking.produced_pr).toBe(true);
    expect(facet.yield_tracking.pr_url).toBe(prUrl);
  });

  it('yield_tracking: flattened multi-line with non-bare result is NOT detected (#2795)', () => {
    // Word-boundary match only fires when the result is exclusively a PR URL.
    // A multi-line result (e.g. push output + URL mixed with other text) must
    // not be detected via the word-boundary path.
    const facet = deriveSessionFacet({
      sessionId: 'pr-flattened-neg',
      model: 'sonnet',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [{
        user: 'ship',
        assistant: 'Done.',
        timestamp: 1,
        toolEvents: [{
          toolName: 'bash',
          toolUseId: 'flat-neg',
          input: 'git push gh pr create --fill',
          result: 'Pushing to origin...\nhttps://github.com/owner/repo/pull/104\nDone.\n',
          isError: false,
        }],
      }],
    });
    expect(facet.yield_tracking.produced_pr).toBeNull();
    expect(facet.yield_tracking.pr_url).toBeNull();
  });

  it('yield_tracking: journalEvents path detects PR from gh pr create (#2795 gap 5)', () => {
    // No existing test drives PR detection through journalEvents (the production
    // input shape for post-#2461 sessions). This drives the full path.
    const prUrl = 'https://github.com/owner/repo/pull/200';
    const facet = deriveSessionFacet(
      {
        sessionId: 'pr-journal',
        model: 'sonnet',
        startedAt: 0,
        savedAt: 60_000,
        totalTurns: 0,
        turns: [],
      },
      {
        journalEvents: [{
          toolName: 'bash',
          toolUseId: 'j-pr-1',
          input: JSON.stringify({ command: 'gh pr create --fill --title "feat: new"' }),
          result: `${prUrl}\n`,
          isError: false,
        }],
      },
    );
    expect(facet.yield_tracking.produced_pr).toBe(true);
    expect(facet.yield_tracking.pr_url).toBe(prUrl);
  });

  it('yield_tracking: journalEvents path with $() subshell detects PR (#2795 gap 5)', () => {
    const prUrl = 'https://github.com/owner/repo/pull/201';
    const facet = deriveSessionFacet(
      {
        sessionId: 'pr-journal-sub',
        model: 'sonnet',
        startedAt: 0,
        savedAt: 60_000,
        totalTurns: 0,
        turns: [],
      },
      {
        journalEvents: [{
          toolName: 'bash',
          toolUseId: 'j-sub-1',
          input: JSON.stringify({ command: 'URL=$(gh pr create --fill) && echo $URL' }),
          result: `${prUrl}\n`,
          isError: false,
        }],
      },
    );
    expect(facet.yield_tracking.produced_pr).toBe(true);
    expect(facet.yield_tracking.pr_url).toBe(prUrl);
  });

  // ---------------------------------------------------------------------------
  // #2795 gap 6: PRs opened by subagents propagate to the parent facet
  // ---------------------------------------------------------------------------

  it('yield_tracking: subagent-opened PR detected via subagentBreakdown (#2795 gap 6)', () => {
    // A /ship subagent runs gh pr create; the parent never touches `gh`.
    // The subagent breakdown carries detected_pr_url; derive must promote it.
    const prUrl = 'https://github.com/owner/repo/pull/500';
    const facet = deriveSessionFacet(
      {
        sessionId: 'pr-subagent',
        model: 'sonnet',
        startedAt: 0,
        savedAt: 60_000,
        totalTurns: 1,
        turns: [{ user: '/ship', assistant: 'Done.', timestamp: 1 }],
      },
      {
        subagentBreakdown: [{
          subagent_id: 'ship-worker',
          tool_calls: 5,
          tool_errors: 0,
          tool_counts: { bash: 5 },
          detected_pr_url: prUrl,
        }],
      },
    );
    expect(facet.yield_tracking.produced_pr).toBe(true);
    expect(facet.yield_tracking.pr_url).toBe(prUrl);
  });

  it('yield_tracking: parent-opened PR takes precedence over subagent URL (#2795 gap 6)', () => {
    // Both parent and subagent detect a PR; parent URL wins.
    const parentUrl = 'https://github.com/owner/repo/pull/501';
    const subUrl = 'https://github.com/owner/repo/pull/502';
    const facet = deriveSessionFacet(
      {
        sessionId: 'pr-both',
        model: 'sonnet',
        startedAt: 0,
        savedAt: 60_000,
        totalTurns: 1,
        turns: [{
          user: '/ship',
          assistant: 'Done.',
          timestamp: 1,
          toolEvents: [{
            toolName: 'bash',
            toolUseId: 'parent-pr',
            input: JSON.stringify({ command: 'gh pr create --fill' }),
            result: `${parentUrl}\n`,
            isError: false,
          }],
        }],
      },
      {
        subagentBreakdown: [{
          subagent_id: 'sub-ship',
          tool_calls: 3,
          tool_errors: 0,
          tool_counts: { bash: 3 },
          detected_pr_url: subUrl,
        }],
      },
    );
    // Parent URL should win
    expect(facet.yield_tracking.produced_pr).toBe(true);
    expect(facet.yield_tracking.pr_url).toBe(parentUrl);
  });

  it('yield_tracking: no subagent PR when detected_pr_url absent from breakdown (#2795 gap 6)', () => {
    const facet = deriveSessionFacet(
      {
        sessionId: 'pr-sub-none',
        model: 'sonnet',
        startedAt: 0,
        savedAt: 60_000,
        totalTurns: 1,
        turns: [{ user: '/deploy', assistant: 'Done.', timestamp: 1 }],
      },
      {
        subagentBreakdown: [{
          subagent_id: 'deploy-worker',
          tool_calls: 3,
          tool_errors: 0,
          tool_counts: { bash: 3 },
          // no detected_pr_url
        }],
      },
    );
    expect(facet.yield_tracking.produced_pr).toBeNull();
    expect(facet.yield_tracking.pr_url).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // #2834: $() inside double-quoted spans and GH_PR_CREATE_WORD_RE anchoring
  // ---------------------------------------------------------------------------

  it('yield_tracking: PR_URL="$(gh pr create --fill)" double-quoted command substitution is detected (#2834)', () => {
    // stripQuotedSpans erases the entire "$(gh pr create --fill)" span, so the
    // invocation RE must also be tested against the raw (unstripped) input.
    const prUrl = 'https://github.com/owner/repo/pull/300';
    const facet = deriveSessionFacet({
      sessionId: 'pr-dq-subst',
      model: 'sonnet',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [{
        user: 'ship',
        assistant: 'Done.',
        timestamp: 1,
        toolEvents: [{
          toolName: 'bash',
          toolUseId: 'dq-sub-1',
          input: JSON.stringify({ command: 'PR_URL="$(gh pr create --fill)" && echo "$PR_URL"' }),
          result: `${prUrl}\n`,
          isError: false,
        }],
      }],
    });
    expect(facet.yield_tracking.produced_pr).toBe(true);
    expect(facet.yield_tracking.pr_url).toBe(prUrl);
  });

  it('yield_tracking: quoted-separator rg search is NOT false-positive even with raw input test (#2834)', () => {
    // Regression guard: testing raw input must not re-introduce the quoted-separator
    // false positive that stripQuotedSpans was added to prevent.
    // In raw form, 'rg "gh pr view|gh pr create" src' does NOT match INVOCATION_RE
    // because `gh pr create"` ends with `"` (no trailing space or EOL) so the
    // mandatory trailing `(?:[ \t]|$)` fails. Both raw and stripped paths must be false.
    const prUrl = 'https://github.com/owner/repo/pull/301';
    const facet = deriveSessionFacet({
      sessionId: 'pr-dq-quoted-sep-guard',
      model: 'sonnet',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [{
        user: 'search',
        assistant: 'ok',
        timestamp: 1,
        toolEvents: [{
          toolName: 'bash',
          toolUseId: 'dq-sep-1',
          input: JSON.stringify({ command: 'rg "gh pr view|gh pr create" src' }),
          result: `src/agent/facets/derive.ts:90:\n${prUrl}`,
          isError: false,
        }],
      }],
    });
    expect(facet.yield_tracking.produced_pr).toBeNull();
    expect(facet.yield_tracking.pr_url).toBeNull();
  });

  it('yield_tracking: path-prefixed gh (e.g. /usr/bin/gh pr create) is NOT detected by word-boundary fallback (#2834)', () => {
    // GH_PR_CREATE_WORD_RE previously used \b which matched 'gh' after '/' (a
    // non-word char). The lookbehind (?<![\\/\w-]) rejects it.
    const prUrl = 'https://github.com/owner/repo/pull/302';
    const facet = deriveSessionFacet({
      sessionId: 'pr-path-prefix-guard',
      model: 'sonnet',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [{
        user: 'check help',
        assistant: 'ok',
        timestamp: 1,
        toolEvents: [{
          toolName: 'bash',
          toolUseId: 'path-gh-1',
          // Flattened-style input (no inputRaw): the stored summary string
          // happens to contain '/usr/local/bin/gh pr create' with no separator
          // before 'gh'. WORD_RE fallback must NOT fire since gh follows '/'.
          input: 'git push /usr/local/bin/gh pr create --fill',
          result: `${prUrl}\n`,
          isError: false,
        }],
      }],
    });
    expect(facet.yield_tracking.produced_pr).toBeNull();
    expect(facet.yield_tracking.pr_url).toBeNull();
  });

  // outcome derived from terminal-state heading
  function oneAssistant(assistant: string): StoredSessionInput {
    return {
      sessionId: 'ts-test',
      model: 'sonnet',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      // Include a write_file event so Done sessions don't trigger the
      // no_corroborating_evidence downgrade signal (#2798) and the terminal-state
      // heading tests can focus solely on outcome parsing.
      turns: [{ user: 'do something', assistant, timestamp: 1, toolEvents: [
        { toolName: 'write_file', toolUseId: 'ts-wf', inputRaw: JSON.stringify({ file_path: '/out.ts', content: 'x' }) },
      ] }],
    };
  }

  // Helpers that produce the real END_OF_TURN_DIRECTIVE format:
  // the state keyword on its own line, optionally followed by bullets.
  function doneMsg(whatWasDone?: string): string {
    const body = whatWasDone ? `\n- What was done: ${whatWasDone}` : '';
    return `Work is complete.\n\n**Done**${body}`;
  }

  it('terminal-state: **Done** standalone heading -> fully_achieved, outcome_source=terminal_state', () => {
    const facet = deriveSessionFacet(oneAssistant(doneMsg('all tasks finished')));
    expect(facet.outcome).toBe('fully_achieved');
    expect(facet.outcome_source).toBe('terminal_state');
  });

  it('terminal-state: primary_success uses whatWasDone when present', () => {
    const facet = deriveSessionFacet(oneAssistant(doneMsg('implemented the auth module')));
    expect(facet.outcome).toBe('fully_achieved');
    expect(facet.primary_success).toBe('implemented the auth module');
  });

  it('terminal-state: primary_success falls back to lastAssistant when no whatWasDone bullet', () => {
    // **Done** with no bullets — no whatWasDone parsed
    const msg = 'Work complete.\n\n**Done**';
    const facet = deriveSessionFacet(oneAssistant(msg));
    expect(facet.outcome).toBe('fully_achieved');
    // Falls back to the full last-assistant text
    expect(facet.primary_success).toContain('Work complete.');
  });

  it('terminal-state: **Blocked** -> not_achieved, primary_success is none', () => {
    const msg = 'Cannot proceed.\n\n**Blocked**\n- What blocks: waiting for credentials.';
    const facet = deriveSessionFacet(oneAssistant(msg));
    expect(facet.outcome).toBe('not_achieved');
    expect(facet.outcome_source).toBe('terminal_state');
    expect(facet.primary_success).toBe('none');
  });

  it('terminal-state: **Asking** -> partially_achieved', () => {
    const msg = 'One question before continuing.\n\n**Asking**\n- Question: which approach?';
    const facet = deriveSessionFacet(oneAssistant(msg));
    expect(facet.outcome).toBe('partially_achieved');
    expect(facet.outcome_source).toBe('terminal_state');
  });

  it('terminal-state: **Interrupted** -> aborted', () => {
    const facet = deriveSessionFacet(oneAssistant('Stopping here.\n\n**Interrupted**'));
    expect(facet.outcome).toBe('aborted');
    expect(facet.outcome_source).toBe('terminal_state');
  });

  it('terminal-state: heading-style ### Blocked -> not_achieved', () => {
    const facet = deriveSessionFacet(oneAssistant('Analysis done.\n\n### Blocked\n\nMissing API key.'));
    expect(facet.outcome).toBe('not_achieved');
    expect(facet.outcome_source).toBe('terminal_state');
  });

  it('terminal-state: heading-style ## Done -> fully_achieved', () => {
    const facet = deriveSessionFacet(oneAssistant('## Done\n\nAll changes applied.'));
    expect(facet.outcome).toBe('fully_achieved');
    expect(facet.outcome_source).toBe('terminal_state');
  });

  it('terminal-state: last-marker-wins when multiple markers present', () => {
    // First marker is Asking, last is Done — outcome should be fully_achieved
    const msg = '**Asking**\n- Question: clarification needed.\n\nActually never mind.\n\n**Done**\n- What was done: completed.';
    const facet = deriveSessionFacet(oneAssistant(msg));
    expect(facet.outcome).toBe('fully_achieved');
  });

  it('terminal-state: no marker -> outcome is unknown (not fully_achieved) (#2777)', () => {
    // #2777: non-empty assistant with no heading now yields 'unknown', not 'fully_achieved'.
    // Only interactive surfaces (REPL/daemon) get the terminal-state directive injected;
    // one-shot and subagent sessions produce headingless output → 'unknown'.
    const facet = deriveSessionFacet(oneAssistant('Here is the result, no heading marker at all.'));
    expect(facet.outcome).toBe('unknown');
    expect(facet.outcome_source).toBe('none');
    // primary_success still uses last-assistant fallback for 'unknown' (not 'none')
    expect(facet.primary_success).toBe('Here is the result, no heading marker at all.');
  });

  it('terminal-state: zero-turn session stays aborted regardless', () => {
    const facet = deriveSessionFacet({ sessionId: 'z', model: 'haiku', startedAt: 0, savedAt: 0, totalTurns: 0, turns: [] });
    expect(facet.outcome).toBe('aborted');
    expect(facet.outcome_source).toBe('structural');
  });

  it('terminal-state: empty assistant stays partially_achieved regardless', () => {
    const facet = deriveSessionFacet(oneAssistant(''));
    expect(facet.outcome).toBe('partially_achieved');
    expect(facet.outcome_source).toBe('structural');
  });

  it('terminal-state: case-insensitive match (## done lowercase heading)', () => {
    // The parser uses lineToKind which lower-cases the stripped line.
    // A standalone ## done heading must resolve to 'done'.
    const facet = deriveSessionFacet(oneAssistant('## done\n- What was done: lowercase variant'));
    expect(facet.outcome).toBe('fully_achieved');
    expect(facet.outcome_source).toBe('terminal_state');
  });

  it('terminal-state: inline **Done** — text style is not a valid heading (#2777)', () => {
    // The old derive.ts TERMINAL_STATE_RE accepted "**Done** — text" as a single
    // line. The shared parseTerminalState parser requires the heading line to be
    // dominated by the keyword — "**Done** — all tasks finished." is not.
    // This documents the intentional behavior change: inline-suffix style is rejected.
    // The real END_OF_TURN_DIRECTIVE emits "**Done**" on its own line.
    const facet = deriveSessionFacet(oneAssistant('**Done** — all tasks finished.'));
    expect(facet.outcome).toBe('unknown'); // not 'fully_achieved'
    expect(facet.outcome_source).toBe('none');
  });

  // --- compose_partial_nodes (#2970) ---
  describe('compose_partial_nodes', () => {
    function sessionWithToolEvent(events: Array<{ toolName: string; toolUseId: string; incomplete?: boolean; isError?: boolean; partialNodeCount?: number }>): StoredSessionInput {
      return {
        sessionId: 'partial-test',
        model: 'haiku',
        startedAt: 0,
        savedAt: 1000,
        totalTurns: 1,
        turns: [{ toolEvents: events }],
      };
    }

    it('is absent when no compose calls were made', () => {
      const facet = deriveSessionFacet(sessionWithToolEvent([
        { toolName: 'bash', toolUseId: 'a' },
      ]));
      expect(facet.compose_partial_nodes).toBeUndefined();
    });

    it('is absent when compose ran cleanly (no incomplete flag)', () => {
      const facet = deriveSessionFacet(sessionWithToolEvent([
        { toolName: 'compose', toolUseId: 'a' },
      ]));
      expect(facet.compose_partial_nodes).toBeUndefined();
    });

    it('counts 1 when a compose call carries incomplete: true (soft-deadline wind-down)', () => {
      // Acceptance criterion (#2970): a compose call with one wound-down node
      // shows compose_partial_nodes: 1 in the facet.
      const facet = deriveSessionFacet(sessionWithToolEvent([
        { toolName: 'compose', toolUseId: 'a', incomplete: true },
      ]));
      expect(facet.compose_partial_nodes).toBe(1);
    });

    it('counts multiple partial compose calls', () => {
      const facet = deriveSessionFacet(sessionWithToolEvent([
        { toolName: 'compose', toolUseId: 'a', incomplete: true },
        { toolName: 'compose', toolUseId: 'b' },
        { toolName: 'compose', toolUseId: 'c', incomplete: true },
      ]));
      expect(facet.compose_partial_nodes).toBe(2);
    });

    it('non-compose tools with incomplete: true do NOT count', () => {
      // Only compose tool partials are tracked; agent/skill/etc are not.
      const facet = deriveSessionFacet(sessionWithToolEvent([
        { toolName: 'agent', toolUseId: 'a', incomplete: true },
        { toolName: 'compose', toolUseId: 'b', incomplete: true },
      ]));
      expect(facet.compose_partial_nodes).toBe(1);
    });

    it('is schema-valid when populated', () => {
      const facet = deriveSessionFacet(sessionWithToolEvent([
        { toolName: 'compose', toolUseId: 'a', incomplete: true },
      ]));
      expect(SessionFacetSchema.safeParse(facet).success).toBe(true);
    });

    it('a hard-failed compose call (isError:true) is not counted as partial', () => {
      // node_timeout_ms goes to result.failed, making the compose result isError:true.
      // The compose executor never sets incomplete: true when isError is true (only
      // when result.partial is non-empty). Derive counts only compose events where
      // ev.incomplete === true, so this is correctly absent.
      const facet = deriveSessionFacet(sessionWithToolEvent([
        { toolName: 'compose', toolUseId: 'a', isError: true }, // hard failure; no incomplete
      ]));
      expect(facet.compose_partial_nodes).toBeUndefined();
    });

    // --- compose_partial_node_count (#2978) ---
    it('compose_partial_node_count sums partialNodeCount across calls', () => {
      const facet = deriveSessionFacet(sessionWithToolEvent([
        { toolName: 'compose', toolUseId: 'a', incomplete: true, partialNodeCount: 3 },
        { toolName: 'compose', toolUseId: 'b' },
        { toolName: 'compose', toolUseId: 'c', incomplete: true, partialNodeCount: 2 },
      ]));
      expect(facet.compose_partial_nodes).toBe(2); // calls (meaning unchanged)
      expect(facet.compose_partial_node_count).toBe(5); // nodes
      expect(SessionFacetSchema.safeParse(facet).success).toBe(true);
    });

    it('a partial call without a recorded node count (pre-#2978) contributes 1', () => {
      const facet = deriveSessionFacet(sessionWithToolEvent([
        { toolName: 'compose', toolUseId: 'a', incomplete: true },
      ]));
      expect(facet.compose_partial_node_count).toBe(1);
    });

    it('compose_partial_node_count is absent when no compose call was partial', () => {
      const facet = deriveSessionFacet(sessionWithToolEvent([
        { toolName: 'compose', toolUseId: 'a', partialNodeCount: 4 }, // no incomplete flag
        { toolName: 'agent', toolUseId: 'b', incomplete: true, partialNodeCount: 2 },
      ]));
      expect(facet.compose_partial_node_count).toBeUndefined();
    });

    it('schema rejects negative compose_partial_nodes / compose_partial_node_count', () => {
      const facet = deriveSessionFacet(sessionWithToolEvent([]));
      expect(SessionFacetSchema.safeParse({ ...facet, compose_partial_nodes: -1 }).success).toBe(false);
      expect(SessionFacetSchema.safeParse({ ...facet, compose_partial_node_count: -1 }).success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // outcome_downgrade_reason (#2798) — downgrade self-reported Done
  // ---------------------------------------------------------------------------

  describe('outcome_downgrade_reason', () => {
    // Helper: a Done session with configurable tool events and Done block content.
    function doneSession({
      doneText = '**Done**\n- What was done: completed.',
      toolEvents = [] as Array<{ toolName: string; toolUseId: string; inputRaw?: string; result?: string; isError?: boolean; incomplete?: boolean }>,
    } = {}): StoredSessionInput {
      return {
        sessionId: 'downgrade-test',
        model: 'sonnet',
        startedAt: 0,
        savedAt: 60_000,
        totalTurns: 1,
        turns: [{ user: 'go', assistant: doneText, timestamp: 1, toolEvents }],
      };
    }

    // --- no downgrade cases ---

    it('no downgrade when Done has a world mutation (file write)', () => {
      // A file write corroborates the Done — no downgrade should fire.
      const facet = deriveSessionFacet(doneSession({
        toolEvents: [{ toolName: 'write_file', toolUseId: 'wf1', inputRaw: JSON.stringify({ file_path: '/a.ts', content: 'x' }) }],
      }));
      expect(facet.outcome).toBe('fully_achieved');
      expect(facet.outcome_downgrade_reason).toBeUndefined();
      expect(SessionFacetSchema.safeParse(facet).success).toBe(true);
    });

    it('no downgrade when Done has a file edit', () => {
      const facet = deriveSessionFacet(doneSession({
        toolEvents: [{ toolName: 'edit_file', toolUseId: 'ef1', inputRaw: JSON.stringify({ file_path: '/b.ts', old_string: 'x', new_string: 'y' }) }],
      }));
      expect(facet.outcome).toBe('fully_achieved');
      expect(facet.outcome_downgrade_reason).toBeUndefined();
    });

    it('no downgrade when Done has a git commit', () => {
      const facet = deriveSessionFacet(doneSession({
        toolEvents: [{ toolName: 'bash', toolUseId: 'b1', inputRaw: JSON.stringify({ command: 'git commit -m "feat: done"' }) }],
      }));
      expect(facet.outcome).toBe('fully_achieved');
      expect(facet.outcome_downgrade_reason).toBeUndefined();
    });

    it('no downgrade when Done has an evidence bullet (no mutations needed)', () => {
      // An evidence bullet in the Done block is corroborating — no downgrade.
      const doneWithEvidence = '**Done**\n- What was done: analysed data.\n- Evidence: see attached report.';
      const facet = deriveSessionFacet(doneSession({ doneText: doneWithEvidence }));
      expect(facet.outcome).toBe('fully_achieved');
      expect(facet.outcome_downgrade_reason).toBeUndefined();
    });

    it('no downgrade for non-Done outcomes (Blocked, Asking, Interrupted stay unchanged)', () => {
      for (const [heading, expected] of [
        ['**Blocked**\n- What blocks: API key missing.', 'not_achieved'],
        ['**Asking**\n- Question: which approach?', 'partially_achieved'],
        ['**Interrupted**', 'aborted'],
      ] as const) {
        const facet = deriveSessionFacet(doneSession({ doneText: heading }));
        expect(facet.outcome).toBe(expected);
        expect(facet.outcome_downgrade_reason).toBeUndefined();
      }
    });

    it('no downgrade when outcome is structural (empty assistant)', () => {
      const facet = deriveSessionFacet(doneSession({ doneText: '' }));
      expect(facet.outcome).toBe('partially_achieved');
      expect(facet.outcome_source).toBe('structural');
      expect(facet.outcome_downgrade_reason).toBeUndefined();
    });

    it('no downgrade when outcome is unknown (no terminal heading)', () => {
      const facet = deriveSessionFacet(doneSession({ doneText: 'Here is a summary with no heading.' }));
      expect(facet.outcome).toBe('unknown');
      expect(facet.outcome_downgrade_reason).toBeUndefined();
    });

    // --- signal 1: deferred_items ---

    it('downgrade: deferred_items — Done block has a non-empty Deferred bullet (#2798)', () => {
      // The "Deferred / pending" bullet signals the agent admitted leaving work.
      const doneWithDeferred = '**Done**\n- What was done: partial fix.\n- Deferred: the UI layer was skipped.';
      const facet = deriveSessionFacet(doneSession({
        doneText: doneWithDeferred,
        toolEvents: [{ toolName: 'write_file', toolUseId: 'wf1', inputRaw: JSON.stringify({ file_path: '/a.ts', content: 'x' }) }],
      }));
      expect(facet.outcome).toBe('partially_achieved');
      expect(facet.outcome_source).toBe('terminal_state'); // source unchanged — heading was found
      expect(facet.outcome_downgrade_reason).toBe('deferred_items');
      expect(SessionFacetSchema.safeParse(facet).success).toBe(true);
    });

    it('downgrade: deferred_items fires even when there ARE world mutations', () => {
      // World mutations do not suppress the deferred_items signal.
      const doneWithDeferred = '**Done**\n- What was done: saved config.\n- Pending: tests still failing.';
      const facet = deriveSessionFacet(doneSession({
        doneText: doneWithDeferred,
        toolEvents: [
          { toolName: 'edit_file', toolUseId: 'ef1', inputRaw: JSON.stringify({ file_path: '/cfg.ts' }) },
          { toolName: 'bash', toolUseId: 'b1', inputRaw: JSON.stringify({ command: 'git commit -m "cfg"' }) },
        ],
      }));
      expect(facet.outcome).toBe('partially_achieved');
      expect(facet.outcome_downgrade_reason).toBe('deferred_items');
    });

    it('downgrade: deferred_items wins over no_corroborating_evidence (priority order)', () => {
      // Both signals could fire; deferred_items is checked first.
      const doneWithDeferred = '**Done**\n- What was done: researched.\n- Follow-up: implement what was found.';
      const facet = deriveSessionFacet(doneSession({ doneText: doneWithDeferred })); // no tool events → no mutations
      expect(facet.outcome).toBe('partially_achieved');
      expect(facet.outcome_downgrade_reason).toBe('deferred_items');
    });

    // --- signal 2: no_corroborating_evidence ---

    it('downgrade: no_corroborating_evidence — Done with no mutations and no evidence bullet (#2798)', () => {
      // A pure-text Done with no file writes/edits/commits and no evidence bullet.
      const doneText = '**Done**\n- What was done: thought about the problem.';
      const facet = deriveSessionFacet(doneSession({ doneText })); // no tool events
      expect(facet.outcome).toBe('partially_achieved');
      expect(facet.outcome_downgrade_reason).toBe('no_corroborating_evidence');
      expect(facet.outcome_source).toBe('terminal_state');
      expect(SessionFacetSchema.safeParse(facet).success).toBe(true);
    });

    it('downgrade: no_corroborating_evidence fires when only read_file calls were made (no mutations)', () => {
      // read_file is not a mutation; outcome should still be downgraded.
      const facet = deriveSessionFacet(doneSession({
        doneText: '**Done**\n- What was done: reviewed the code.',
        toolEvents: [{ toolName: 'read_file', toolUseId: 'rf1', inputRaw: JSON.stringify({ file_path: '/a.ts' }) }],
      }));
      expect(facet.outcome).toBe('partially_achieved');
      expect(facet.outcome_downgrade_reason).toBe('no_corroborating_evidence');
    });

    it('downgrade: no_corroborating_evidence — bash calls that are NOT commits do not count as mutations', () => {
      // A bash ls / cat call without a `git commit` is not a mutation.
      const facet = deriveSessionFacet(doneSession({
        doneText: '**Done**\n- What was done: ran diagnostics.',
        toolEvents: [{ toolName: 'bash', toolUseId: 'b1', inputRaw: JSON.stringify({ command: 'ls -la' }) }],
      }));
      expect(facet.outcome).toBe('partially_achieved');
      expect(facet.outcome_downgrade_reason).toBe('no_corroborating_evidence');
    });

    // --- signal 3: compose_partial_nodes ---

    it('downgrade: compose_partial_nodes — Done after a partial compose call (#2798)', () => {
      // A compose call that wound down partial (soft-deadline) during a Done session.
      const facet = deriveSessionFacet(doneSession({
        doneText: '**Done**\n- What was done: parallel work completed.',
        toolEvents: [
          // File write provides corroboration so no_corroborating_evidence does NOT fire.
          { toolName: 'write_file', toolUseId: 'wf1', inputRaw: JSON.stringify({ file_path: '/a.ts', content: 'x' }) },
          // Partial compose call — at least one node wound down.
          { toolName: 'compose', toolUseId: 'cp1', incomplete: true },
        ],
      }));
      expect(facet.outcome).toBe('partially_achieved');
      expect(facet.outcome_downgrade_reason).toBe('compose_partial_nodes');
      expect(facet.compose_partial_nodes).toBe(1);
      expect(SessionFacetSchema.safeParse(facet).success).toBe(true);
    });

    it('downgrade: compose_partial_nodes does NOT fire when compose ran cleanly', () => {
      // A clean compose call (no incomplete flag) does not trigger the downgrade.
      const facet = deriveSessionFacet(doneSession({
        doneText: '**Done**\n- What was done: all nodes completed.',
        toolEvents: [
          { toolName: 'write_file', toolUseId: 'wf1', inputRaw: JSON.stringify({ file_path: '/a.ts', content: 'x' }) },
          { toolName: 'compose', toolUseId: 'cp1' }, // no incomplete flag
        ],
      }));
      expect(facet.outcome).toBe('fully_achieved');
      expect(facet.outcome_downgrade_reason).toBeUndefined();
    });

    it('downgrade: deferred_items takes priority over compose_partial_nodes', () => {
      // Both deferred_items and compose_partial_nodes fire; deferred_items wins.
      const doneWithDeferred = '**Done**\n- What was done: partial.\n- Deferred: the rest.';
      const facet = deriveSessionFacet(doneSession({
        doneText: doneWithDeferred,
        toolEvents: [
          { toolName: 'write_file', toolUseId: 'wf1', inputRaw: JSON.stringify({ file_path: '/a.ts', content: 'x' }) },
          { toolName: 'compose', toolUseId: 'cp1', incomplete: true },
        ],
      }));
      expect(facet.outcome).toBe('partially_achieved');
      expect(facet.outcome_downgrade_reason).toBe('deferred_items');
    });

    it('outcome_downgrade_reason is absent on the facet when no downgrade occurred', () => {
      // Verify the field is not present (not just undefined) when not needed.
      const facet = deriveSessionFacet(doneSession({
        toolEvents: [{ toolName: 'write_file', toolUseId: 'wf1', inputRaw: JSON.stringify({ file_path: '/a.ts', content: 'x' }) }],
      }));
      expect(facet.outcome).toBe('fully_achieved');
      expect(Object.prototype.hasOwnProperty.call(facet, 'outcome_downgrade_reason')).toBe(false);
    });

    it('outcome_downgrade_reason is schema-valid as an enum value', () => {
      // All seven downgrade reason values are valid schema members.
      const base = deriveSessionFacet(doneSession({
        toolEvents: [{ toolName: 'write_file', toolUseId: 'wf1', inputRaw: JSON.stringify({ file_path: '/a.ts', content: 'x' }) }],
      }));
      for (const reason of [
        'deferred_items',
        'no_corroborating_evidence',
        'compose_partial_nodes',
        'budget_exceeded_closure',
        'iteration_cap_closure',
        'truncated_closure',
        'subagent_budget_exhaustion',
      ] as const) {
        expect(SessionFacetSchema.safeParse({ ...base, outcome_downgrade_reason: reason }).success).toBe(true);
      }
      // Invalid value must be rejected.
      expect(SessionFacetSchema.safeParse({ ...base, outcome_downgrade_reason: 'some_other_reason' }).success).toBe(false);
    });

    it('primary_success is preserved from the Done block after downgrade', () => {
      // The agent's self-reported "What was done" is still useful even after downgrade.
      const doneWithDeferred = '**Done**\n- What was done: implemented the handler.\n- Deferred: tests skipped.';
      const facet = deriveSessionFacet(doneSession({
        doneText: doneWithDeferred,
        toolEvents: [{ toolName: 'write_file', toolUseId: 'wf1', inputRaw: JSON.stringify({ file_path: '/a.ts', content: 'x' }) }],
      }));
      expect(facet.outcome).toBe('partially_achieved');
      expect(facet.primary_success).toBe('implemented the handler.');
    });

    // --- trace-backed signals (signals 4–7, #2798 cont.) ---

    // Helper: a Done session with world mutations (to suppress no_corroborating_evidence)
    // and optional trace signals.
    function doneSessionWithTrace({
      traceSignals,
    }: {
      traceSignals?: import('./derive.js').DeriveOptions['traceSignals'];
    } = {}): ReturnType<typeof deriveSessionFacet> {
      const session = doneSession({
        toolEvents: [{ toolName: 'write_file', toolUseId: 'wf1', inputRaw: JSON.stringify({ file_path: '/a.ts', content: 'x' }) }],
      });
      return deriveSessionFacet(session, { traceSignals });
    }

    it('no downgrade when traceSignals is absent (no trace available)', () => {
      // Absence of trace data must never trigger a downgrade.
      const facet = doneSessionWithTrace({ traceSignals: undefined });
      expect(facet.outcome).toBe('fully_achieved');
      expect(facet.outcome_downgrade_reason).toBeUndefined();
    });

    it('no downgrade when traceSignals has no closure reason and no exhaustion', () => {
      // A trace with a clean closure provides no signal.
      const facet = doneSessionWithTrace({
        traceSignals: { traceClosureReason: undefined, hasSubagentBudgetExhaustion: false },
      });
      expect(facet.outcome).toBe('fully_achieved');
      expect(facet.outcome_downgrade_reason).toBeUndefined();
    });

    it('downgrade: budget_exceeded_closure — session ended because budget ceiling was hit (#2798)', () => {
      const facet = doneSessionWithTrace({
        traceSignals: { traceClosureReason: 'budget_exceeded', hasSubagentBudgetExhaustion: false },
      });
      expect(facet.outcome).toBe('partially_achieved');
      expect(facet.outcome_downgrade_reason).toBe('budget_exceeded_closure');
      expect(SessionFacetSchema.safeParse(facet).success).toBe(true);
    });

    it('downgrade: iteration_cap_closure — top-level tool-use round cap fired (#2798)', () => {
      const facet = doneSessionWithTrace({
        traceSignals: { traceClosureReason: 'iteration_cap', hasSubagentBudgetExhaustion: false },
      });
      expect(facet.outcome).toBe('partially_achieved');
      expect(facet.outcome_downgrade_reason).toBe('iteration_cap_closure');
      expect(SessionFacetSchema.safeParse(facet).success).toBe(true);
    });

    it('downgrade: truncated_closure — last model turn cut off by output-token ceiling (#2798)', () => {
      const facet = doneSessionWithTrace({
        traceSignals: { traceClosureReason: 'truncated', hasSubagentBudgetExhaustion: false },
      });
      expect(facet.outcome).toBe('partially_achieved');
      expect(facet.outcome_downgrade_reason).toBe('truncated_closure');
      expect(SessionFacetSchema.safeParse(facet).success).toBe(true);
    });

    it('downgrade: subagent_budget_exhaustion — a forked subagent hit its tool-round cap (#2798)', () => {
      const facet = doneSessionWithTrace({
        traceSignals: { traceClosureReason: undefined, hasSubagentBudgetExhaustion: true },
      });
      expect(facet.outcome).toBe('partially_achieved');
      expect(facet.outcome_downgrade_reason).toBe('subagent_budget_exhaustion');
      expect(SessionFacetSchema.safeParse(facet).success).toBe(true);
    });

    it('budget_exceeded_closure takes priority over subagent_budget_exhaustion', () => {
      // When both signals fire, the higher-priority one wins.
      const facet = doneSessionWithTrace({
        traceSignals: { traceClosureReason: 'budget_exceeded', hasSubagentBudgetExhaustion: true },
      });
      expect(facet.outcome).toBe('partially_achieved');
      expect(facet.outcome_downgrade_reason).toBe('budget_exceeded_closure');
    });

    it('deferred_items takes priority over all trace signals', () => {
      // Signal 1 (deferred_items) must beat trace signals.
      const session = doneSession({
        doneText: '**Done**\n- What was done: partial.\n- Deferred: still pending.',
        toolEvents: [{ toolName: 'write_file', toolUseId: 'wf1', inputRaw: JSON.stringify({ file_path: '/a.ts', content: 'x' }) }],
      });
      const facet = deriveSessionFacet(session, {
        traceSignals: { traceClosureReason: 'budget_exceeded', hasSubagentBudgetExhaustion: true },
      });
      expect(facet.outcome_downgrade_reason).toBe('deferred_items');
    });

    it('trace signals do not fire when outcome is not fully_achieved', () => {
      // Trace-backed signals only apply when the initial outcome is fully_achieved.
      const session = doneSession({ doneText: '**Blocked**\n- What blocks: missing key.' });
      const facet = deriveSessionFacet(session, {
        traceSignals: { traceClosureReason: 'budget_exceeded', hasSubagentBudgetExhaustion: true },
      });
      expect(facet.outcome).toBe('not_achieved');
      expect(facet.outcome_downgrade_reason).toBeUndefined();
    });
  });
});
