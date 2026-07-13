/**
 * Regression tests: forkSubagent derives a forked child's READ roots by
 * inheriting the parent session's read scope (see ./subagent-read-scope).
 *
 * Bug (pre-fix, #416/#441): a fork inherited a concrete cwd but its read roots
 * either defaulted to `[worktree]` or relied on a main-root grant that vanished
 * silently on any `git rev-parse` failure. Any read outside `[cwd]` — a sibling
 * `.afk-worktrees/*` tree, a `~/.afk/state` path, the main repo — was rejected
 * as "outside the allowed read roots", and the fork could not approve it (the
 * path-approval hook auto-denies forked children), so it spun on retried
 * denials to a wall-clock timeout.
 *
 * Fix (Option A): child read scope ⊇ parent read scope. An UNCONFINED parent
 * (top-level `afk` with no worktree → reads anywhere) yields a read-open child;
 * a CONFINED parent yields the union of its roots, the child's cwd, and the
 * worktree main root. Writes stay confined (separate writeRoots axis). A caller
 * that pins `readRoots` (e.g. `afk farm`) suppresses inheritance. These tests
 * capture the config handed to the child AgentSession and assert the scope.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
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
import { getAfkStateDir } from '../paths.js';

const WORKTREE = '/repo/.afk-worktrees/wt';
const MAIN = '/repo';
const FS_ROOT = path.parse(path.resolve('.')).root || path.sep;
// A CONFINED fork is additionally granted the AFK state dir (Gap A) so it can
// read ~/.afk/state (skill-preflight inputs, todos, transcripts). Not mocked —
// the real resolver is deterministic for the process.
const STATE = getAfkStateDir();

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

  it('grants [cwd, mainRoot, state] when the manager cwd is a linked worktree', async () => {
    mockedResolve.mockResolvedValue(MAIN);
    const mgr = new SubagentManager({ cwd: WORKTREE });
    await mgr.forkSubagent(forkOpts({ model: 'sonnet', apiKey: 'k' }));

    const cfg = shared.lastConfig as { cwd?: string; readRoots?: string[] } | null;
    expect(cfg?.cwd).toBe(WORKTREE);
    expect(cfg?.readRoots).toEqual([WORKTREE, MAIN, STATE]);
    expect(mockedResolve).toHaveBeenCalledWith(WORKTREE);
  });

  it('grants READ-OPEN when the parent is unconfined (no manager cwd), even with a per-call worktree cwd', async () => {
    // A top-level `afk`/`afk i` with no `-w` is unconfined (reads anywhere).
    // A fork given an explicit worktree cwd must inherit that reach — a
    // read-open root — not be re-confined to [cwd, mainRoot]. (Writes stay
    // confined to the worktree via the separate writeRoots axis.)
    mockedResolve.mockResolvedValue(MAIN);
    const mgr = new SubagentManager(); // no manager cwd → UNCONFINED parent
    await mgr.forkSubagent(forkOpts({ model: 'sonnet', apiKey: 'k', cwd: WORKTREE }));

    const cfg = shared.lastConfig as { cwd?: string; readRoots?: string[] } | null;
    expect(cfg?.cwd).toBe(WORKTREE);
    expect(cfg?.readRoots).toEqual([FS_ROOT]);
    // Read-open ignores the worktree main root → no git resolution is paid for.
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it('grants [cwd, state] when cwd is not a worktree (no main root, but state still reachable — Gap A)', async () => {
    mockedResolve.mockResolvedValue(undefined);
    const mgr = new SubagentManager({ cwd: '/plain/repo' });
    await mgr.forkSubagent(forkOpts({ model: 'sonnet', apiKey: 'k' }));

    const cfg = shared.lastConfig as { cwd?: string; readRoots?: string[] } | null;
    expect(cfg?.cwd).toBe('/plain/repo');
    // No distinct worktree main root, but a confined fork still needs ~/.afk/state.
    expect(cfg?.readRoots).toEqual(['/plain/repo', STATE]);
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
    expect(cfg?.readRoots).toEqual([WORKTREE, MAIN, STATE]);
    // writeRoots untouched → provider defaults writes to [cwd] = the worktree.
    // The read-side state grant must NOT leak into writeRoots.
    expect(cfg?.writeRoots).toBeUndefined();
  });

  it('caches resolution per cwd: two forks share one resolver call', async () => {
    mockedResolve.mockResolvedValue(MAIN);
    const mgr = new SubagentManager({ cwd: WORKTREE });
    await mgr.forkSubagent(forkOpts({ model: 'sonnet', apiKey: 'k' }));
    await mgr.forkSubagent(forkOpts({ model: 'sonnet', apiKey: 'k' }));
    expect(mockedResolve).toHaveBeenCalledTimes(1);
  });

  it('grants [cwd, state] when the resolved main root equals cwd (no distinct main root)', async () => {
    mockedResolve.mockResolvedValue(WORKTREE);
    const mgr = new SubagentManager({ cwd: WORKTREE });
    await mgr.forkSubagent(forkOpts({ model: 'sonnet', apiKey: 'k' }));

    const cfg = shared.lastConfig as { readRoots?: string[] } | null;
    // No distinct main root to add, but the confined fork still gets ~/.afk/state.
    expect(cfg?.readRoots).toEqual([WORKTREE, STATE]);
  });

  it('does not resolve or set readRoots when no cwd is available anywhere (unconfined)', async () => {
    const mgr = new SubagentManager(); // no cwd → UNCONFINED parent
    await mgr.forkSubagent(forkOpts({ model: 'sonnet', apiKey: 'k' })); // no config.cwd

    const cfg = shared.lastConfig as { readRoots?: string[] } | null;
    // Unconfined → no state grant (read-open already covers it), no resolution.
    expect(cfg?.readRoots).toBeUndefined();
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it('falls back to the parent worktree for the main root when the child cwd does not resolve (Gap B)', async () => {
    const CHILD = '/some/unrelated/dir';
    // Child cwd is not a linked worktree (resolves to nothing); the PARENT is.
    mockedResolve.mockImplementation(async (cwd?: string) =>
      cwd === WORKTREE ? MAIN : undefined,
    );
    const mgr = new SubagentManager({ cwd: WORKTREE });
    await mgr.forkSubagent(forkOpts({ model: 'sonnet', apiKey: 'k', cwd: CHILD }));

    const cfg = shared.lastConfig as { readRoots?: string[] } | null;
    // MAIN is recovered from the parent worktree even though CHILD did not resolve,
    // so the fork can still read the main checkout + siblings (plus state).
    expect(new Set(cfg?.readRoots)).toEqual(new Set([CHILD, WORKTREE, MAIN, STATE]));
    expect(mockedResolve).toHaveBeenCalledWith(CHILD);
    expect(mockedResolve).toHaveBeenCalledWith(WORKTREE);
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
