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
    expect(facet.facet_version).toBe(7); // v7: added outcome_source, tool_errors_total, pr_url
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

  // outcome derived from terminal-state heading
  function oneAssistant(assistant: string): StoredSessionInput {
    return {
      sessionId: 'ts-test',
      model: 'sonnet',
      startedAt: 0,
      savedAt: 60_000,
      totalTurns: 1,
      turns: [{ user: 'do something', assistant, timestamp: 1 }],
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
});
