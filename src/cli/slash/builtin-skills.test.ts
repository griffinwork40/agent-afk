/**
 * Builtin skills handler tests — `makeImmediateHandler` builds a 2-block message
 * via `buildSkillInvocationMessage` and streams it through the parent session's
 * `sendMessageStream`, delegating skill execution to the model via the skill tool.
 *
 * T02 additions: makeImmediateHandler preflight block and originToSource.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { SkillMetadata } from '../../skills/index.js';
import type { SlashContext, SessionStats } from './types.js';
import type { OutputEvent } from '../../agent/types.js';

// T02: mock runPreflight and getSkillPreflightDir so we can control preflight output
// without touching the filesystem or the real registry.
vi.mock('./preflight/index.js', () => ({
  runPreflight: vi.fn().mockResolvedValue(null),
  getSkillPreflightDir: vi.fn().mockReturnValue('/tmp/test-artifacts'),
  registerPreflight: vi.fn(),
  getPreflight: vi.fn(),
  stitchForwardManifest: (m: string | undefined, s: string) =>
    m && m.trim() ? `<system-reminder>\n${m}\n</system-reminder>\n\n${s}` : s,
}));

import { makeImmediateHandler } from './builtin-skills.js';
import { runPreflight } from './preflight/index.js';

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
    planMode: false,
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

// Reset the runPreflight mock before each test: clear recorded calls and
// reset the return value to null (no-op). This isolates tests that care
// about which arguments runPreflight was called with.
beforeEach(() => {
  vi.mocked(runPreflight).mockReset();
  vi.mocked(runPreflight).mockResolvedValue(null);
});

describe('makeImmediateHandler metadata', () => {
  it('populates usage from argumentHint so /help and tab-completion match plugin parity', () => {
    const skill: SkillMetadata = {
      name: 'mint',
      description: 'Mint a feature',
      handler: async () => undefined,
      argumentHint: '<idea>',
    };
    const cmd = makeImmediateHandler(skill);
    expect(cmd.usage).toBe('/mint <idea>');
  });

  it('omits usage when no argumentHint is declared', () => {
    const skill: SkillMetadata = {
      name: 'silent',
      description: 'No hint',
      handler: async () => undefined,
    };
    const cmd = makeImmediateHandler(skill);
    expect(cmd.usage).toBeUndefined();
  });

  it('passes flags through for tab completion', () => {
    const skill: SkillMetadata = {
      name: 'forge',
      description: 'Forge a skill',
      handler: async () => undefined,
      argumentHint: '[--brief <path>]',
      flags: ['--brief'],
    };
    const cmd = makeImmediateHandler(skill);
    expect(cmd.flags).toEqual(['--brief']);
  });
});

describe('makeImmediateHandler', () => {
  it('invokes sendMessageStream once with a 2-element ContentBlockParam array', async () => {
    const session = fakeSession([fakeContent('model response\n')]);
    const { ctx } = makeCtx(session);

    const skill: SkillMetadata = {
      name: 'test-skill',
      description: 'test skill',
      handler: async () => undefined,
    };

    const cmd = makeImmediateHandler(skill);
    await cmd.handler(ctx, 'arg1');

    expect(session.sendMessageStream).toHaveBeenCalledTimes(1);
    const messageArg = session.sendMessageStream.mock.calls[0]?.[0] as ContentBlockParam[] | undefined;
    expect(Array.isArray(messageArg)).toBe(true);
    expect(messageArg).toHaveLength(2);
    expect(messageArg?.[0]).toEqual({ type: 'text', text: expect.stringContaining('test-skill') });
    expect(messageArg?.[1]).toEqual({ type: 'text', text: expect.stringContaining('skill') });
  });

  it('includes command breadcrumb with skill name in first block', async () => {
    const session = fakeSession([fakeContent('model response\n')]);
    const { ctx } = makeCtx(session);

    const skill: SkillMetadata = {
      name: 'mint',
      description: 'test mint skill',
      handler: async () => undefined,
    };

    const cmd = makeImmediateHandler(skill);
    await cmd.handler(ctx, 'create a new feature');

    const messageArg = session.sendMessageStream.mock.calls[0]?.[0] as ContentBlockParam[] | undefined;
    const firstBlock = messageArg?.[0];
    if (firstBlock && firstBlock.type === 'text') {
      expect(firstBlock.text).toContain('command-name');
      expect(firstBlock.text).toContain('/mint');
    }
  });

  it('includes skill tool dispatch instruction in second block', async () => {
    const session = fakeSession([fakeContent('model response\n')]);
    const { ctx } = makeCtx(session);

    const skill: SkillMetadata = {
      name: 'diagnose',
      description: 'test diagnose skill',
      handler: async () => undefined,
    };

    const cmd = makeImmediateHandler(skill);
    await cmd.handler(ctx, '');

    const messageArg = session.sendMessageStream.mock.calls[0]?.[0] as ContentBlockParam[] | undefined;
    const secondBlock = messageArg?.[1];
    if (secondBlock && secondBlock.type === 'text') {
      expect(secondBlock.text).toContain('skill');
      expect(secondBlock.text).toContain('diagnose');
    }
  });

  it('stops spinner on first non-progress event', async () => {
    const events: OutputEvent[] = [
      { type: 'progress', progress: { taskId: '1', description: 'Thinking...', totalTokens: 0, toolUses: 0, durationMs: 100 } },
      { type: 'progress', progress: { taskId: '1', description: 'Still thinking...', totalTokens: 0, toolUses: 0, durationMs: 200 } },
      fakeContent('actual response\n'),
    ];
    const session = fakeSession(events);
    const { ctx } = makeCtx(session);

    const skill: SkillMetadata = {
      name: 'test-events',
      description: 'test',
      handler: async () => undefined,
    };

    const cmd = makeImmediateHandler(skill);
    await cmd.handler(ctx, '');

    // If the spinner was stopped on the first non-progress event,
    // the handler should complete without error.
    expect(session.sendMessageStream).toHaveBeenCalledTimes(1);
  });

  it('disposes renderer in finally block even on error', async () => {
    const session = fakeSession();
    const { ctx } = makeCtx(session);

    const skill: SkillMetadata = {
      name: 'test-error',
      description: 'test',
      handler: async () => undefined,
    };

    // Mock sendMessageStream to throw
    session.sendMessageStream.mockImplementation(async function* () {
      throw new Error('stream error');
    });

    const cmd = makeImmediateHandler(skill);
    await cmd.handler(ctx, '');

    // Handler should catch the error and return 'continue', not throw
    expect(session.sendMessageStream).toHaveBeenCalledTimes(1);
  });

  it('preserves error handling and outputs error message', async () => {
    const session = fakeSession();
    const { ctx, lines } = makeCtx(session);

    const skill: SkillMetadata = {
      name: 'test-fail',
      description: 'test',
      handler: async () => undefined,
    };

    // Mock sendMessageStream to throw
    session.sendMessageStream.mockImplementation(async function* () {
      throw new Error('stream failed');
    });

    const cmd = makeImmediateHandler(skill);
    await cmd.handler(ctx, '');

    expect(lines.some((l) => l.includes('ERROR:test-fail failed'))).toBe(true);
  });
});

/**
 * T02 — makeImmediateHandler preflight block and originToSource coverage.
 *
 * Uses the vi.mock('./preflight/index.js') hoisted above to control runPreflight.
 */

