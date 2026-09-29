import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { saveSession } from './session-store.js';
import { resolveResumeTarget, resumeConfigFor, type ResolvedResumeTarget } from './resume-session.js';
import { createSessionStats, recordTurn } from './slash/session-stats.js';
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
// Sidecar content blocks: new turns write none; old sidecars still replay.
//
// New turns no longer persist userContentBlocks / assistantContentBlocks —
// their tool_result content was the ~80-char display preview, so resume fed
// the model truncated tool output. The message journal is the resume source.
// Old sidecars (no journal) still carry blocks, and that replay path stays.
// ---------------------------------------------------------------------------

describe('sidecar content blocks', () => {
  it('new tool-use turns persist text + metadata only (no preview-backed blocks)', () => {
    const stats = createSessionStats('sonnet');
    const toolEvents = [
      { toolName: 'bash', toolUseId: 'tu_new', input: '', inputRaw: '{"command":"ls"}', result: 'a.txt b.txt…', isError: false },
    ];
    recordTurn(stats, 'run it', 'done', { sessionId: 'sdk-new' }, toolEvents);
    recordTurn(stats, 'thanks', 'welcome', { sessionId: 'sdk-new' }, []);
    saveSession(stats, 'new-session');

    const config = resumeConfigFor(resolveResumeTarget({ resume: 'new-session' }));
    expect(config.resumeHistory).toHaveLength(2);
    for (const turn of config.resumeHistory ?? []) {
      expect(turn.userContentBlocks).toBeUndefined();
      expect(turn.assistantContentBlocks).toBeUndefined();
    }
    expect(config.resumeHistory?.[0]?.user).toBe('run it');
    expect(config.resumeHistory?.[0]?.assistant).toMatch(/done/);
  });

  it('backward compat: old TurnRecords without blocks still work via text fallback', () => {
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'old query', 'old reply', { sessionId: 'sdk-compat' });
    saveSession(stats, 'compat-session');

    const config = resumeConfigFor(resolveResumeTarget({ resume: 'compat-session' }));
    const turn = config.resumeHistory?.[0];
    expect(turn?.userContentBlocks).toBeUndefined();
    expect(turn?.assistantContentBlocks).toBeUndefined();
    expect(turn?.user).toBe('old query');
    expect(turn?.assistant).toBe('old reply');
  });

  it('old sidecars carrying content blocks still surface them in resumeHistory', () => {
    const stats = createSessionStats('sonnet');
    const t0 = recordTurn(stats, 'run it', 'I will run that.', { sessionId: 'sdk-old-blocks' }, [
      { toolName: 'bash', toolUseId: 'tu_old', input: '', inputRaw: '{"command":"echo hi"}', result: 'hi' },
    ]);
    // Simulate a sidecar written by a pre-journal build.
    t0.assistantContentBlocks = [
      { type: 'text', text: 'I will run that.' },
      { type: 'tool_use', id: 'tu_old', name: 'bash', input: { command: 'echo hi' } },
    ];
    const t1 = recordTurn(stats, 'thanks', 'welcome', { sessionId: 'sdk-old-blocks' }, []);
    t1.userContentBlocks = [
      { type: 'tool_result', tool_use_id: 'tu_old', content: 'hi' },
      { type: 'text', text: 'thanks' },
    ];
    saveSession(stats, 'old-blocks-session');

    const config = resumeConfigFor(resolveResumeTarget({ resume: 'old-blocks-session' }));
    expect(config.resumeHistory?.[0]?.assistantContentBlocks?.some((b) => b.type === 'tool_use')).toBe(true);
    expect(config.resumeHistory?.[1]?.userContentBlocks?.[0]?.type).toBe('tool_result');
  });

  it('old-sidecar two-turn replay pairs tool_use/tool_result without orphan repair', async () => {
    const { resumeHistoryToMessages } = await import('../agent/providers/anthropic-direct/resolve-params.js');
    const { repairOrphanToolUses } = await import('../agent/providers/anthropic-direct/query/repair-orphan-tool-uses.js');
    const history = [
      {
        user: 'run it',
        assistant: 'I will run that.',
        assistantContentBlocks: [
          { type: 'text' as const, text: 'I will run that.' },
          { type: 'tool_use' as const, id: 'tu_two', name: 'bash', input: { command: 'echo hello' } },
        ],
      },
      {
        user: 'thanks',
        assistant: 'You are welcome.',
        userContentBlocks: [
          { type: 'tool_result' as const, tool_use_id: 'tu_two', content: 'hello' },
          { type: 'text' as const, text: 'thanks' },
        ],
      },
    ];
    const messages = resumeHistoryToMessages(history);
    expect(messages).toHaveLength(4);
    const aContent = messages![1]!.content as Array<{ type: string }>;
    expect(aContent.some((b) => b.type === 'tool_use')).toBe(true);
    const uContent = messages![2]!.content as Array<{ type: string; tool_use_id?: string }>;
    expect(uContent.find((b) => b.type === 'tool_result')?.tool_use_id).toBe('tu_two');
    const countBefore = messages!.length;
    repairOrphanToolUses(messages!);
    expect(messages!.length).toBe(countBefore);
  });
});
