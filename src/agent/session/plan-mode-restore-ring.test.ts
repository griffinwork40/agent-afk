/**
 * Fix A — the Shift+Tab permission ring (`default → plan → bypassPermissions`)
 * must restore the user's real WORKING mode on plan exit, not the transient
 * `default` the ring passes through.
 *
 * Because `plan`'s only ring-predecessor is `default`, cycling from bypass INTO
 * plan is necessarily `bypass → default → plan`. `AgentSession.setPermissionMode`
 * stashes the mode left on the `→ default` hop and, on the very next
 * `default → plan`, restores it as the pre-plan mode — so an approved exit lands
 * back in bypass. The stash is turn-scoped (cleared at each turn boundary) so a
 * GENUINE rest in default (a submitted turn) does NOT escalate back to bypass.
 *
 * These tests exercise `setPermissionMode` capture + `getPrePlanMode()` (the value
 * both `/plan off` and the `exit_plan_mode` picker restore) directly on a real
 * `AgentSession` backed by the mock provider.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { AgentSession } from '../session.js';
import type { AgentConfig } from '../types.js';
import { createMockProvider } from '../__fixtures__/mock-provider.js';

function makeSession(): AgentSession {
  const config: AgentConfig = {
    model: 'sonnet',
    apiKey: 'test-key',
    provider: createMockProvider(),
  };
  return new AgentSession(config);
}

let active: AgentSession | undefined;
afterEach(async () => {
  await active?.close();
  active = undefined;
});

describe('plan-mode pre-plan restore across the Shift+Tab ring', () => {
  it('bypass → default → plan (ring gesture) restores bypass, not the transient default', async () => {
    const s = (active = makeSession());
    await s.waitForInitialization();
    await s.setPermissionMode('bypassPermissions');
    await s.setPermissionMode('default'); // transient ring hop
    await s.setPermissionMode('plan');
    expect(s.getPrePlanMode()).toBe('bypassPermissions');
  });

  it('genuine default rest (turn submitted in default) → plan restores default', async () => {
    // NB: the mock provider's session.init reports 'bypassPermissions', so the
    // session starts in bypass; a submitted turn in default is what makes it a
    // genuine rest (and clears any transient ring stash).
    const s = (active = makeSession());
    await s.waitForInitialization();
    await s.setPermissionMode('default');
    await s.sendMessage('working in default');
    await s.setPermissionMode('plan');
    expect(s.getPrePlanMode()).toBe('default');
  });

  it('bypass → plan directly (/plan on from bypass) restores bypass', async () => {
    const s = (active = makeSession());
    await s.waitForInitialization();
    await s.setPermissionMode('bypassPermissions');
    await s.setPermissionMode('plan');
    expect(s.getPrePlanMode()).toBe('bypassPermissions');
  });

  it('landing on a concrete mode clears the stash (last privileged-before-default wins)', async () => {
    const s = (active = makeSession());
    await s.waitForInitialization();
    await s.setPermissionMode('bypassPermissions');
    await s.setPermissionMode('default'); // stash bypass
    await s.setPermissionMode('acceptEdits'); // concrete mode → clears stash
    await s.setPermissionMode('default'); // stash acceptEdits
    await s.setPermissionMode('plan');
    expect(s.getPrePlanMode()).toBe('acceptEdits');
  });

  it('SAFETY: a submitted turn in default clears the stash → plan restores default, never escalates to bypass', async () => {
    const s = (active = makeSession());
    await s.waitForInitialization();
    await s.setPermissionMode('bypassPermissions');
    await s.setPermissionMode('default'); // stash bypass
    await s.sendMessage('do some work in default'); // genuine rest → clears stash
    await s.setPermissionMode('plan');
    expect(s.getPrePlanMode()).toBe('default');
  });
});