describe('T02 — makeImmediateHandler preflight integration', () => {
  it('when runPreflight returns a manifest, sendMessageStream receives a 3-element array', async () => {
    const manifest = '<preflight-context skill="review-pr" pr="277">Diff: /tmp/pr-277.diff</preflight-context>';
    vi.mocked(runPreflight).mockResolvedValueOnce({ manifestBlock: manifest, artifacts: { diff: '/tmp/pr-277.diff' } });

    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);

    const skill: SkillMetadata = {
      name: 'review-pr',
      description: 'review a PR',
      handler: async () => undefined,
    };

    const cmd = makeImmediateHandler(skill);
    await cmd.handler(ctx, '277');

    expect(session.sendMessageStream).toHaveBeenCalledTimes(1);
    const msg = session.sendMessageStream.mock.calls[0]?.[0] as ContentBlockParam[];
    expect(Array.isArray(msg)).toBe(true);
    // 3-element: [manifest, breadcrumb, instruction]
    expect(msg).toHaveLength(3);
    expect(msg[0]).toEqual({ type: 'text', text: manifest });
    // Second block is the breadcrumb — must contain skill name.
    expect(msg[1]?.type).toBe('text');
    expect((msg[1] as { type: 'text'; text: string }).text).toContain('review-pr');
    // Third block is the instruction.
    expect(msg[2]?.type).toBe('text');
    expect((msg[2] as { type: 'text'; text: string }).text).toContain('skill');
  });

  it('when runPreflight returns null, sendMessageStream receives the standard 2-element array', async () => {
    vi.mocked(runPreflight).mockResolvedValueOnce(null);

    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);

    const skill: SkillMetadata = {
      name: 'mint',
      description: 'mint feature',
      handler: async () => undefined,
    };

    const cmd = makeImmediateHandler(skill);
    await cmd.handler(ctx, 'idea');

    const msg = session.sendMessageStream.mock.calls[0]?.[0] as ContentBlockParam[];
    expect(msg).toHaveLength(2);
  });

  it('when runPreflight fails (returns null after catching internally), handler still sends 2-element message', async () => {
    // Simulate real runPreflight behavior: catches the error internally and
    // calls onError, then returns null. The handler (makeImmediateHandler) sees
    // null and falls back to the 2-block dispatch. Using mockImplementation (not
    // mockRejectedValueOnce) because the real runPreflight never propagates —
    // it wraps in try/catch — so the outer handler's catch block is NOT involved.
    vi.mocked(runPreflight).mockImplementationOnce(async (_inv, _ctx, onError) => {
      if (onError) onError(new Error('preflight network timeout'));
      return null;
    });

    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);

    const skill: SkillMetadata = {
      name: 'diagnose',
      description: 'diagnose bugs',
      handler: async () => undefined,
    };

    const cmd = makeImmediateHandler(skill);
    // Must not throw — preflight failure is isolated.
    await expect(cmd.handler(ctx, 'the bug')).resolves.toBeDefined();

    // sendMessageStream must still have been called (skill is not blocked).
    expect(session.sendMessageStream).toHaveBeenCalledTimes(1);
    const msg = session.sendMessageStream.mock.calls[0]?.[0] as ContentBlockParam[];
    // 2-element array — no manifest prepended on preflight failure.
    expect(msg).toHaveLength(2);
  });
});

