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

describe('createPathApprovalHook — sub-agent auto-deny (PR1)', () => {
  // A forked sub-agent (parentSessionId set) must never prompt the operator for
  // out-of-root access — the prompt would surface on the parent's handler with
  // no attribution. The hook auto-denies instead; the sub-agent reports the
  // path requirement back to its parent.
  it('blocks an out-of-root path for a forked sub-agent without prompting', async () => {
    const handler = vi.fn(async () => ({ action: 'accept', content: { choice: 'session' } }));
    elicitationRouter.install(handler);
    const mgr = makeMockGrantManager();
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });

    const decision = await preToolUse({
      event: 'PreToolUse',
      toolName: 'read_file',
      input: { file_path: '/etc/hosts' },
      sessionId: 'child-1',
      parentSessionId: 'parent-1',
    });

    expect(decision.decision).toBe('block');
    // Never routed to the operator, never granted.
    expect(handler).not.toHaveBeenCalled();
    expect(mgr._events).toHaveLength(0);
  });

  // #435: the deny message must name the concrete remedy (mode-specific).
  it('mentions writeRoots in the deny reason for a write-mode fork', async () => {
    const mgr = makeMockGrantManager();
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });

    const decision = await preToolUse({
      event: 'PreToolUse',
      toolName: 'write_file',
      input: { file_path: '/etc/hosts', content: 'x' },
      sessionId: 'child-1',
      parentSessionId: 'parent-1',
    });

    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('Sub-agent path access denied');
    expect(decision.reason).toContain('write');
    expect(decision.reason).toContain('writeRoots');
  });

  it('mentions read roots in the deny reason for a read-mode fork', async () => {
    const mgr = makeMockGrantManager();
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });

    const decision = await preToolUse({
      event: 'PreToolUse',
      toolName: 'read_file',
      input: { file_path: '/etc/hosts' },
      sessionId: 'child-1',
      parentSessionId: 'parent-1',
    });

    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('Sub-agent path access denied');
    expect(decision.reason).toContain('read');
    // Read-mode remedy should NOT mention writeRoots.
    expect(decision.reason).not.toContain('writeRoots');
  });

  it('leaves inherited in-root access untouched for a sub-agent (no prompt, no block)', async () => {
    const handler = vi.fn(async () => ({ action: 'accept', content: { choice: 'session' } }));
    elicitationRouter.install(handler);
    const mgr = makeMockGrantManager();
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });

    // In-root path: the `!restricted` check returns {} BEFORE the sub-agent
    // guard, so paths the parent already grants stay accessible to the child.
    const decision = await preToolUse({
      event: 'PreToolUse',
      toolName: 'read_file',
      input: { file_path: '/tmp/repo/src/foo.ts' },
      sessionId: 'child-1',
      parentSessionId: 'parent-1',
    });

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

describe('createPathApprovalHook — allowAll bypass (bypassPermissions, PR2)', () => {
  // When the provider reports allowAll (session in bypassPermissions), the hook
  // must NOT prompt for out-of-root paths — wouldBeRestricted returns
  // not-restricted, mirroring the handler's resolveAndContain which also admits
  // the path. This is what makes "bypass" actually skip the approval prompt.
  it('does not prompt for an out-of-root path when grants.allowAll is true', async () => {
    const handler = vi.fn(async () => ({ action: 'accept', content: { choice: 'session' } }));
    elicitationRouter.install(handler);
    const mgr = makeMockGrantManager();
    const bypassMgr = { ...mgr, getGrants: () => ({ ...mgr.getGrants(), allowAll: true }) };
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => bypassMgr,
      getCwd: () => BASE,
      surface: 'repl',
    });

    const decision = await preToolUse(preCtx('read_file', { file_path: '/etc/hosts' }));
    expect(decision).toEqual({});
    expect(handler).not.toHaveBeenCalled();
    expect(mgr._events).toHaveLength(0);
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
});

