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

function makeConfig(overrides: Partial<LoadedHooksConfig> = {}): LoadedHooksConfig {
  return {
    hooks: {},
    userGlobalEnabled: true,
    allowProjectHooks: false,
    pluginHooksEnabled: false,
    pluginHookEnv: {},
    disabledPluginHooks: {},
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
    vi.spyOn(pathApprovalMod, 'createPathApprovalHook').mockImplementation((_opts) => {
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