/**
 * Image attachment forwarding tests.
 */
describe('makeImmediateHandler — image attachment forwarding', () => {
  it('returns a command with acceptsAttachments: true', () => {
    const skill: SkillMetadata = {
      name: 'forge',
      description: 'forge skill',
      handler: async () => undefined,
    };
    const cmd = makeImmediateHandler(skill);
    expect(cmd.acceptsAttachments).toBe(true);
  });

  it('when attachments passed, sendMessageStream payload includes image block at tail', async () => {
    vi.mocked(runPreflight).mockResolvedValueOnce(null);

    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);

    const skill: SkillMetadata = {
      name: 'mint',
      description: 'mint feature',
      handler: async () => undefined,
    };

    const mockImg = {
      id: 'img-1',
      mediaType: 'image/png' as const,
      bytes: Buffer.from('fakeimagedata'),
      sizeBytes: 13,
    };

    const cmd = makeImmediateHandler(skill);
    await cmd.handler(ctx, 'my idea', [mockImg]);

    const msg = session.sendMessageStream.mock.calls[0]?.[0] as ContentBlockParam[];
    expect(Array.isArray(msg)).toBe(true);
    // 2 base blocks (breadcrumb + instruction) + 1 image block
    expect(msg).toHaveLength(3);
    const lastBlock = msg[msg.length - 1];
    expect(lastBlock).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    });
    const imgBlock = lastBlock as { type: 'image'; source: { data: string } };
    expect(imgBlock.source.data).toBe(mockImg.bytes.toString('base64'));
  });

  it('when attachments passed with manifest, payload is [manifest, breadcrumb, instruction, image]', async () => {
    const manifest = '<preflight-context skill="mint">ctx</preflight-context>';
    vi.mocked(runPreflight).mockResolvedValueOnce({ manifestBlock: manifest, artifacts: {} });

    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);

    const skill: SkillMetadata = {
      name: 'mint',
      description: 'mint feature',
      handler: async () => undefined,
    };

    const mockImg = {
      id: 'img-1',
      mediaType: 'image/png' as const,
      bytes: Buffer.from('data'),
      sizeBytes: 4,
    };

    const cmd = makeImmediateHandler(skill);
    await cmd.handler(ctx, 'idea', [mockImg]);

    const msg = session.sendMessageStream.mock.calls[0]?.[0] as ContentBlockParam[];
    expect(msg).toHaveLength(4);
    expect(msg[0]).toEqual({ type: 'text', text: manifest });
    expect(msg[3]).toMatchObject({ type: 'image' });
  });

  it('when no attachments passed, payload stays at 2 blocks (no image blocks)', async () => {
    vi.mocked(runPreflight).mockResolvedValueOnce(null);

    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);

    const skill: SkillMetadata = {
      name: 'mint',
      description: 'mint feature',
      handler: async () => undefined,
    };

    const cmd = makeImmediateHandler(skill);
    await cmd.handler(ctx, 'idea'); // no attachments arg

    const msg = session.sendMessageStream.mock.calls[0]?.[0] as ContentBlockParam[];
    expect(msg).toHaveLength(2);
  });
});

