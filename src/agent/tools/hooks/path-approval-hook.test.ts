/**
 * Tests for `createPathApprovalHook` — typed file-tool gate that prompts
 * the user via `elicitationRouter` and translates the answer into grant
 * mutations + hook decisions.
 *
 * Coverage:
 *   - Typed file tools fire the prompt; other tools (bash) do not.
 *   - Paths inside the granted roots do NOT prompt.
 *   - `once` adds + records for post-cleanup; PostToolUse revokes.
 *   - `session` adds and caches; second call to same path does not re-prompt.
 *   - `persist` calls appendGrant.
 *   - `deny` returns block.
 *   - Cancel/decline → block with reason.
 *   - Concurrent calls to the same path dedupe (single prompt).
 *   - Failing-open when grant manager is not wired.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { elicitationRouter } from '../../elicitation-router.js';
import { createPathApprovalHook } from './path-approval-hook.js';
import type { GrantManager } from '../../../cli/slash/commands/allow-dir.js';
import type { PreToolUseContext, PostToolUseContext } from '../../hooks.js';
import * as permissionsStore from '../../permissions-store.js';

const BASE = '/tmp/repo';

function makeMockGrantManager(initial?: {
  readRoots?: string[];
  writeRoots?: string[];
}): GrantManager & {
  _readRoots: string[];
  _writeRoots: string[];
  _events: Array<{ op: string; path: string }>;
} {
  const readRoots = initial?.readRoots?.slice() ?? [BASE];
  const writeRoots = initial?.writeRoots?.slice() ?? [BASE];
  const events: Array<{ op: string; path: string }> = [];

  return {
    _readRoots: readRoots,
    _writeRoots: writeRoots,
    _events: events,
    addReadRoot(p) {
      if (!readRoots.includes(p)) readRoots.push(p);
      events.push({ op: 'addRead', path: p });
    },
    addWriteRoot(p) {
      if (!readRoots.includes(p)) readRoots.push(p);
      if (!writeRoots.includes(p)) writeRoots.push(p);
      events.push({ op: 'addWrite', path: p });
    },
    revokeRoot(p) {
      const rIdx = readRoots.indexOf(p);
      if (rIdx !== -1) readRoots.splice(rIdx, 1);
      const wIdx = writeRoots.indexOf(p);
      if (wIdx !== -1) writeRoots.splice(wIdx, 1);
      events.push({ op: 'revoke', path: p });
    },
    getGrants() {
      return { resolveBase: BASE, readRoots: readRoots.slice(), writeRoots: writeRoots.slice() };
    },
  };
}

function preCtx(toolName: string, input: unknown): PreToolUseContext {
  return { event: 'PreToolUse', toolName, input, sessionId: 'sess-1' };
}

function postCtx(toolName: string, input: unknown): PostToolUseContext {
  return { event: 'PostToolUse', toolName, input, sessionId: 'sess-1' };
}

beforeEach(() => {
  elicitationRouter.uninstall();
  vi.restoreAllMocks();
});

describe('createPathApprovalHook — typed-tool gating', () => {
  it('does not prompt for tools outside the typed-file-tool set (e.g. bash)', async () => {
    elicitationRouter.install(async () => ({ action: 'accept', content: { choice: 'once' } }));
    const mgr = makeMockGrantManager();
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });

    const decision = await preToolUse(preCtx('bash', { command: 'ls' }));
    expect(decision).toEqual({});
    expect(mgr._events).toHaveLength(0);
  });

  it('does not prompt for inside-cwd paths', async () => {
    const handler = vi.fn(async () => ({ action: 'accept', content: { choice: 'once' } }));
    elicitationRouter.install(handler);
    const mgr = makeMockGrantManager();
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });

    const decision = await preToolUse(
      preCtx('read_file', { file_path: '/tmp/repo/src/foo.ts' }),
    );
    expect(decision).toEqual({});
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('createPathApprovalHook — outcome mapping', () => {
  it('once: allows the call, records for post-cleanup; PostToolUse revokes', async () => {
    elicitationRouter.install(async () => ({ action: 'accept', content: { choice: 'once' } }));
    const mgr = makeMockGrantManager();
    const { preToolUse, postToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });

    const decision = await preToolUse(
      preCtx('read_file', { file_path: '/etc/hosts' }),
    );
    expect(decision).toEqual({});
    expect(mgr._readRoots).toContain('/etc/hosts');

    // PostToolUse should revoke the once-grant.
    postToolUse(postCtx('read_file', { file_path: '/etc/hosts' }));
    expect(mgr._readRoots).not.toContain('/etc/hosts');
    expect(mgr._events.map((e) => e.op)).toEqual(['addRead', 'revoke']);
  });

  it('session: adds to readRoots and caches; second call does not re-prompt', async () => {
    const handler = vi.fn(async () => ({ action: 'accept', content: { choice: 'session' } }));
    elicitationRouter.install(handler);
    const mgr = makeMockGrantManager();
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });

    await preToolUse(preCtx('read_file', { file_path: '/etc/hosts' }));
    await preToolUse(preCtx('read_file', { file_path: '/etc/hosts' }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(mgr._readRoots).toContain('/etc/hosts');
  });

  it('persist: calls appendGrant + adds to readRoots', async () => {
    const append = vi.spyOn(permissionsStore, 'appendGrant').mockImplementation(((body: unknown) => {
      return { ...(body as object), id: 'fake-ulid', grantedAt: 'now' };
    }) as never);
    elicitationRouter.install(async () => ({ action: 'accept', content: { choice: 'persist' } }));
    const mgr = makeMockGrantManager();
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'telegram',
    });

    const decision = await preToolUse(
      preCtx('write_file', { file_path: '/etc/hosts', content: 'x' }),
    );

    expect(decision).toEqual({});
    expect(mgr._writeRoots).toContain('/etc/hosts');
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[0]).toMatchObject({
      path: '/etc/hosts',
      mode: 'write',
      decision: 'allow',
      source: 'elicit:telegram',
    });
  });

  it('persist: second call to the same path does not re-prompt', async () => {
    // C10 coverage gap: the persist path populates sessionApproved + adds the
    // root, so a second call to the same path must NOT re-prompt — parity with
    // the `session` test above (which had this assertion; persist did not).
    vi.spyOn(permissionsStore, 'appendGrant').mockImplementation(((body: unknown) => {
      return { ...(body as object), id: 'fake-ulid', grantedAt: 'now' };
    }) as never);
    const handler = vi.fn(async () => ({ action: 'accept', content: { choice: 'persist' } }));
    elicitationRouter.install(handler);
    const mgr = makeMockGrantManager();
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });

    await preToolUse(preCtx('write_file', { file_path: '/etc/hosts', content: 'x' }));
    await preToolUse(preCtx('write_file', { file_path: '/etc/hosts', content: 'y' }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(mgr._writeRoots).toContain('/etc/hosts');
  });

  it('deny: returns block with descriptive reason', async () => {
    elicitationRouter.install(async () => ({ action: 'accept', content: { choice: 'deny' } }));
    const mgr = makeMockGrantManager();
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });

    const decision = await preToolUse(
      preCtx('read_file', { file_path: '/etc/hosts' }),
    );
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('/etc/hosts');
    expect(mgr._events).toHaveLength(0);
  });

  it('decline → block', async () => {
    elicitationRouter.install(async () => ({ action: 'decline' }));
    const mgr = makeMockGrantManager();
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });
    const decision = await preToolUse(preCtx('read_file', { file_path: '/etc/hosts' }));
    expect(decision.decision).toBe('block');
  });

  it('cancel → block with cancel-specific message', async () => {
    elicitationRouter.install(async () => ({ action: 'cancel' }));
    const mgr = makeMockGrantManager();
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });
    const decision = await preToolUse(preCtx('read_file', { file_path: '/etc/hosts' }));
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('cancelled');
  });
});

describe('createPathApprovalHook — list_directory / glob path extraction', () => {
  it('prompts for list_directory targeting an outside-root path', async () => {
    const handler = vi.fn(async () => ({ action: 'accept', content: { choice: 'once' } }));
    elicitationRouter.install(handler);
    const mgr = makeMockGrantManager();
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });

    const decision = await preToolUse(preCtx('list_directory', { path: '/etc' }));
    expect(decision).toEqual({});
    expect(handler).toHaveBeenCalledTimes(1);
    expect(mgr._readRoots).toContain('/etc');
  });

  it('prompts for glob targeting an outside-root path', async () => {
    const handler = vi.fn(async () => ({ action: 'accept', content: { choice: 'once' } }));
    elicitationRouter.install(handler);
    const mgr = makeMockGrantManager();
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });

    const decision = await preToolUse(preCtx('glob', { path: '/etc', pattern: '*.conf' }));
    expect(decision).toEqual({});
    expect(handler).toHaveBeenCalledTimes(1);
    expect(mgr._readRoots).toContain('/etc');
  });

  it('does NOT prompt for glob without a path arg (defaults to trusted cwd)', async () => {
    const handler = vi.fn(async () => ({ action: 'accept', content: { choice: 'once' } }));
    elicitationRouter.install(handler);
    const mgr = makeMockGrantManager();
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });

    const decision = await preToolUse(preCtx('glob', { pattern: '*.ts' }));
    expect(decision).toEqual({});
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('createPathApprovalHook — concurrency dedup', () => {
  it('two concurrent calls to the same path produce one prompt', async () => {
    let resolveHandler: (() => void) | undefined;
    const handler = vi.fn(() =>
      new Promise<{ action: 'accept'; content: { choice: string } }>((res) => {
        resolveHandler = () => res({ action: 'accept', content: { choice: 'session' } });
      }),
    );
    elicitationRouter.install(handler as never);
    const mgr = makeMockGrantManager();
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });

    // Fire two concurrent calls for the SAME path.
    const a = preToolUse(preCtx('read_file', { file_path: '/etc/hosts' }));
    const b = preToolUse(preCtx('read_file', { file_path: '/etc/hosts' }));

    // Flush microtasks so the elicitation-router's serial queue fires the
    // handler (which sets resolveHandler) before we try to call it.
    await Promise.resolve();
    await Promise.resolve();

    // Resolve the single in-flight prompt.
    resolveHandler?.();
    await Promise.all([a, b]);

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('createPathApprovalHook — turn-signal cancellation (F2 regression)', () => {
  it('forwards the turn signal so an abort cancels a pending prompt (no infinite hang)', async () => {
    // Handler mirrors the real REPL/Telegram handlers: it settles ONLY when
    // its signal aborts. Pre-fix the hook passed a throwaway signal, so this
    // prompt would hang forever and the test would time out.
    const handler = (_req: unknown, opts: { signal: AbortSignal }) =>
      new Promise((resolve) => {
        opts.signal.addEventListener('abort', () => resolve({ action: 'decline' }), {
          once: true,
        });
      });
    elicitationRouter.install(handler as never);
    const mgr = makeMockGrantManager();
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });

    const controller = new AbortController();
    const pending = preToolUse(
      preCtx('read_file', { file_path: '/etc/hosts' }),
      controller.signal,
    );
    // Let the router enqueue and start awaiting the handler, then abort.
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    const decision = await pending;
    expect(decision.decision).toBe('block'); // router returns decline on abort → block
    expect(mgr._readRoots).not.toContain('/etc/hosts');
  });
});

describe('createPathApprovalHook — SessionEnd once-grant sweep (F3 regression)', () => {
  it('revokes a once-grant whose PostToolUse never ran (abort safety net)', async () => {
    elicitationRouter.install(async () => ({ action: 'accept', content: { choice: 'once' } }));
    const mgr = makeMockGrantManager();
    const { preToolUse, sessionEnd } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });

    // Approve "once" — root added + recorded for cleanup.
    await preToolUse(preCtx('read_file', { file_path: '/etc/hosts' }));
    expect(mgr._readRoots).toContain('/etc/hosts');

    // PostToolUse never fires (the call's signal aborted). Without the sweep
    // the once-grant would leak into a full-session grant. SessionEnd cleans it.
    sessionEnd({ event: 'SessionEnd', sessionId: 'sess-1' });
    expect(mgr._readRoots).not.toContain('/etc/hosts');
    expect(mgr._events.map((e) => e.op)).toEqual(['addRead', 'revoke']);
  });

  it('is a no-op when no once-grants are outstanding', () => {
    const mgr = makeMockGrantManager();
    const { sessionEnd } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });
    sessionEnd({ event: 'SessionEnd', sessionId: 'sess-1' });
    expect(mgr._events).toHaveLength(0);
  });
});

describe('createPathApprovalHook — failsafe behavior', () => {
  it('fails open when no grant manager is wired (headless surfaces)', async () => {
    elicitationRouter.install(async () => ({ action: 'accept', content: { choice: 'deny' } }));
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => undefined,
      getCwd: () => BASE,
      surface: 'unknown',
    });

    const decision = await preToolUse(preCtx('read_file', { file_path: '/etc/hosts' }));
    // No grant manager → no pre-check; the handler's own resolveAndContain
    // will enforce containment as it does today.
    expect(decision).toEqual({});
  });

  it('fails CLOSED when a grant manager is wired but no elicitation handler is installed', async () => {
    // Security-critical: beforeEach uninstalls the router and we do NOT
    // reinstall. With a wired grant manager the pre-check runs and routes;
    // the router auto-declines when no handler exists, which MUST map to block
    // (never silently allow an outside-root path because the prompt surface is
    // missing).
    const mgr = makeMockGrantManager();
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });

    const decision = await preToolUse(preCtx('read_file', { file_path: '/etc/hosts' }));
    expect(decision.decision).toBe('block');
    expect(mgr._events).toHaveLength(0); // no grant mutation on a blocked path
  });
});
