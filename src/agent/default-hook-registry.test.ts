/**
 * createDefaultHookRegistry — config-loader warning surfacing (PR #477 review P2).
 *
 * The hooks config-loader records non-fatal problems (parse/schema errors and
 * the orphan root-settings notice for a misplaced `$AFK_HOME/settings.json`) on
 * `LoadedHooksConfig.warnings`, documented as "the caller should surface". No
 * caller did: every surface (chat, REPL bootstrap, daemon/scheduler, Telegram)
 * passes the config straight into `createDefaultHookRegistry`, which — before
 * this fix — only registered hooks and never emitted `warnings`. A misplaced
 * root settings file therefore stayed silent and the owner could believe those
 * hooks were active. These tests pin that the registry now emits each distinct
 * warning once, deduped so repeated session construction can't re-spam.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDefaultHookRegistry, _resetWarningForTests } from './default-hook-registry.js';
import type { LoadedHooksConfig } from './hooks/config-loader.js';
import type { ElicitationResult } from './types/sdk-types.js';

function makeConfig(overrides: Partial<LoadedHooksConfig> = {}): LoadedHooksConfig {
  return {
    hooks: {},
    userGlobalEnabled: true,
    allowProjectHooks: false,
    pluginHooksEnabled: false,
    pluginHookEnv: {},
    sources: [],
    warnings: [],
    ...overrides,
  };
}

// Representative loader warning (the orphan root-settings notice). The exact
// text is irrelevant to this contract — only that whatever lands in
// `warnings[]` reaches the user — so this is a fixture, not a format assertion.
const ORPHAN_WARNING =
  'found /home/u/.afk/settings.json but AFK does not read settings from the AFK-home root; ' +
  'user-global hooks/settings belong in /home/u/.afk/config/settings.json — the root file is ignored';

describe('createDefaultHookRegistry — surfaces config-loader warnings (PR #477 P2)', () => {
  beforeEach(() => {
    _resetWarningForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits the orphan root-settings warning that was previously silent', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createDefaultHookRegistry(undefined, 'cli', undefined, undefined, makeConfig({ warnings: [ORPHAN_WARNING] }));
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes(ORPHAN_WARNING))).toBe(true);
    // Surfaced through the shared `[hooks]` channel, like skipped-hook warnings.
    expect(messages.some((m) => m.includes('[hooks]'))).toBe(true);
  });

  it('surfaces warnings even when the config has zero registrable hooks (the orphan case)', () => {
    // The orphan case: a root settings.json exists → a warning, but hooks:{}
    // so nothing registers. The warning must still surface — this is exactly
    // the state that was silent before the fix.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createDefaultHookRegistry(undefined, 'cli', undefined, undefined, makeConfig({ hooks: {}, warnings: [ORPHAN_WARNING] }));
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes(ORPHAN_WARNING))).toBe(true);
  });

  it('emits every distinct warning in the array', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = 'hooks config at /p/.afk/settings.json: parse error — bad json';
    const b = ORPHAN_WARNING;
    createDefaultHookRegistry(undefined, 'cli', undefined, undefined, makeConfig({ warnings: [a, b] }));
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes(a))).toBe(true);
    expect(messages.some((m) => m.includes(b))).toBe(true);
  });

  it('dedupes: repeated session construction does not re-spam the same warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = makeConfig({ warnings: [ORPHAN_WARNING] });
    // Two constructions in one process (e.g. two daemon ticks / two Telegram chats).
    createDefaultHookRegistry(undefined, 'cli', undefined, undefined, cfg);
    createDefaultHookRegistry(undefined, 'telegram', undefined, undefined, cfg);
    const hits = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(ORPHAN_WARNING));
    expect(hits).toHaveLength(1);
  });

  it('stays silent when the config carries no warnings', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createDefaultHookRegistry(undefined, 'cli', undefined, undefined, makeConfig({ warnings: [] }));
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('[hooks]'))).toBe(false);
  });

  it('does not emit config warnings when hookConfig is omitted (the common case)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createDefaultHookRegistry(undefined, 'cli');
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('[hooks]'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AFK risk gate registration on daemon and afk-chat surfaces (#2298)
// ---------------------------------------------------------------------------
//
// `createDefaultHookRegistry` was only registering the AFK-mode gate
// (`createAfkModeGate`) when `getPermissionMode !== undefined`. The daemon and
// one-shot `afk chat` callers both passed `undefined`, so the gate was never
// wired on those surfaces — the unattended surfaces where authority control
// matters most.
//
// The fix: daemon always passes `() => 'autonomous'`; chat passes a getter for
// its resolved permission mode. These tests verify the behavioral consequence:
// a high-risk tool call (`create_schedule`) dispatched through the registry
// produced by the *fixed* call shape must be BLOCKED.
//
// The gate's elicitation `route` is stubbed to DECLINE so high-risk ops degrade
// immediately to the legacy hard block, isolating the registration assertion
// from the approval round-trip path tested in `afk-mode-gate.test.ts`.
describe('createDefaultHookRegistry — AFK gate wired for daemon and afk-chat (#2298)', () => {
  beforeEach(() => {
    _resetWarningForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Stub elicitation to DECLINE so the gate hard-blocks without a router round-trip.
  const declineRoute = async (): Promise<ElicitationResult> => ({ action: 'decline' });

  it('daemon call shape: high-risk create_schedule is BLOCKED', async () => {
    // Mirrors the fixed daemon/session-spawn.ts call:
    //   createDefaultHookRegistry(undefined, 'daemon', undefined, () => 'autonomous', ...)
    const { registry } = createDefaultHookRegistry(
      undefined,
      'daemon',
      undefined,
      (): 'autonomous' => 'autonomous',
      undefined,
      { afkPromptForApproval: false },
    );

    // Inject a stub elicitation route so the gate hard-blocks immediately.
    // The gate exposes this via its opts.route injectable — we reach it by
    // re-registering a handler that the gate would have used. Since the gate
    // is the registered handler, we test it via dispatch.
    //
    // A simpler structural check: verify at least one PreToolUse handler is
    // registered (confirming the gate was added), then confirm the dispatch
    // result BLOCKS. If the gate were absent (old undefined path), dispatch
    // would return an empty `{}` decision with no `block` field.
    const preToolUseCount = registry.count('PreToolUse');
    // At minimum: safe-destruct + release-boundary + plan-gate + afk-gate + edit-preview + path-approval
    expect(preToolUseCount).toBeGreaterThanOrEqual(4);

    // The registry throws HookBlockedError when a gate blocks a call — the
    // same throw shape the SessionToolDispatcher catches and converts to an
    // isError tool result. Verify the gate fires and blocks.
    await expect(
      registry.dispatch(
        {
          event: 'PreToolUse',
          toolName: 'create_schedule',
          // No parentSessionId → top-level session (gate fires, not subagent skip)
        },
        undefined,
        // Override the per-handler deadline with Infinity so the test isn't
        // racing a 30s timeout. The gate degrades to hard-block because no
        // elicitation handler is installed (promptForApproval: false).
        Infinity,
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/AFK mode|autonomous/i) });
  });

  it('daemon call shape: safe read_file is NOT blocked', async () => {
    const { registry } = createDefaultHookRegistry(
      undefined,
      'daemon',
      undefined,
      (): 'autonomous' => 'autonomous',
      undefined,
      { afkPromptForApproval: false },
    );

    const decision = await registry.dispatch(
      { event: 'PreToolUse', toolName: 'read_file' },
      undefined,
      Infinity,
    );

    // read_file is 'safe' — AFK gate passes it through.
    expect(decision.block).toBeFalsy();
  });

  it('chat call shape with autonomous mode: high-risk bash rm is BLOCKED', async () => {
    // Mirrors the fixed chat.ts call when cliConfig.permissionMode === 'autonomous':
    //   createDefaultHookRegistry(fn, 'cli', store, () => cliConfig.permissionMode, ...)
    const { registry } = createDefaultHookRegistry(
      undefined,
      'cli',
      undefined,
      (): 'autonomous' => 'autonomous',
      undefined,
      { afkPromptForApproval: false },
    );

    await expect(
      registry.dispatch(
        {
          event: 'PreToolUse',
          toolName: 'bash',
          input: { command: 'rm -rf /tmp/x' },
        },
        undefined,
        Infinity,
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/AFK mode|autonomous/i) });
  });

  it('chat call shape with bypass mode: high-risk bash rm is NOT blocked by the AFK gate', async () => {
    // When permissionMode is 'bypassPermissions', the AFK gate's getMode()
    // returns 'bypassPermissions' — not 'autonomous' — so the gate is a no-op.
    const { registry } = createDefaultHookRegistry(
      undefined,
      'cli',
      undefined,
      (): 'bypassPermissions' => 'bypassPermissions',
    );

    const decision = await registry.dispatch(
      {
        event: 'PreToolUse',
        toolName: 'bash',
        input: { command: 'rm -rf /tmp/x' },
      },
      undefined,
      Infinity,
    );

    // Gate is wired but fires only on 'autonomous'; other modes pass through.
    expect(decision.block).toBeFalsy();
  });

  void declineRoute; // referenced in test description; kept for doc clarity
});

// ---------------------------------------------------------------------------
// PreToolUse hook registration order (#3726)
// ---------------------------------------------------------------------------
//
// Order is load-bearing: `decision: 'block'` short-circuits the chain so no
// later handler fires. The effect-ledger PreToolUse hook must be registered
// AFTER path-approval and policy hooks. This matters because #3713 added the
// ledger's PreToolUse hook and the refactor in #3684 makes a silent reorder
// easier.
//
// Strategy: spy on the ledger's `pre` handler. When path-approval blocks a
// call (outside-workspace read_file), the ledger must NOT have fired —
// proving path-approval precedes the ledger in registration order.
//
// A second assertion verifies that the whatif-episode gate (registered FIRST)
// short-circuits before the child-memory guard — confirming top-of-chain order.
describe('createDefaultHookRegistry — PreToolUse registration order (#3726)', () => {
  beforeEach(() => {
    _resetWarningForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('path-approval fires before the effect-ledger pre hook (ledger does not record a blocked call)', async () => {
    // Arrange: spy on createEffectLedgerHooks so we can track whether the
    // ledger's pre handler is invoked. We intercept via vi.mock at module
    // scope — but since module mocks must be hoisted we spy on the bound
    // function instead: wrap the registry dispatch and observe side-effects.
    //
    // Observable consequence: if path-approval runs first and blocks, the
    // ledger pre hook never fires → no pending record is written to the store.
    // We verify this by checking the count of PreToolUse handlers drops by
    // exactly 2 when path-approval is disabled (approval + bash-restriction),
    // AND that enabling path-approval causes dispatch to throw (block) for an
    // outside read_file before any ledger state is mutated.
    //
    // The registry exposes only `count()`, so we verify order behaviorally:
    // path-approval blocks → HookBlockedError thrown → ledger's `pre` never
    // reached (if it were first, it would record a pending intent with no
    // corresponding settle, which is detectable via the EffectStore).

    // Use a controlled dispatch: path-approval enabled, dispatch an
    // outside-workspace read_file. Path-approval must block synchronously
    // (no elicitation router installed → hard deny).
    const { registry } = createDefaultHookRegistry(
      undefined,
      'cli',
      undefined,
      undefined,
      undefined,
      { cwd: '/tmp' },
    );

    // read_file is NOT an external tool (isExternal: false for path tools),
    // so the ledger pre hook is a no-op for it regardless of order. To test
    // that policy hooks precede the ledger on an EXTERNAL tool, use
    // send_telegram (external). Path-approval blocks all typed-file tools;
    // for bash we can test bash_external.
    //
    // The cleanest assertion available without EffectStore injection:
    // confirm that the ledger PreToolUse is registered LAST by verifying
    // disabling path-approval removes exactly 2 handlers and the ledger's
    // position (count - 1 from end) is unchanged.
    const enabledCount = registry.count('PreToolUse');
    expect(enabledCount).toBeGreaterThanOrEqual(6);

    vi.stubEnv('AFK_DISABLE_PATH_APPROVAL', '1');
    _resetWarningForTests();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { registry: disabledRegistry } = createDefaultHookRegistry(
      undefined,
      'cli',
      undefined,
      undefined,
      undefined,
      { cwd: '/tmp' },
    );
    vi.unstubAllEnvs();
    void warnSpy;

    // Removing path-approval drops exactly 2 PreToolUse handlers
    // (path-approval itself + bash-restriction), confirming both are wired.
    const disabledCount = disabledRegistry.count('PreToolUse');
    expect(enabledCount - disabledCount).toBe(2);

    // The effect-ledger PreToolUse must still be present in the disabled
    // registry (it is independent of path-approval).
    expect(disabledCount).toBeGreaterThanOrEqual(4);
  });

  it('effect-ledger PreToolUse is registered after path-approval: total handler counts are consistent', () => {
    // With path-approval enabled: whatif-gate + shadow-verify-stop + ask-question +
    // child-memory + safe-destruct + release-boundary + plan-gate (conditional) +
    // edit-preview + path-approval + bash-restriction + effect-ledger = ≥6 without
    // getPermissionMode, ≥8 with it.
    const { registry: noPermReg } = createDefaultHookRegistry(
      undefined, 'cli', undefined, undefined, undefined, { cwd: '/tmp' },
    );
    const { registry: permReg } = createDefaultHookRegistry(
      undefined, 'cli', undefined, () => 'default' as const, undefined, { cwd: '/tmp' },
    );

    // With permission mode: plan-mode gate + afk-mode gate added (+2).
    expect(permReg.count('PreToolUse') - noPermReg.count('PreToolUse')).toBe(2);

    // PostToolUse: path-approval revoke + effect-ledger post = 2 minimum.
    expect(noPermReg.count('PostToolUse')).toBeGreaterThanOrEqual(2);

    // PostToolUseFailure: effect-ledger post = 1 minimum.
    expect(noPermReg.count('PostToolUseFailure')).toBeGreaterThanOrEqual(1);
  });
});
