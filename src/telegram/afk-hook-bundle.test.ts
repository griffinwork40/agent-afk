/**
 * Tests for createTelegramAfkHookBundle (afk-hook-bundle.ts) — the AFK
 * autonomous-safety wiring EXTRACTED from telegram.ts main() so it is testable.
 * main() is module-self-invoked (`main().catch(...)`) and unreachable from a
 * test, so before this extraction the two load-bearing safety args had ZERO
 * coverage and could silently regress. These pin them at the exact factory
 * telegram.ts calls:
 *   1. a LIVE permission-mode getter → the afk-mode gate is REGISTERED and tracks
 *      the session's current mode (a regression to `undefined` = no risk ceiling);
 *   2. afkPromptForApproval:false → high-risk ops HARD-REFUSE, never phone-approve.
 *
 * An out-of-workspace `write_file` is the cleanest afk-gate-only trigger: in
 * 'autonomous' mode path-approval is allowAll-bypassed, so ONLY the afk gate can
 * refuse it. dispatch() throws HookBlockedError on a block decision.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTelegramAfkHookBundle } from './afk-hook-bundle.js';
import { _resetWarningForTests } from '../agent/default-hook-registry.js';
import { HookBlockedError } from '../utils/errors.js';
import { elicitationRouter } from '../agent/elicitation-router.js';
import type { AgentSession } from '../agent/session.js';
import type { PermissionMode } from '../agent/types/sdk-types.js';

/** Minimal AgentSession stub exposing only the metadata the getter reads. */
function fakeSession(mode: PermissionMode | undefined): AgentSession {
  return {
    getSessionMetadata: () => ({ permissionMode: mode }),
  } as unknown as AgentSession;
}

describe('createTelegramAfkHookBundle — AFK autonomous safety wiring', () => {
  let tmp: string;
  beforeEach(() => {
    _resetWarningForTests();
    tmp = mkdtempSync(join(tmpdir(), 'afk-tg-bundle-'));
  });
  afterEach(() => {
    // Router is module-scope global — clear any handler a test installed.
    elicitationRouter.uninstall();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const outOfWorkspaceWrite = () => ({
    event: 'PreToolUse' as const,
    toolName: 'write_file',
    input: { file_path: join(tmpdir(), `afk-outside-${Date.now()}-${Math.random()}.txt`), content: 'x' },
  });

  it('autonomous session → HARD-REFUSES a high-risk op (gate registered + afkPromptForApproval:false)', async () => {
    const bundle = createTelegramAfkHookBundle({
      memoryStore: undefined,
      getSession: () => fakeSession('autonomous'),
      cwd: tmp, // trusted workspace root
      traceWriter: null,
    });
    await expect(bundle.registry.dispatch(outOfWorkspaceWrite())).rejects.toBeInstanceOf(HookBlockedError);
  });

  it('hard-refuse does NOT prompt the operator: the elicitation handler is never called', async () => {
    // If afkPromptForApproval:false were not threaded, the gate would default to
    // promptForApproval:true, CALL this handler, get 'approve', and ALLOW the op.
    const handler = vi.fn(async () => ({ action: 'accept' as const, content: { choice: 'approve' } }));
    elicitationRouter.install(handler);
    const bundle = createTelegramAfkHookBundle({
      memoryStore: undefined,
      getSession: () => fakeSession('autonomous'),
      cwd: tmp,
      traceWriter: null,
    });
    await expect(bundle.registry.dispatch(outOfWorkspaceWrite())).rejects.toBeInstanceOf(HookBlockedError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('session not yet late-bound (getSession→undefined) → mode falls back to \'default\', op NOT afk-refused', async () => {
    // The `?? 'default'` fallback is fail-safe: before late-bind the gate no-ops
    // (mode !== 'autonomous') and unwired path-approval fails open ⇒ dispatch resolves.
    const bundle = createTelegramAfkHookBundle({
      memoryStore: undefined,
      getSession: () => undefined,
      cwd: tmp,
      traceWriter: null,
    });
    await expect(bundle.registry.dispatch(outOfWorkspaceWrite())).resolves.toBeDefined();
  });

  it('the mode getter is LIVE — a /afk on flip AFTER construction is observed on the next dispatch', async () => {
    // Proves the late-bind contract: the getter reads the current value each call,
    // not a snapshot taken at registry-build time.
    let mode: PermissionMode = 'default';
    const bundle = createTelegramAfkHookBundle({
      memoryStore: undefined,
      getSession: () => fakeSession(mode),
      cwd: tmp,
      traceWriter: null,
    });
    // 'default': afk gate no-ops → op resolves.
    await expect(bundle.registry.dispatch(outOfWorkspaceWrite())).resolves.toBeDefined();
    // `/afk on` flips the live mode → the SAME op now hard-refuses.
    mode = 'autonomous';
    await expect(bundle.registry.dispatch(outOfWorkspaceWrite())).rejects.toBeInstanceOf(HookBlockedError);
  });

  it('autonomous still ALLOWS a reversible (safe) op — read inside the workspace', async () => {
    const bundle = createTelegramAfkHookBundle({
      memoryStore: undefined,
      getSession: () => fakeSession('autonomous'),
      cwd: tmp,
      traceWriter: null,
    });
    await expect(
      bundle.registry.dispatch({
        event: 'PreToolUse' as const,
        toolName: 'read_file',
        input: { file_path: join(tmp, 'in-workspace.ts') },
      }),
    ).resolves.toBeDefined();
  });
});