describe('createPathApprovalHook — M1: once-grant revoked on error path', () => {
  it('PostToolUse with isError result still revokes the once-grant', async () => {
    // The dispatcher catches handler throws and converts them to
    // { content, isError: true }, then calls firePostToolUse unconditionally.
    // This test verifies postToolUseImpl revokes regardless of error status
    // (the PostToolUseContext does not carry an error flag — revoke is
    // unconditional on PostToolUse, which is correct).
    elicitationRouter.install(async () => ({ action: 'accept', content: { choice: 'once' } }));
    const mgr = makeMockGrantManager();
    const { preToolUse, postToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });

    // Pre: approve once — grant added.
    await preToolUse(preCtx('read_file', { file_path: '/etc/hosts' }));
    expect(mgr._readRoots).toContain('/etc/hosts');

    // Post fires even when the tool call produced an error result
    // (dispatcher calls firePostToolUse after its try/catch). Simulate by
    // calling postToolUse directly — the context carries no error flag.
    const postDecision = postToolUse(postCtx('read_file', { file_path: '/etc/hosts' }));
    expect(postDecision).toEqual({});

    // Grant must be revoked.
    expect(mgr._readRoots).not.toContain('/etc/hosts');
    expect(mgr._events.map((e) => e.op)).toEqual(['addRead', 'revoke']);
  });
});

describe('createPathApprovalHook — M1 cwd: stored-cwd revoke is cwd-drift-safe', () => {
  it('Post uses the cwd captured at Pre time even if getCwd() changes between calls', async () => {
    // Pre fires with cwd = /tmp/repo; between Pre and Post the cwd drifts to
    // /tmp/other. postToolUseImpl must still find and revoke the entry using
    // the stored pre-cwd, not the current (drifted) one.
    elicitationRouter.install(async () => ({ action: 'accept', content: { choice: 'once' } }));
    const mgr = makeMockGrantManager();

    let currentCwd = BASE; // mutable — simulates a cwd change mid-call.
    const { preToolUse, postToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => currentCwd,
      surface: 'repl',
    });

    // Pre fires while cwd is BASE.
    await preToolUse(preCtx('read_file', { file_path: '/etc/hosts' }));
    expect(mgr._readRoots).toContain('/etc/hosts');

    // Simulate cwd changing between Pre and Post (e.g. /cwd command).
    currentCwd = '/tmp/other-repo';

    // Post must still revoke using the Pre-captured cwd.
    postToolUse(postCtx('read_file', { file_path: '/etc/hosts' }));
    expect(mgr._readRoots).not.toContain('/etc/hosts');
    expect(mgr._events.map((e) => e.op)).toEqual(['addRead', 'revoke']);
  });
});

describe('createPathApprovalHook — M5: audit log line emitted per decision', () => {
  it('emits a [path-approval] log line on the "once" decision', async () => {
    elicitationRouter.install(async () => ({ action: 'accept', content: { choice: 'once' } }));
    const mgr = makeMockGrantManager();
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'repl',
    });

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await preToolUse(preCtx('read_file', { file_path: '/etc/hosts' }));

    const calls = spy.mock.calls.map((args) => String(args[0]));
    const logLine = calls.find((l) => l.startsWith('[path-approval]'));
    expect(logLine).toBeDefined();
    expect(logLine).toContain('surface=repl');
    expect(logLine).toContain('tool=read_file');
    expect(logLine).toContain('path=/etc/hosts');
    expect(logLine).toContain('outcome=once');
  });

  it('emits a [path-approval] log line on the "deny" decision', async () => {
    elicitationRouter.install(async () => ({ action: 'accept', content: { choice: 'deny' } }));
    const mgr = makeMockGrantManager();
    const { preToolUse } = createPathApprovalHook({
      getGrantManager: () => mgr,
      getCwd: () => BASE,
      surface: 'telegram',
    });

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await preToolUse(preCtx('write_file', { file_path: '/etc/hosts', content: 'x' }));

    const calls = spy.mock.calls.map((args) => String(args[0]));
    const logLine = calls.find((l) => l.startsWith('[path-approval]'));
    expect(logLine).toBeDefined();
    expect(logLine).toContain('surface=telegram');
    expect(logLine).toContain('tool=write_file');
    expect(logLine).toContain('outcome=deny');
  });
});
