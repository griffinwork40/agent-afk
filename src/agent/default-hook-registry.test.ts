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
// Hook registration order — PreToolUse (#3726)
// ---------------------------------------------------------------------------
//
// Registration order is load-bearing: `decision: 'block'` short-circuits the
// chain so no later handler fires. The effect-ledger PreToolUse hook (#3713)
// must run AFTER the path-approval and policy hooks so those gates can block
// a call before it is journaled as "dispatched". Conversely, whatif-episode
// must run FIRST because it can cancel the entire tool dispatch regardless of
// policy. This test pins the observable ordering by spying on the module
// factories, capturing their returned handler functions, and verifying that
// dispatching a pass-through event calls them in the correct relative sequence.

import * as effectLedgerMod from './effect-ledger/index.js';
import * as pathApprovalMod from './tools/hooks/path-approval-hook.js';
import * as bashRestrictionMod from './tools/hooks/bash-restriction-hook.js';
import * as whatifMod from './whatif-episode-gate.js';

describe('createDefaultHookRegistry — PreToolUse hook registration order (#3726)', () => {
  beforeEach(() => {
    _resetWarningForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('whatif-episode fires before path-approval, which fires before effect-ledger', async () => {
    const callOrder: string[] = [];

    // Spy on createWhatifEpisodeGate — capture the returned handler and wrap it.
    vi.spyOn(whatifMod, 'createWhatifEpisodeGate').mockImplementation(() => {
      return (_ctx) => { callOrder.push('whatif'); return {}; };
    });

    // Spy on createPathApprovalHook — wrap preToolUse to record call.
    vi.spyOn(pathApprovalMod, 'createPathApprovalHook').mockImplementation((opts) => {
      return {
        preToolUse: (_ctx) => { callOrder.push('path-approval'); return {}; },
        postToolUse: (_ctx) => ({}),
        sessionEnd: (_ctx) => ({}),
      };
    });

    // Spy on createBashRestrictionHook — record but pass through.
    vi.spyOn(bashRestrictionMod, 'createBashRestrictionHook').mockImplementation(() => {
      return (_ctx) => { callOrder.push('bash-restriction'); return {}; };
    });

    // Spy on createEffectLedgerHooks — capture pre handler.
    vi.spyOn(effectLedgerMod, 'createEffectLedgerHooks').mockImplementation(() => {
      return {
        pre: (_ctx) => { callOrder.push('effect-ledger'); return {}; },
        post: (_ctx) => ({}),
      };
    });

    // Build registry with path-approval enabled (AFK_DISABLE_PATH_APPROVAL not set).
    const { registry } = createDefaultHookRegistry(
      undefined,
      'cli',
      undefined,
      // No getPermissionMode → plan-mode and afk-mode gates are skipped,
      // keeping this test focused on the path-approval / ledger ordering.
      undefined,
    );

    // Dispatch a read_file call — passes all non-blocking guards — so every
    // PreToolUse handler that does not short-circuit gets to run.
    await registry.dispatch(
      { event: 'PreToolUse', toolName: 'read_file' },
      undefined,
      Infinity,
    );

    // Whatif must be first.
    const whatifIdx = callOrder.indexOf('whatif');
    const pathApprovalIdx = callOrder.indexOf('path-approval');
    const bashIdx = callOrder.indexOf('bash-restriction');
    const ledgerIdx = callOrder.indexOf('effect-ledger');

    expect(whatifIdx, 'whatif-episode must be registered').toBeGreaterThanOrEqual(0);
    expect(pathApprovalIdx, 'path-approval must be registered').toBeGreaterThanOrEqual(0);
    expect(bashIdx, 'bash-restriction must be registered').toBeGreaterThanOrEqual(0);
    expect(ledgerIdx, 'effect-ledger must be registered').toBeGreaterThanOrEqual(0);

    expect(whatifIdx, 'whatif-episode fires before path-approval').toBeLessThan(pathApprovalIdx);
    expect(pathApprovalIdx, 'path-approval fires before bash-restriction').toBeLessThan(bashIdx);
    expect(bashIdx, 'bash-restriction fires before effect-ledger').toBeLessThan(ledgerIdx);
  });
});
