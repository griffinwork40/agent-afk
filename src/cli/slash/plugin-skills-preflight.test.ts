/**
 * Plugin-skill forward path preflight integration tests.
 *
 * Mirrors the T02 block in `builtin-skills.test.ts` but for `makeForwardHandler`
 * (plugin path) instead of `makeImmediateHandler` (built-in path). Both
 * handlers must call `runPreflight` symmetrically and thread the resulting
 * `manifestBlock` into `buildSkillInvocationMessage` so the model sees the
 * same 3-block payload whether the skill came from `src/skills/` or a plugin.
 *
 * Coverage:
 *  - manifest path: 3-block payload [manifest, breadcrumb, instruction]
 *  - null path: standard 2-block payload
 *  - failure isolation: preflight returns null after catching → 2-block
 *  - lookup-key contract: bare skill name (no `<plugin>:` prefix) is used
 *  - source-discrimination contract: SkillInvocation.source === 'plugin'
 *
 * The first two contracts mirror builtin-skills.test.ts T02. The last two are
 * unique to the plugin path because `makeForwardHandler` receives skills whose
 * names may be namespaced (e.g. `example-plugin:review`), and the runtime must
 * strip the prefix before the registry lookup — the same shape that
 * `repl-loop.ts:399` produces for the (now legacy) forward-text path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { SlashContext, SessionStats } from './types.js';
import type { OutputEvent } from '../../agent/types.js';

// Mock the preflight barrel so we can control runPreflight without touching
// the filesystem or the real registry. Pattern matches builtin-skills.test.ts.
vi.mock('./preflight/index.js', () => ({
  runPreflight: vi.fn().mockResolvedValue(null),
  getSkillPreflightDir: vi.fn().mockReturnValue('/tmp/test-artifacts'),
  registerPreflight: vi.fn(),
  getPreflight: vi.fn(),
  stitchForwardManifest: (m: string | undefined, s: string) =>
    m && m.trim() ? `<system-reminder>\n${m}\n</system-reminder>\n\n${s}` : s,
}));

import { makeForwardHandler } from './plugin-skills.js';
import { runPreflight } from './preflight/index.js';

interface DiscoveredSkill {
  name: string;
  description: string;
  argumentHint?: string;
}

function makeStats(): SessionStats {
  return {
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    permissionMode: 'default',
  };
}

function fakeContent(text: string): OutputEvent {
  return {
    type: 'chunk',
    chunk: { type: 'content', content: text },
  };
}

interface FakeSession {
  sendMessage: ReturnType<typeof vi.fn>;
  sendMessageStream: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  waitForInitialization: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
}

function fakeSession(streamEvents: OutputEvent[] = []): FakeSession {
  async function* gen(): AsyncIterable<OutputEvent> {
    for (const e of streamEvents) yield e;
  }
  return {
    sendMessage: vi.fn().mockResolvedValue({ content: 'ok' }),
    sendMessageStream: vi.fn().mockImplementation(() => gen()),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    waitForInitialization: vi.fn().mockResolvedValue({ tools: ['Read'], mcpServers: [] }),
    interrupt: vi.fn().mockResolvedValue(undefined),
  };
}

function makeCtx(session: FakeSession): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const ctx: SlashContext = {
    session: { current: session } as unknown as SlashContext['session'],
    stats: makeStats(),
    out: {
      line: (t = '') => lines.push(t),
      raw: (t) => lines.push(t),
      success: (t) => lines.push(`SUCCESS:${t}`),
      info: (t) => lines.push(`INFO:${t}`),
      warn: (t) => lines.push(`WARN:${t}`),
      error: (t) => lines.push(`ERROR:${t}`),
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  };
  return { ctx, lines };
}

beforeEach(() => {
  vi.mocked(runPreflight).mockReset();
  vi.mocked(runPreflight).mockResolvedValue(null);
});

describe('makeForwardHandler — preflight integration (symmetric with makeImmediateHandler)', () => {
  it('when runPreflight returns a manifest, sendMessageStream receives a 3-element array', async () => {
    const manifest = '<preflight-context skill="review" pr="277">Diff: /tmp/pr-277.diff</preflight-context>';
    vi.mocked(runPreflight).mockResolvedValueOnce({
      manifestBlock: manifest,
      artifacts: { diff: '/tmp/pr-277.diff' },
    });

    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);

    const skill: DiscoveredSkill = { name: 'review', description: 'Review a PR.' };
    const cmd = makeForwardHandler(skill);
    await cmd.handler!(ctx, '277');

    expect(session.sendMessageStream).toHaveBeenCalledTimes(1);
    const msg = session.sendMessageStream.mock.calls[0]?.[0] as ContentBlockParam[];
    expect(Array.isArray(msg)).toBe(true);
    // 3-element: [manifest, breadcrumb, instruction] — same shape as builtin path.
    expect(msg).toHaveLength(3);
    expect(msg[0]).toEqual({ type: 'text', text: manifest });
    expect(msg[1]?.type).toBe('text');
    expect((msg[1] as { type: 'text'; text: string }).text).toContain('review');
    expect(msg[2]?.type).toBe('text');
    expect((msg[2] as { type: 'text'; text: string }).text).toContain('skill');
  });

  it('when runPreflight returns null, sendMessageStream receives the standard 2-element array', async () => {
    vi.mocked(runPreflight).mockResolvedValueOnce(null);

    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);

    const skill: DiscoveredSkill = { name: 'mint', description: 'Mint a feature.' };
    const cmd = makeForwardHandler(skill);
    await cmd.handler!(ctx, 'idea');

    const msg = session.sendMessageStream.mock.calls[0]?.[0] as ContentBlockParam[];
    expect(msg).toHaveLength(2);
  });

  it('when runPreflight reports failure via onError + returns null, handler still sends 2-element message', async () => {
    // Failure isolation: real runPreflight wraps in try/catch and surfaces
    // errors via onError, then returns null. The handler must not propagate.
    vi.mocked(runPreflight).mockImplementationOnce(async (_inv, _ctx, onError) => {
      if (onError) onError(new Error('preflight network timeout'));
      return null;
    });

    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);

    const skill: DiscoveredSkill = { name: 'diagnose', description: 'Diagnose bugs.' };
    const cmd = makeForwardHandler(skill);
    await cmd.handler!(ctx, 'a failing test');

    expect(session.sendMessageStream).toHaveBeenCalledTimes(1);
    const msg = session.sendMessageStream.mock.calls[0]?.[0] as ContentBlockParam[];
    expect(msg).toHaveLength(2);
  });
});

describe('makeForwardHandler — runPreflight invocation contract', () => {
  it('runPreflight is called with bare skill name (no `<plugin>:` prefix)', async () => {
    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);

    const skill: DiscoveredSkill = {
      // Plugin-namespaced name — what session.supportedCommands() returns for
      // a colliding plugin entry (see plugin-skills.ts:534).
      name: 'example-plugin:review',
      description: 'Review a PR.',
    };
    const cmd = makeForwardHandler(skill);
    await cmd.handler!(ctx, '277');

    expect(runPreflight).toHaveBeenCalledTimes(1);
    const invArg = vi.mocked(runPreflight).mock.calls[0]?.[0];
    expect(invArg).toBeDefined();
    // Bare lookup key — strip the `<plugin>:` prefix so a single registered
    // preflight covers every source/namespacing of the same skill name.
    expect(invArg!.skillName).toBe('review');
  });

  it('runPreflight is called with source: "plugin"', async () => {
    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);

    const skill: DiscoveredSkill = { name: 'review', description: 'Review a PR.' };
    const cmd = makeForwardHandler(skill);
    await cmd.handler!(ctx, '277');

    expect(runPreflight).toHaveBeenCalledTimes(1);
    const invArg = vi.mocked(runPreflight).mock.calls[0]?.[0];
    expect(invArg).toBeDefined();
    // Forward path is the plugin path — source tags preflights for any future
    // per-source-divergent logic.
    expect(invArg!.source).toBe('plugin');
  });

  it('runPreflight is called with rawArgs verbatim (no trimming)', async () => {
    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);

    const skill: DiscoveredSkill = { name: 'review', description: 'Review a PR.' };
    const cmd = makeForwardHandler(skill);
    await cmd.handler!(ctx, '  277 --verbose  ');

    expect(runPreflight).toHaveBeenCalledTimes(1);
    const invArg = vi.mocked(runPreflight).mock.calls[0]?.[0];
    expect(invArg).toBeDefined();
    // Args pass through unchanged — the preflight or downstream consumer
    // decides on trimming.
    expect(invArg!.rawArgs).toBe('  277 --verbose  ');
  });

  it('runPreflight is called with capabilities { compose: true, subagents: true }', async () => {
    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);

    const skill: DiscoveredSkill = { name: 'mint', description: 'Mint a feature.' };
    const cmd = makeForwardHandler(skill);
    await cmd.handler!(ctx, 'a new idea');

    expect(runPreflight).toHaveBeenCalledTimes(1);
    const invArg = vi.mocked(runPreflight).mock.calls[0]?.[0];
    expect(invArg).toBeDefined();
    // Mirrors builtin-skills.ts: both compose and subagent forking are
    // available at slash-dispatch time. Today this is constant; here for
    // future flexibility.
    expect(invArg!.capabilities).toEqual({ compose: true, subagents: true });
  });

  it('skill with no namespace passes the literal name as skillName', async () => {
    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);

    const skill: DiscoveredSkill = { name: 'source-check', description: 'Check claims.' };
    const cmd = makeForwardHandler(skill);
    await cmd.handler!(ctx, '');

    expect(runPreflight).toHaveBeenCalledTimes(1);
    const invArg = vi.mocked(runPreflight).mock.calls[0]?.[0];
    expect(invArg).toBeDefined();
    expect(invArg!.skillName).toBe('source-check');
  });
});
