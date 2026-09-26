import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { saveSession } from './session-store.js';
import { resolveResumeTarget, resumeConfigFor, type ResolvedResumeTarget } from './resume-session.js';
import { createSessionStats, recordTurn } from './slash/session-stats.js';
import { buildAssistantContentBlocks, buildUserContentBlocks } from './commands/interactive/turn-handler.js';
import type { StoredSession } from './session-store.js';

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(() => {
  originalHome = process.env['HOME'];
  originalUserProfile = process.env['USERPROFILE'];
  tmpHome = join(tmpdir(), `afk-resume-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env['HOME'] = tmpHome;
  process.env['USERPROFILE'] = tmpHome;
  // Windows: bypass homedir() to avoid 8.3 short-path vs long-path mismatch.
  process.env['AFK_HOME'] = join(tmpHome, '.afk'); // audit-env-access: allow — test isolation
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  if (originalHome !== undefined) process.env['HOME'] = originalHome;
  if (originalUserProfile !== undefined) process.env['USERPROFILE'] = originalUserProfile;
  else delete process.env['USERPROFILE'];
});

describe('resume-session', () => {
  it('--resume resolves saved sessions into native id plus transcript history', () => {
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'hello', 'hi', { sessionId: 'sdk-resume' });
    saveSession(stats, 'friendly');

    const target = resolveResumeTarget({ resume: 'friendly' });
    expect(target?.resumeId).toBe('sdk-resume');
    expect(target?.stored?.model).toBe('sonnet');

    expect(resumeConfigFor(target)).toEqual({
      resume: 'sdk-resume',
      sessionId: 'sdk-resume',
      resumeHistory: [{ user: 'hello', assistant: 'hi', inputTokens: 0 }],
    });
  });

  it('--continue resolves the newest saved session', async () => {
    const older = createSessionStats('sonnet');
    recordTurn(older, 'old', 'old reply', { sessionId: 'sdk-old' });
    saveSession(older, 'old');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = createSessionStats('opus');
    recordTurn(newer, 'new', 'new reply', { sessionId: 'sdk-new' });
    saveSession(newer, 'new');

    const target = resolveResumeTarget({ continue: true });
    expect(target?.id).toBe('new');
    expect(target?.resumeId).toBe('sdk-new');
  });

  it('passes unknown --resume values through as native provider ids', () => {
    const target = resolveResumeTarget({ resume: 'raw-provider-session' });
    expect(resumeConfigFor(target)).toEqual({
      resume: 'raw-provider-session',
      sessionId: 'raw-provider-session',
    });
  });

  it('appends tool summaries to assistant text when toolEvents are present', () => {
    const stats = createSessionStats('sonnet');
    recordTurn(
      stats,
      'run a command',
      'done',
      { sessionId: 'sdk-tools' },
      [{ toolName: 'bash', toolUseId: 'tu_1', input: 'echo hi', isError: false }],
    );
    saveSession(stats, 'tools-session');

    const target = resolveResumeTarget({ resume: 'tools-session' });
    const config = resumeConfigFor(target);
    expect(config.resumeHistory?.[0]?.assistant).toBe('done\n[Tools used: bash(echo hi)✓]');
  });

  it('leaves assistant text unchanged when turn has no toolEvents', () => {
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'hello', 'hi there', { sessionId: 'sdk-notools' });
    saveSession(stats, 'notools-session');

    const target = resolveResumeTarget({ resume: 'notools-session' });
    const config = resumeConfigFor(target);
    expect(config.resumeHistory?.[0]?.assistant).toBe('hi there');
  });

  it('leaves assistant text unchanged when toolEvents is an empty array', () => {
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'hello', 'hi there', { sessionId: 'sdk-emptytools' }, []);
    saveSession(stats, 'emptytools-session');

    const target = resolveResumeTarget({ resume: 'emptytools-session' });
    const config = resumeConfigFor(target);
    expect(config.resumeHistory?.[0]?.assistant).toBe('hi there');
  });

  it('propagates userContentBlocks and assistantContentBlocks when present', () => {
    const stats = createSessionStats('sonnet');
    const record = recordTurn(stats, 'hello', 'hi', { sessionId: 'sdk-blocks-resume' });
    const userBlocks = [{ type: 'text' as const, text: 'hello' }];
    const assistantBlocks = [{ type: 'text' as const, text: 'hi' }];
    record.userContentBlocks = userBlocks;
    record.assistantContentBlocks = assistantBlocks;
    saveSession(stats, 'blocks-session');

    const target = resolveResumeTarget({ resume: 'blocks-session' });
    const config = resumeConfigFor(target);
    expect(config.resumeHistory?.[0]?.userContentBlocks).toEqual(userBlocks);
    expect(config.resumeHistory?.[0]?.assistantContentBlocks).toEqual(assistantBlocks);
  });

  it('always appends tool summary to text field even when assistantContentBlocks is present (#2005)', () => {
    // Regression test for issue #2005: when assistantContentBlocks is present on a turn,
    // the text field must still carry the tool-event summary so the text fallback path
    // (used when pairing validation fails on the structured path) has full tool context.
    const stats = createSessionStats('sonnet');
    const record = recordTurn(
      stats,
      'run a command',
      'done',
      { sessionId: 'sdk-blocks-tools' },
      [{ toolName: 'bash', toolUseId: 'tu_1', input: 'echo hi', isError: false }],
    );
    // Simulate a v5.226+ sidecar that also has structured content blocks.
    const assistantBlocks = [
      { type: 'text' as const, text: 'done' },
      { type: 'tool_use' as const, id: 'tu_1', name: 'bash', input: { command: 'echo hi' } },
    ];
    record.assistantContentBlocks = assistantBlocks;
    saveSession(stats, 'blocks-tools-session');

    const target = resolveResumeTarget({ resume: 'blocks-tools-session' });
    const config = resumeConfigFor(target);
    // The structured blocks are propagated for the normal path.
    expect(config.resumeHistory?.[0]?.assistantContentBlocks).toEqual(assistantBlocks);
    // The text field must still include the tool summary so the text fallback path
    // (triggered when hasValidToolUsePairing returns false on the structured path)
    // retains tool context. The text field is simply ignored when the structured
    // path succeeds, so this redundancy is harmless.
    expect(config.resumeHistory?.[0]?.assistant).toBe('done\n[Tools used: bash(echo hi)✓]');
  });

  it('produces identical output for old TurnRecords without content blocks', () => {
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'hello', 'hi', { sessionId: 'sdk-noblocks-resume' });
    saveSession(stats, 'noblocks-session');

    const target = resolveResumeTarget({ resume: 'noblocks-session' });
    const config = resumeConfigFor(target);
    expect(config.resumeHistory?.[0]?.userContentBlocks).toBeUndefined();
    expect(config.resumeHistory?.[0]?.assistantContentBlocks).toBeUndefined();
    // Text fields are unaffected
    expect(config.resumeHistory?.[0]?.user).toBe('hello');
    expect(config.resumeHistory?.[0]?.assistant).toBe('hi');
  });

  it('null-guards turn.assistant — corrupted sidecar with null assistant yields empty string prefix', () => {
    // Simulate a corrupted sidecar where assistant is null at runtime
    const corruptedStored = {
      sessionId: 'sdk-corrupt',
      model: 'sonnet',
      turns: [
        {
          user: 'hello',
          assistant: null as unknown as string, // corrupted field
          timestamp: Date.now(),
          toolEvents: [{ toolName: 'bash', toolUseId: 'tu_1', input: 'ls', isError: false }],
        },
      ],
    } satisfies Partial<StoredSession> as StoredSession;

    const target: ResolvedResumeTarget = {
      id: 'corrupt',
      resumeId: 'sdk-corrupt',
      stored: corruptedStored,
    };
    const config = resumeConfigFor(target);
    // Should produce '\n[Tools used: ...]' rather than 'null\n[Tools used: ...]'
    expect(config.resumeHistory?.[0]?.assistant).toBe('\n[Tools used: bash(ls)✓]');
    expect(config.resumeHistory?.[0]?.assistant).not.toContain('null');
  });
});

// ---------------------------------------------------------------------------
// buildAssistantContentBlocks / buildUserContentBlocks helpers
// ---------------------------------------------------------------------------

describe('buildAssistantContentBlocks', () => {
  it('returns undefined for text-only turns (no tool_use)', () => {
    expect(buildAssistantContentBlocks('Hello, world!', [])).toBeUndefined();
  });

  it('returns undefined when no tool events have results', () => {
    // pending tool (result === undefined) should not trigger block emission
    const pending = [{ toolName: 'bash', toolUseId: 'tu_1', input: 'ls' }];
    expect(buildAssistantContentBlocks('', pending)).toBeUndefined();
  });

  it('builds text + tool_use blocks for a tool-use turn', () => {
    const toolEvents = [
      { toolName: 'bash', toolUseId: 'tu_1', input: '', inputRaw: '{"command":"ls"}', result: 'file.ts', isError: false },
    ];
    const blocks = buildAssistantContentBlocks('running…', toolEvents);
    expect(blocks).toBeDefined();
    expect(blocks).toHaveLength(2);
    expect(blocks![0]).toEqual({ type: 'text', text: 'running…' });
    expect(blocks![1]).toEqual({ type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } });
  });

  it('omits the text block when responseText is blank', () => {
    const toolEvents = [
      { toolName: 'read_file', toolUseId: 'tu_2', input: '', inputRaw: '{"file_path":"/tmp/x.ts"}', result: 'content', isError: false },
    ];
    const blocks = buildAssistantContentBlocks('', toolEvents);
    expect(blocks).toBeDefined();
    expect(blocks).toHaveLength(1);
    expect(blocks![0]!.type).toBe('tool_use');
  });

  it('falls back to parsing input when inputRaw is absent', () => {
    const toolEvents = [
      { toolName: 'bash', toolUseId: 'tu_3', input: '{"command":"pwd"}', result: '/tmp', isError: false },
    ];
    const blocks = buildAssistantContentBlocks('', toolEvents);
    expect(blocks![0]).toEqual({ type: 'tool_use', id: 'tu_3', name: 'bash', input: { command: 'pwd' } });
  });

  it('uses empty object for input when JSON parse fails', () => {
    const toolEvents = [
      { toolName: 'bash', toolUseId: 'tu_4', input: 'not-json', result: 'ok', isError: false },
    ];
    const blocks = buildAssistantContentBlocks('', toolEvents);
    expect(blocks![0]).toEqual({ type: 'tool_use', id: 'tu_4', name: 'bash', input: {} });
  });

  it('emits multiple tool_use blocks for multi-tool turns', () => {
    const toolEvents = [
      { toolName: 'bash', toolUseId: 'tu_1', input: '', inputRaw: '{"command":"ls"}', result: 'ok', isError: false },
      { toolName: 'read_file', toolUseId: 'tu_2', input: '', inputRaw: '{"file_path":"/x"}', result: 'data', isError: false },
    ];
    const blocks = buildAssistantContentBlocks('checking…', toolEvents);
    expect(blocks).toHaveLength(3); // text + 2 × tool_use
    expect(blocks![1]!.type).toBe('tool_use');
    expect(blocks![2]!.type).toBe('tool_use');
  });
});

describe('buildUserContentBlocks', () => {
  it('returns undefined when there are no tool results', () => {
    expect(buildUserContentBlocks('hello', [])).toBeUndefined();
  });

  it('returns undefined when no tool events have results', () => {
    const pending = [{ toolName: 'bash', toolUseId: 'tu_1', input: 'ls' }]; // no result
    expect(buildUserContentBlocks('hello', pending)).toBeUndefined();
  });

  it('builds tool_result blocks FIRST, then text (Messages API ordering contract)', () => {
    const toolEvents = [
      { toolName: 'bash', toolUseId: 'tu_1', input: 'ls', result: 'file.ts', isError: false },
      { toolName: 'grep', toolUseId: 'tu_2', input: 'x', result: 'hit', isError: false },
    ];
    const blocks = buildUserContentBlocks('run it', toolEvents);
    expect(blocks).toBeDefined();
    expect(blocks).toHaveLength(3);
    // Text before a tool_result is rejected with HTTP 400 ("tool_use ids were
    // found without tool_result blocks immediately after"), breaking resume.
    expect(blocks![0]).toEqual({ type: 'tool_result', tool_use_id: 'tu_1', content: 'file.ts' });
    expect(blocks![1]).toEqual({ type: 'tool_result', tool_use_id: 'tu_2', content: 'hit' });
    expect(blocks![2]).toEqual({ type: 'text', text: 'run it' });
  });

  it('marks error tool results with is_error', () => {
    const toolEvents = [
      { toolName: 'bash', toolUseId: 'tu_err', input: 'bad', result: 'fail', isError: true },
    ];
    const blocks = buildUserContentBlocks('', toolEvents);
    expect(blocks).toBeDefined();
    const resultBlock = blocks!.find((b) => b.type === 'tool_result') as { is_error?: boolean } | undefined;
    expect(resultBlock?.is_error).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: recordTurn with blocks → saveSession → resumeConfigFor
// ---------------------------------------------------------------------------

describe('structured content blocks round-trip', () => {
  it('blocks written via recordTurn survive save+resume as resumeHistory entries', () => {
    const stats = createSessionStats('sonnet');
    const toolEvents = [
      { toolName: 'bash', toolUseId: 'tu_rt1', input: '', inputRaw: '{"command":"echo hi"}', result: 'hi', isError: false },
    ];
    const assistantBlocks = buildAssistantContentBlocks('done', toolEvents)!;
    const userBlocks = [{ type: 'text' as const, text: 'run command' }];

    const rec = recordTurn(
      stats,
      'run command',
      'done',
      { sessionId: 'sdk-roundtrip' },
      toolEvents,
      userBlocks,
      assistantBlocks,
    );

    // Verify the TurnRecord itself has blocks.
    expect(rec.userContentBlocks).toEqual(userBlocks);
    expect(rec.assistantContentBlocks).toBeDefined();
    expect(rec.assistantContentBlocks!.some((b) => b.type === 'tool_use')).toBe(true);

    // Save and reload via resumeConfigFor.
    saveSession(stats, 'roundtrip-session');
    const target = resolveResumeTarget({ resume: 'roundtrip-session' });
    const config = resumeConfigFor(target);

    const turn = config.resumeHistory?.[0];
    expect(turn).toBeDefined();
    expect(turn?.userContentBlocks).toEqual(userBlocks);
    expect(turn?.assistantContentBlocks).toBeDefined();
    expect(turn?.assistantContentBlocks?.some((b) => b.type === 'tool_use')).toBe(true);
    // Text fallback paths still intact.
    expect(turn?.user).toBe('run command');
    expect(turn?.assistant).toMatch(/done/);
  });

  it('backward compat: old TurnRecords without blocks still work via text fallback', () => {
    // Old sidecar: no userContentBlocks, no assistantContentBlocks.
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'old query', 'old reply', { sessionId: 'sdk-compat' });
    saveSession(stats, 'compat-session');

    const target = resolveResumeTarget({ resume: 'compat-session' });
    const config = resumeConfigFor(target);
    const turn = config.resumeHistory?.[0];

    expect(turn?.userContentBlocks).toBeUndefined();
    expect(turn?.assistantContentBlocks).toBeUndefined();
    expect(turn?.user).toBe('old query');
    expect(turn?.assistant).toBe('old reply');
  });

  it('structured path used in resumeHistoryToMessages when blocks present', async () => {
    // Test that resumeHistoryToMessages uses the structured path.
    const { resumeHistoryToMessages } = await import('../agent/providers/anthropic-direct/resolve-params.js');
    const history = [
      {
        user: 'run command',
        assistant: 'done',
        userContentBlocks: [{ type: 'text' as const, text: 'run command' }],
        assistantContentBlocks: [
          { type: 'text' as const, text: 'done' },
          { type: 'tool_use' as const, id: 'tu_1', name: 'bash', input: { command: 'ls' } },
        ],
      },
    ];
    const messages = resumeHistoryToMessages(history);
    expect(messages).toBeDefined();
    expect(messages).toHaveLength(2);
    // User message uses structured blocks.
    expect(Array.isArray(messages![0]!.content)).toBe(true);
    // Assistant message uses structured blocks with tool_use.
    expect(Array.isArray(messages![1]!.content)).toBe(true);
    const assistantContent = messages![1]!.content as Array<{ type: string }>;
    expect(assistantContent.some((b) => b.type === 'tool_use')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Two-turn round-trip: buildUserContentBlocks produces tool_result blocks,
  // and repairOrphanToolUses does NOT fire on a well-formed history.
  //
  // Data-model invariant (why tool_results belong on the NEXT turn):
  //   resumeHistoryToMessages maps each TurnRecord to TWO API messages:
  //     messages[2N]   = Turn[N].userContentBlocks  (user initial prompt)
  //     messages[2N+1] = Turn[N].assistantContentBlocks (assistant incl. tool_use)
  //
  //   Therefore the tool_result blocks for Turn[N]'s tool_use blocks
  //   must live in Turn[N+1].userContentBlocks so the ordering is:
  //     messages[2N]   user (text)
  //     messages[2N+1] assistant (tool_use)   ← tool_use issued HERE
  //     messages[2N+2] user (tool_result)     ← paired tool_result HERE
  //     messages[2N+3] assistant (text)
  //   satisfying the Anthropic API contract.
  //
  // Regression guard: before the fix, the call site used a text-only fallback
  // instead of buildUserContentBlocks. Turn[N].assistantContentBlocks carried
  // tool_use blocks with no tool_result in Turn[N+1].userContentBlocks, so
  // repairOrphanToolUses fired on resume and replaced all tool output with
  // synthetic error placeholders.
  // ---------------------------------------------------------------------------
  it('two-turn tool-use round-trip: tool_result appears in SECOND turn user blocks and repairOrphanToolUses does not fire', async () => {
    const { resumeHistoryToMessages } = await import('../agent/providers/anthropic-direct/resolve-params.js');
    const { repairOrphanToolUses } = await import('../agent/providers/anthropic-direct/query/repair-orphan-tool-uses.js');

    // --- Turn 0: tool-use turn ---
    // The assistant calls bash and gets a result. userContentBlocks = user initial
    // text only (no tool_results yet — those go in turn 1's user blocks).
    const turn0ToolEvents = [
      {
        toolName: 'bash',
        toolUseId: 'tu_two_turn_1',
        input: '',
        inputRaw: '{"command":"echo hello"}',
        result: 'hello',
        isError: false,
      },
    ];
    const turn0AssistantBlocks = buildAssistantContentBlocks('I will run that command.', turn0ToolEvents)!;
    expect(turn0AssistantBlocks.some((b) => b.type === 'tool_use')).toBe(true);

    // Turn 0's userContentBlocks: NO previous tool events, so buildUserContentBlocks
    // returns undefined → falls back to plain text field.
    const turn0UserBlocks = buildUserContentBlocks('run it', []); // no prev tool events
    expect(turn0UserBlocks).toBeUndefined();

    const stats = createSessionStats('sonnet');
    const t0 = recordTurn(
      stats,
      'run it',
      'I will run that command.',
      { sessionId: 'sdk-two-turn' },
      turn0ToolEvents,
      turn0UserBlocks,        // undefined → plain text stored
      turn0AssistantBlocks,
    );
    expect(t0.userContentBlocks).toBeUndefined();
    expect(t0.assistantContentBlocks?.some((b) => b.type === 'tool_use')).toBe(true);

    // --- Turn 1: follow-up turn ---
    // The fixed call site reads stats.turns.at(-1).toolEvents (= turn 0's events)
    // and passes them to buildUserContentBlocks. Replicate that logic here.
    const prevToolEvents = stats.turns.at(-1)?.toolEvents ?? [];
    const turn1UserBlocks = buildUserContentBlocks('thanks', prevToolEvents);
    expect(turn1UserBlocks).toBeDefined();

    // Verify the tool_result block pairs with turn 0's tool_use.
    const resultBlock = turn1UserBlocks!.find((b) => b.type === 'tool_result') as
      | { type: 'tool_result'; tool_use_id: string; content: string }
      | undefined;
    expect(resultBlock).toBeDefined();
    expect(resultBlock!.tool_use_id).toBe('tu_two_turn_1');
    expect(resultBlock!.content).toBe('hello');

    const t1 = recordTurn(
      stats,
      'thanks',
      'You are welcome.',
      { sessionId: 'sdk-two-turn' },
      [],             // no tool events in this turn
      turn1UserBlocks,
      undefined,
    );
    expect(t1.userContentBlocks?.some((b) => b.type === 'tool_result')).toBe(true);

    saveSession(stats, 'two-turn-session');

    // --- Reload and verify persistence ---
    const target = resolveResumeTarget({ resume: 'two-turn-session' });
    const config = resumeConfigFor(target);
    expect(config.resumeHistory).toHaveLength(2);

    const rt0 = config.resumeHistory![0]!;
    // Turn 0: assistant has tool_use; user falls back to plain text (no userContentBlocks).
    expect(rt0.assistantContentBlocks?.some((b) => b.type === 'tool_use')).toBe(true);
    expect(rt0.userContentBlocks).toBeUndefined();

    const rt1 = config.resumeHistory![1]!;
    // Turn 1: user has the tool_result that pairs with turn 0's tool_use.
    expect(rt1.userContentBlocks).toBeDefined();
    const pr = rt1.userContentBlocks!.find((b) => b.type === 'tool_result') as
      | { type: 'tool_result'; tool_use_id: string }
      | undefined;
    expect(pr).toBeDefined();
    expect(pr!.tool_use_id).toBe('tu_two_turn_1');

    // --- Rebuild messages via resumeHistoryToMessages ---
    const messages = resumeHistoryToMessages(config.resumeHistory);
    expect(messages).toBeDefined();
    // Turn 0 → 2 msgs (user text fallback + assistant with tool_use)
    // Turn 1 → 2 msgs (user with tool_result + assistant text)
    expect(messages!.length).toBe(4);

    // messages[0] = turn 0 user (plain text)
    expect(messages![0]!.role).toBe('user');

    // messages[1] = turn 0 assistant (has tool_use)
    const aContent = messages![1]!.content as Array<{ type: string }>;
    expect(aContent.some((b) => b.type === 'tool_use')).toBe(true);

    // messages[2] = turn 1 user (has tool_result — immediately follows messages[1])
    const uContent = messages![2]!.content;
    expect(Array.isArray(uContent)).toBe(true);
    const toolResultInUser = (uContent as Array<{ type: string; tool_use_id?: string }>).find(
      (b) => b.type === 'tool_result',
    );
    expect(toolResultInUser).toBeDefined();
    expect(toolResultInUser!.tool_use_id).toBe('tu_two_turn_1');

    // messages[3] = turn 1 assistant (plain text)
    expect(messages![3]!.role).toBe('assistant');

    // repairOrphanToolUses must NOT add any synthetic messages — every tool_use
    // in messages[1] is covered by a tool_result in messages[2].
    const countBefore = messages!.length;
    repairOrphanToolUses(messages!);
    expect(messages!.length).toBe(countBefore);

    // Double-check: no is_error synthetic placeholders injected.
    const syntheticErrors = messages!.filter(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string; is_error?: boolean }>).some(
          (b) => b.type === 'tool_result' && b.is_error === true,
        ),
    );
    expect(syntheticErrors).toHaveLength(0);
  });
});
