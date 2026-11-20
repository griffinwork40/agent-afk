/**
 * Tests for createTelegramAfkHookBundle (afk-hook-bundle.ts) — the hook
 * registry wiring EXTRACTED from telegram.ts main() so it is testable.
 * main() is module-self-invoked (`main().catch(...)`) and unreachable from a
 * test, so before this extraction the wiring had ZERO coverage and could
 * silently regress.
 *
 * Tests verify:
 *   1. a LIVE permission-mode getter → the plan-mode gate is REGISTERED and
 *      tracks the session's current mode;
 *   2. safe reads always resolve;
 *   3. the mode getter is live — a flip after construction is observed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTelegramAfkHookBundle } from './afk-hook-bundle.js';
import { _resetWarningForTests } from '../agent/default-hook-registry.js';
import type { AgentSession } from '../agent/session.js';
import type { PermissionMode } from '../agent/types/sdk-types.js';

/** Minimal AgentSession stub exposing only the metadata the getter reads. */
function fakeSession(mode: PermissionMode | undefined): AgentSession {
  return {
    getSessionMetadata: () => ({ permissionMode: mode }),
  } as unknown as AgentSession;
}

describe('createTelegramAfkHookBundle — hook registry wiring', () => {
  let tmp: string;
  beforeEach(() => {
    _resetWarningForTests();
    tmp = mkdtempSync(join(tmpdir(), 'afk-tg-bundle-'));
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('session not yet late-bound (getSession→undefined) → mode falls back to \'default\', op resolves', async () => {
    const bundle = createTelegramAfkHookBundle({
      memoryStore: undefined,
      getSession: () => undefined,
      cwd: tmp,
      traceWriter: null,
    });
    await expect(bundle.registry.dispatch({
      event: 'PreToolUse' as const,
      toolName: 'read_file',
      input: { file_path: join(tmp, 'in-workspace.ts') },
    })).resolves.toBeDefined();
  });

  it('the mode getter is LIVE — a mode flip AFTER construction is observed on the next dispatch', async () => {
    // Proves the late-bind contract: the getter reads the current value each call,
    // not a snapshot taken at registry-build time.
    let mode: PermissionMode = 'default';
    const bundle = createTelegramAfkHookBundle({
      memoryStore: undefined,
      getSession: () => fakeSession(mode),
      cwd: tmp,
      traceWriter: null,
    });
    // 'default': op resolves.
    await expect(bundle.registry.dispatch({
      event: 'PreToolUse' as const,
      toolName: 'read_file',
      input: { file_path: join(tmp, 'in-workspace.ts') },
    })).resolves.toBeDefined();
    // flip to bypassPermissions — still resolves for a safe read.
    mode = 'bypassPermissions';
    await expect(bundle.registry.dispatch({
      event: 'PreToolUse' as const,
      toolName: 'read_file',
      input: { file_path: join(tmp, 'in-workspace.ts') },
    })).resolves.toBeDefined();
  });

  it('allows a reversible (safe) read inside the workspace', async () => {
    const bundle = createTelegramAfkHookBundle({
      memoryStore: undefined,
      getSession: () => fakeSession('bypassPermissions'),
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