/**
 * T02 — originToSource mapping.
 *
 * `originToSource` is not exported, so we exercise it indirectly via the
 * SkillInvocation.source field forwarded to runPreflight.
 */
describe('T02 — originToSource via runPreflight source field', () => {
  it('builtin skill → runPreflight called with source: "builtin"', async () => {
    vi.mocked(runPreflight).mockResolvedValueOnce(null);

    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);

    const skill: SkillMetadata = {
      name: 'mint',
      description: 'mint',
      handler: async () => undefined,
      // origin defaults to 'builtin' when undefined
    };

    const cmd = makeImmediateHandler(skill);
    await cmd.handler(ctx, '');

    const inv = (vi.mocked(runPreflight).mock.calls[0] as unknown[])[0] as { source: string };
    expect(inv.source).toBe('builtin');
  });

  it('user-origin skill → runPreflight called with source: "user"', async () => {
    vi.mocked(runPreflight).mockResolvedValueOnce(null);

    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);

    const skill: SkillMetadata = {
      name: 'my-skill',
      description: 'user skill',
      handler: async () => undefined,
      origin: 'user',
    };

    const cmd = makeImmediateHandler(skill);
    await cmd.handler(ctx, '');

    const inv = (vi.mocked(runPreflight).mock.calls[0] as unknown[])[0] as { source: string };
    expect(inv.source).toBe('user');
  });

  it('project-origin skill → runPreflight called with source: "project"', async () => {
    vi.mocked(runPreflight).mockResolvedValueOnce(null);

    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);

    const skill: SkillMetadata = {
      name: 'proj-skill',
      description: 'project skill',
      handler: async () => undefined,
      origin: 'project',
    };

    const cmd = makeImmediateHandler(skill);
    await cmd.handler(ctx, '');

    const inv = (vi.mocked(runPreflight).mock.calls[0] as unknown[])[0] as { source: string };
    expect(inv.source).toBe('project');
  });

  it('imported:claude-code origin skill → runPreflight called with source: "imported"', async () => {
    vi.mocked(runPreflight).mockResolvedValueOnce(null);

    const session = fakeSession([fakeContent('ok\n')]);
    const { ctx } = makeCtx(session);

    const skill: SkillMetadata = {
      name: 'imported-skill',
      description: 'imported skill',
      handler: async () => undefined,
      origin: 'imported:claude-code',
    };

    const cmd = makeImmediateHandler(skill);
    await cmd.handler(ctx, '');

    const inv = (vi.mocked(runPreflight).mock.calls[0] as unknown[])[0] as { source: string };
    expect(inv.source).toBe('imported');
  });
});
