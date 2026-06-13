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
    expect(facet.facet_version).toBe(1);
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

  it('counts a real git commit but excludes git commit-tree', () => {
    const facet = deriveSessionFacet({
      sessionId: 'commit-re',
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
            { toolName: 'bash', toolUseId: '1', inputRaw: JSON.stringify({ command: 'git commit -m "real"' }) },
            { toolName: 'bash', toolUseId: '2', inputRaw: JSON.stringify({ command: 'git commit-tree HEAD' }) },
          ],
        },
      ],
    });
    expect(facet.world_changes.commits).toBe(1);
  });

  it('detects a commit from the summarized input when inputRaw omits command', () => {
    // Post-fix sidecars do NOT persist the raw bash `command` (secret-at-rest),
    // so commit detection falls back to the summarized first-line `input`
    // (leading space, as summarizeToolInput emits it).
    const facet = deriveSessionFacet({
      sessionId: 'summarized-commit',
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
            { toolName: 'bash', toolUseId: '1', input: ' git commit -m "real"' },
            { toolName: 'bash', toolUseId: '2', input: ' git commit-tree HEAD' },
          ],
        },
      ],
    });
    expect(facet.world_changes.commits).toBe(1);
    expect(facet.world_changes.bash_commands).toBe(2);
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
});
