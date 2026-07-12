/**
 * Regression tests: forkSubagent grants the MAIN repo root as a read root to
 * subagents whose cwd is a linked git worktree.
 *
 * Bug (pre-fix): a subagent forked from an `afk -w` worktree session inherits
 * the worktree cwd but no read roots, so its dispatcher defaults to
 * `readRoots = [worktree]`. Any `read_file <mainRepo>/…` is rejected as
 * "outside the allowed read roots", and the subagent cannot approve it (the
 * path-approval hook auto-denies forked children). This locks subagents out of
 * main-repo paths that pervade their context.
 *
 * Fix: forkSubagent resolves the worktree's main-repo root (best-effort, via
 * ./worktree-read-root) and sets `childConfig.readRoots = [cwd, mainRoot]` when
 * the caller did not pin its own read roots. These tests capture the config
 * handed to the child AgentSession and assert the grant.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from './types.js';

type CapturedConfig = Record<string, unknown> | null;

const shared = vi.hoisted(() => ({
  lastConfig: null as CapturedConfig,
}));

vi.mock('./session.js', () => {
  class MockAgentSession {
    public readonly sessionId?: string;
    public sendMessage: ReturnType<typeof vi.fn>;
    public sendMessageStream: ReturnType<typeof vi.fn>;
    public interrupt = vi.fn(async () => undefined);
    public close = vi.fn(async () => undefined);
    constructor(config: Record<string, unknown>) {
      shared.lastConfig = config;
      this.sessionId = (config.sessionId as string | undefined) ?? 'child-session-id';
      this.sendMessage = vi.fn(async (content: string): Promise<Message> => ({
        role: 'assistant',
        content: `ok:${content}`,
        timestamp: new Date(),
      }));
      this.sendMessageStream = vi.fn(async function* (this: MockAgentSession, content: string) {
        const result = await this.sendMessage(content);
        yield { type: 'message', message: result };
        yield { type: 'done' };
      }.bind(this));
    }
    get abortSignal(): AbortSignal {
      return new AbortController().signal;
    }
  }
  return { AgentSession: MockAgentSession };
});

// Control the worktree → main-root resolver without touching real git.
vi.mock('./worktree-read-root.js', () => ({
  resolveWorktreeMainRoot: vi.fn(async () => undefined),
}));

import { SubagentManager } from './subagent.js';
import { resolveWorktreeMainRoot } from './worktree-read-root.js';

const WORKTREE = '/repo/.afk-worktrees/wt';
const MAIN = '/repo';

const mockedResolve = vi.mocked(resolveWorktreeMainRoot);

function forkOpts(
  config: Record<string, unknown>,
): Parameters<SubagentManager['forkSubagent']>[0] {
  return {
    parent: { sessionId: 'parent' },
    config,
  } as Parameters<SubagentManager['forkSubagent']>[0];
}

describe('forkSubagent — worktree main-repo read-root grant', () => {
  beforeEach(() => {
    shared.lastConfig = null;
    mockedResolve.mockReset();
    mockedResolve.mockResolvedValue(undefined);
  });

  it('grants [cwd, mainRoot] when the manager cwd is a linked worktree', async () => {
    mockedResolve.mockResolvedValue(MAIN);
    const mgr = new SubagentManager({ cwd: WORKTREE });
    await mgr.forkSubagent(forkOpts({ model: 'sonnet', apiKey: 'k' }));

    const cfg = shared.lastConfig as { cwd?: string; readRoots?: string[] } | null;
    expect(cfg?.cwd).toBe(WORKTREE);
    expect(cfg?.readRoots).toEqual([WORKTREE, MAIN]);
    expect(mockedResolve).toHaveBeenCalledWith(WORKTREE);
  });

  it('grants [cwd, mainRoot] when cwd comes from per-call config (agent tool cwd)', async () => {
    mockedResolve.mockResolvedValue(MAIN);
    const mgr = new SubagentManager(); // no manager cwd
    await mgr.forkSubagent(forkOpts({ model: 'sonnet', apiKey: 'k', cwd: WORKTREE }));

    const cfg = shared.lastConfig as { cwd?: string; readRoots?: string[] } | null;
    expect(cfg?.cwd).toBe(WORKTREE);
    expect(cfg?.readRoots).toEqual([WORKTREE, MAIN]);
    expect(mockedResolve).toHaveBeenCalledWith(WORKTREE);
  });

  it('does NOT set readRoots when cwd is not a worktree (resolver returns undefined)', async () => {
    mockedResolve.mockResolvedValue(undefined);
    const mgr = new SubagentManager({ cwd: '/plain/repo' });
    await mgr.forkSubagent(forkOpts({ model: 'sonnet', apiKey: 'k' }));

    const cfg = shared.lastConfig as { cwd?: string; readRoots?: string[] } | null;
    expect(cfg?.cwd).toBe('/plain/repo');
    // Left unset so the provider applies its own `[cwd]` default.
    expect(cfg?.readRoots).toBeUndefined();
  });

  it('does NOT override caller-pinned readRoots (e.g. afk farm) and skips resolution', async () => {
    const mgr = new SubagentManager({ cwd: WORKTREE });
    await mgr.forkSubagent(
      forkOpts({ model: 'sonnet', apiKey: 'k', cwd: WORKTREE, readRoots: [WORKTREE], writeRoots: [WORKTREE] }),
    );

    const cfg = shared.lastConfig as { readRoots?: string[]; writeRoots?: string[] } | null;
    expect(cfg?.readRoots).toEqual([WORKTREE]);
    expect(cfg?.writeRoots).toEqual([WORKTREE]);
    // Caller pinned readRoots → we must not even resolve (no git subprocess).
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it('does not grant a write root (worktree write isolation preserved)', async () => {
    mockedResolve.mockResolvedValue(MAIN);
    const mgr = new SubagentManager({ cwd: WORKTREE });
    await mgr.forkSubagent(forkOpts({ model: 'sonnet', apiKey: 'k' }));

    const cfg = shared.lastConfig as { readRoots?: string[]; writeRoots?: string[] } | null;
    expect(cfg?.readRoots).toEqual([WORKTREE, MAIN]);
    // writeRoots untouched → provider defaults writes to [cwd] = the worktree.
    expect(cfg?.writeRoots).toBeUndefined();
  });

  it('caches resolution per cwd: two forks share one resolver call', async () => {
    mockedResolve.mockResolvedValue(MAIN);
    const mgr = new SubagentManager({ cwd: WORKTREE });
    await mgr.forkSubagent(forkOpts({ model: 'sonnet', apiKey: 'k' }));
    await mgr.forkSubagent(forkOpts({ model: 'sonnet', apiKey: 'k' }));
    expect(mockedResolve).toHaveBeenCalledTimes(1);
  });

  it('does not set readRoots when the resolved main root equals cwd (defensive)', async () => {
    mockedResolve.mockResolvedValue(WORKTREE);
    const mgr = new SubagentManager({ cwd: WORKTREE });
    await mgr.forkSubagent(forkOpts({ model: 'sonnet', apiKey: 'k' }));

    const cfg = shared.lastConfig as { readRoots?: string[] } | null;
    expect(cfg?.readRoots).toBeUndefined();
  });

  it('does not resolve or set readRoots when no cwd is available anywhere', async () => {
    const mgr = new SubagentManager(); // no cwd
    await mgr.forkSubagent(forkOpts({ model: 'sonnet', apiKey: 'k' })); // no config.cwd

    const cfg = shared.lastConfig as { readRoots?: string[] } | null;
    expect(cfg?.readRoots).toBeUndefined();
    expect(mockedResolve).not.toHaveBeenCalled();
  });
});

describe('forkSubagent — explicit write-root pre-grant (#435)', () => {
  beforeEach(() => {
    shared.lastConfig = null;
    mockedResolve.mockReset();
    mockedResolve.mockResolvedValue(undefined);
  });

  it('composes config.writeRoots with the child cwd (deduped)', async () => {
    const mgr = new SubagentManager({ cwd: WORKTREE });
    await mgr.forkSubagent(
      forkOpts({ model: 'sonnet', apiKey: 'k', writeRoots: ['/sibling/repo'] }),
    );

    const cfg = shared.lastConfig as { writeRoots?: string[] } | null;
    // cwd is always included so the child keeps write access to its own tree.
    expect(cfg?.writeRoots).toEqual([WORKTREE, '/sibling/repo']);
  });

  it('dedupes when config.writeRoots already contains the cwd', async () => {
    const mgr = new SubagentManager({ cwd: WORKTREE });
    await mgr.forkSubagent(
      forkOpts({ model: 'sonnet', apiKey: 'k', writeRoots: [WORKTREE, '/sibling'] }),
    );

    const cfg = shared.lastConfig as { writeRoots?: string[] } | null;
    // Set dedup: WORKTREE appears once even though both base and writeRoots include it.
    expect(cfg?.writeRoots).toEqual([WORKTREE, '/sibling']);
  });

  it('does not override writeRoots when config.writeRoots is absent', async () => {
    const mgr = new SubagentManager({ cwd: WORKTREE });
    await mgr.forkSubagent(forkOpts({ model: 'sonnet', apiKey: 'k' }));

    const cfg = shared.lastConfig as { writeRoots?: string[] } | null;
    // No explicit writeRoots → provider defaults to [cwd].
    expect(cfg?.writeRoots).toBeUndefined();
  });
});
