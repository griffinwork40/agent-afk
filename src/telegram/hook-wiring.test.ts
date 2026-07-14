/**
 * Telegram hook-wiring contract (PR #202 review H1 + L4).
 *
 * Both Telegram session branches in `telegram.ts main()` — the Anthropic-direct
 * branch and the OpenAI-compatible ("codex") branch — MUST wire
 * `pathApprovalGrantRef.current` to their provider and call
 * `seedPersistedGrants`, or path-approval AND the bash interpreter denylist
 * silently fail open for that surface (the hooks are registered but no-op
 * because `getGrantManager()` returns undefined). Before the H1 fix the codex
 * branch built `createDefaultHookRegistry(...).registry` — discarding the
 * bundle, never wiring the ref, never seeding.
 *
 * The literal `createSession` closure in `telegram.ts main()` cannot be reached
 * from a test (see `telegram/construct-session.ts`), so this pins the wiring
 * CONTRACT both branches depend on: each provider must satisfy `GrantManager`,
 * accept assignment to the hook bundle's grant ref, and reflect persisted
 * grants once seeded. A regression that makes the OpenAI-compatible provider
 * unwirable (the H1 class of bug) trips here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createDefaultHookRegistry,
  _resetWarningForTests,
} from '../agent/default-hook-registry.js';
import { AnthropicDirectProvider, OpenAICompatibleProvider } from '../agent/providers/index.js';
import type { GrantManager } from '../cli/slash/commands/allow-dir.js';
import { seedPersistedGrants, generateUlid, type PermissionsFile } from '../agent/permissions-store.js';
import { HookBlockedError } from '../utils/errors.js';
import { elicitationRouter } from '../agent/elicitation-router.js';

function writePermissionsFile(dir: string, absPath: string): string {
  const file = join(dir, 'permissions.json');
  const contents: PermissionsFile = {
    version: 1,
    grants: [
      {
        id: generateUlid(),
        path: absPath,
        mode: 'read',
        decision: 'allow',
        grantedAt: new Date().toISOString(),
        source: 'elicit:telegram',
      },
    ],
  };
  writeFileSync(file, JSON.stringify(contents, null, 2), 'utf8');
  return file;
}

// One entry per Telegram session branch. Both must be wirable identically.
const providerFactories: Record<string, () => GrantManager> = {
  // Anthropic-direct branch (telegram.ts: `directProvider`).
  AnthropicDirectProvider: () => new AnthropicDirectProvider(),
  // OpenAI-compatible / codex branch (telegram.ts: `codexProvider`, the H1 fix).
  OpenAICompatibleProvider: () => new OpenAICompatibleProvider(),
};

describe('Telegram hook wiring — path-approval grant ref (PR #202 H1/L4)', () => {
  let tmp: string;

  beforeEach(() => {
    _resetWarningForTests();
    tmp = mkdtempSync(join(tmpdir(), 'afk-tg-wiring-'));
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  for (const [name, make] of Object.entries(providerFactories)) {
    it(`${name}: grant ref starts unwired, accepts the provider, and reflects seeded grants`, () => {
      const bundle = createDefaultHookRegistry(
        undefined,
        'telegram',
        undefined,
        undefined,
        undefined,
        undefined,
        () => tmp,
      );

      // Hooks are registered but the ref is unwired until the bootstrap sets it
      // — the exact fail-open state the codex branch was stuck in (H1).
      expect(bundle.pathApprovalGrantRef.current).toBeUndefined();

      // Must typecheck: the provider satisfies the GrantManager interface.
      const provider = make();
      bundle.pathApprovalGrantRef.current = provider;
      expect(bundle.pathApprovalGrantRef.current).toBe(provider);

      // Seeding a persisted `allow` grant must surface on the wired provider —
      // this is what makes the `persist` elicitation choice survive across
      // sessions on this surface.
      const granted = join(tmp, 'granted-dir');
      const file = writePermissionsFile(tmp, granted);
      seedPersistedGrants(provider, file);
      expect(provider.getGrants().readRoots).toContain(granted);
    });
  }
});

// ---------------------------------------------------------------------------
// D v1: AFK autonomous safety wiring on Telegram
// ---------------------------------------------------------------------------

/**
 * The always-on Telegram host must (a) actually REGISTER the afk-mode safety
 * gate when a session is autonomous — before D v1 it passed getPermissionMode
 * `undefined`, so the gate was never registered and an autonomous Telegram
 * session had NO risk ceiling — and (b) HARD-REFUSE high-risk/irreversible ops
 * (afkPromptForApproval:false) rather than accept a one-tap phone approval.
 *
 * An out-of-workspace `write_file` is the cleanest afk-gate-only trigger: in
 * 'autonomous' mode path-approval is allowAll-bypassed, so ONLY the afk gate can
 * refuse it. `dispatch()` throws HookBlockedError on a block decision.
 */
describe('Telegram AFK autonomous safety wiring (D v1)', () => {
  let tmp: string;
  beforeEach(() => {
    _resetWarningForTests();
    tmp = mkdtempSync(join(tmpdir(), 'afk-tg-afk-'));
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

  it('autonomous + afkPromptForApproval:false HARD-REFUSES a high-risk op (no phone approval)', async () => {
    const bundle = createDefaultHookRegistry(
      undefined,
      'telegram',
      undefined,
      () => 'autonomous', // D v1: the mode getter is now wired
      undefined,
      { afkPromptForApproval: false }, // always-on host posture: hard-refuse
      () => tmp, // trusted workspace root
    );
    await expect(bundle.registry.dispatch(outOfWorkspaceWrite())).rejects.toBeInstanceOf(HookBlockedError);
  });

  it('regression: with NO mode getter (old wiring) the afk gate is absent, so the same op is NOT refused', async () => {
    const bundle = createDefaultHookRegistry(
      undefined,
      'telegram',
      undefined,
      undefined, // getPermissionMode undefined → afk gate never registered
      undefined,
      undefined,
      () => tmp,
    );
    // No afk gate + unwired (fail-open) path-approval ⇒ dispatch resolves, no block.
    await expect(bundle.registry.dispatch(outOfWorkspaceWrite())).resolves.toBeDefined();
  });

  it('hard-refuse does NOT prompt the operator: the elicitation handler is never called', async () => {
    // If afkPromptForApproval:false were NOT threaded through the registry, the
    // gate would default to promptForApproval:true, CALL this handler, get an
    // 'approve', and ALLOW the op (dispatch resolves). Threaded correctly, the
    // op hard-blocks WITHOUT ever asking — this is the always-on-host posture.
    const handler = vi.fn(async () => ({ action: 'accept' as const, content: { choice: 'approve' } }));
    elicitationRouter.install(handler);
    const bundle = createDefaultHookRegistry(
      undefined,
      'telegram',
      undefined,
      () => 'autonomous',
      undefined,
      { afkPromptForApproval: false },
      () => tmp,
    );
    await expect(bundle.registry.dispatch(outOfWorkspaceWrite())).rejects.toBeInstanceOf(HookBlockedError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('autonomous still allows a reversible (safe) op — read inside the workspace', async () => {
    const bundle = createDefaultHookRegistry(
      undefined,
      'telegram',
      undefined,
      () => 'autonomous',
      undefined,
      { afkPromptForApproval: false },
      () => tmp,
    );
    await expect(
      bundle.registry.dispatch({
        event: 'PreToolUse' as const,
        toolName: 'read_file',
        input: { file_path: join(tmp, 'in-workspace.ts') },
      }),
    ).resolves.toBeDefined();
  });
});
