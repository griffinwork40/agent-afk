/**
 * Tests for the `exit_plan_mode` tool: the elicitation picker → mode-flip +
 * seed-bridge behavior, plus the `AgentSession` half (controls injection and
 * the single-shot seed drain).
 *
 * The load-bearing guarantee (per the plan): an APPROVED exit seeds the SAME
 * implement-turn `/plan off` produces — proven here by asserting equality with
 * `buildPlanExitPrompt`, the single source of truth both paths share.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createExitPlanModeHandler } from './exit-plan-mode.js';
import { elicitationRouter } from '../../elicitation-router.js';
import { buildPlanExitPrompt } from '../../plan-mode-exit-prompt.js';
import { getProjectPlansDir } from '../../../paths.js';
import { AgentSession } from '../../session/agent-session.js';
import { createMockProvider } from '../../__fixtures__/mock-provider.js';
import type { PlanExitControls } from '../../types/config-types.js';
import type { ModelProvider, ProviderQueryArgs, ProviderQuery } from '../../provider.js';
import type { PermissionMode } from '../../types/sdk-types.js';

const CWD = '/work/proj';

/** Install an elicitation handler that picks `request.choices[idx]` (as the REPL
 *  picker would), or `null` to leave none installed (route → decline). */
function installPicker(idx: number | null): void {
  if (idx === null) {
    elicitationRouter.uninstall();
    return;
  }
  elicitationRouter.install(async (request) => ({
    action: 'accept',
    content: { value: request.choices?.[idx] },
  }));
}

function makeControls(prePlanMode?: PermissionMode): {
  controls: PlanExitControls;
  modeCalls: PermissionMode[];
  seeds: Array<{ message: string; mode: PermissionMode }>;
} {
  const modeCalls: PermissionMode[] = [];
  const seeds: Array<{ message: string; mode: PermissionMode }> = [];
  return {
    modeCalls,
    seeds,
    controls: {
      setPermissionMode: async (mode) => {
        modeCalls.push(mode);
      },
      requestImplementSeed: (message, mode) => {
        seeds.push({ message, mode });
      },
      // Pre-plan mode the handler restores. Undefined → handler falls back to
      // 'default', which is what the original tests below assert.
      getPrePlanMode: () => prePlanMode,
    },
  };
}

afterEach(() => {
  elicitationRouter.uninstall();
});

describe('exit_plan_mode handler', () => {
  it('approve→default: defers mode to seed (no mid-turn flip) and seeds the same prompt as /plan off', async () => {
    installPicker(0); // first choice = approve/default
    const { controls, modeCalls, seeds } = makeControls();
    const handler = createExitPlanModeHandler(controls);

    const res = await handler({}, new AbortController().signal, { resolveBase: CWD });

    // Handler must NOT call setPermissionMode — flip is deferred to drain time.
    expect(modeCalls).toEqual([]);
    // Seed carries both the message and the approved mode.
    expect(seeds).toEqual([{ message: buildPlanExitPrompt(getProjectPlansDir(CWD)), mode: 'default' }]);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('mode=default');
  });

  it('approve→bypass: defers mode to seed (no mid-turn flip) and seeds the same prompt', async () => {
    installPicker(1); // second choice = approve/bypass
    const { controls, modeCalls, seeds } = makeControls();
    const handler = createExitPlanModeHandler(controls);

    const res = await handler({}, new AbortController().signal, { resolveBase: CWD });

    // Handler must NOT call setPermissionMode — flip is deferred to drain time.
    expect(modeCalls).toEqual([]);
    // Seed carries both the message and the approved mode.
    expect(seeds).toEqual([{ message: buildPlanExitPrompt(getProjectPlansDir(CWD)), mode: 'bypassPermissions' }]);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('mode=bypassPermissions');
  });

  it('keep planning: no mode flip, no seed, stays in plan', async () => {
    installPicker(2); // third choice = keep planning
    const { controls, modeCalls, seeds } = makeControls();
    const handler = createExitPlanModeHandler(controls);

    const res = await handler({}, new AbortController().signal, { resolveBase: CWD });

    expect(modeCalls).toEqual([]);
    expect(seeds).toEqual([]);
    expect(res.isError).toBeFalsy();
    expect(res.content.toLowerCase()).toContain('keep planning');
  });

  it('declined (no elicitation handler): no flip, no seed, stays in plan', async () => {
    installPicker(null); // none installed → route auto-declines
    const { controls, modeCalls, seeds } = makeControls();
    const handler = createExitPlanModeHandler(controls);

    const res = await handler({}, new AbortController().signal, { resolveBase: CWD });

    expect(modeCalls).toEqual([]);
    expect(seeds).toEqual([]);
    expect(res.content.toLowerCase()).toContain('not confirmed');
  });

  it('falls back to process.cwd() when no context resolveBase/cwd is supplied', async () => {
    installPicker(0);
    const { controls, seeds } = makeControls();
    const handler = createExitPlanModeHandler(controls);

    await handler({}, new AbortController().signal, undefined);

    expect(seeds).toEqual([{ message: buildPlanExitPrompt(getProjectPlansDir(process.cwd())), mode: 'default' }]);
  });

  it('approve→restore: the primary choice restores the captured pre-plan mode (acceptEdits)', async () => {
    // Capture the offered choices so we can assert the picker shape too.
    let offered: string[] | undefined;
    elicitationRouter.install(async (request) => {
      offered = request.choices;
      return { action: 'accept', content: { value: request.choices?.[0] } };
    });
    const { controls, seeds } = makeControls('acceptEdits');
    const handler = createExitPlanModeHandler(controls);

    const res = await handler({}, new AbortController().signal, { resolveBase: CWD });

    // Non-bypass pre-plan mode → three choices: restore, bypass-escalation, keep.
    expect(offered).toHaveLength(3);
    expect(offered?.[0]).toContain('restore');
    // Primary approve restores the captured mode, not 'default'.
    expect(seeds).toEqual([{ message: buildPlanExitPrompt(getProjectPlansDir(CWD)), mode: 'acceptEdits' }]);
    expect(res.content).toContain('mode=acceptEdits');
  });

  it('approve→escalate: the explicit bypass choice still escalates even when pre-plan mode was acceptEdits', async () => {
    installPicker(1); // index 1 = the bypass escalation row
    const { controls, seeds } = makeControls('acceptEdits');
    const handler = createExitPlanModeHandler(controls);

    const res = await handler({}, new AbortController().signal, { resolveBase: CWD });

    expect(seeds).toEqual([{ message: buildPlanExitPrompt(getProjectPlansDir(CWD)), mode: 'bypassPermissions' }]);
    expect(res.content).toContain('mode=bypassPermissions');
  });

  it('pre-plan mode bypass: picker dedupes (no separate bypass row) and approve restores bypass', async () => {
    let offered: string[] | undefined;
    elicitationRouter.install(async (request) => {
      offered = request.choices;
      return { action: 'accept', content: { value: request.choices?.[0] } };
    });
    const { controls, seeds } = makeControls('bypassPermissions');
    const handler = createExitPlanModeHandler(controls);

    const res = await handler({}, new AbortController().signal, { resolveBase: CWD });

    // Restore IS bypass → only two choices (restore-bypass, keep); no duplicate.
    expect(offered).toHaveLength(2);
    expect(seeds).toEqual([{ message: buildPlanExitPrompt(getProjectPlansDir(CWD)), mode: 'bypassPermissions' }]);
    expect(res.content).toContain('mode=bypassPermissions');
  });

  it('pre-plan mode bypass: the second choice is "keep planning" (not a flip)', async () => {
    installPicker(1); // index 1 with a 2-choice picker = keep planning
    const { controls, modeCalls, seeds } = makeControls('bypassPermissions');
    const handler = createExitPlanModeHandler(controls);

    const res = await handler({}, new AbortController().signal, { resolveBase: CWD });

    expect(modeCalls).toEqual([]);
    expect(seeds).toEqual([]);
    expect(res.content.toLowerCase()).toContain('keep planning');
  });
});

describe('AgentSession plan-exit seed bridge', () => {
  /** Wrap a mock provider to capture the AgentConfig the session passes down. */
  function capturingProvider(): { provider: ModelProvider; getControls: () => PlanExitControls | undefined } {
    const base = createMockProvider();
    let captured: PlanExitControls | undefined;
    const provider: ModelProvider = {
      name: 'capture',
      query: (args: ProviderQueryArgs): ProviderQuery => {
        captured = args.config.planExitControls;
        return base.query(args);
      },
    };
    return { provider, getControls: () => captured };
  }

  it('top-level session: injects controls wired to a single-shot seed slot; drain applies the deferred mode flip', async () => {
    const { provider, getControls } = capturingProvider();
    const session = new AgentSession({ model: 'sonnet', apiKey: 'test-key', provider });
    await session.waitForInitialization();

    expect(await session.takePendingPlanExitSeed()).toBeUndefined();

    const controls = getControls();
    expect(controls).toBeDefined();
    // Pass the approved mode alongside the seed message (new signature).
    controls!.requestImplementSeed('SEED-MSG', 'default');

    // takePendingPlanExitSeed applies the mode flip then returns BOTH the seed
    // message AND the flipped-to mode (#495) — the caller mirrors `mode` onto
    // stats.permissionMode so the gate + prompt unlock.
    expect(await session.takePendingPlanExitSeed()).toEqual({ message: 'SEED-MSG', mode: 'default' });
    // Single-shot: drained value is cleared.
    expect(await session.takePendingPlanExitSeed()).toBeUndefined();

    await session.close();
  });

  it('drain drops the seed (returns undefined) when the deferred mode flip rejects', async () => {
    // Decorate the mock query so setPermissionMode rejects — the same failure
    // mode togglePlanMode guards for `/plan off`. The drain must swallow it,
    // drop the seed, and stay in plan mode rather than throwing into the REPL
    // loop or auto-submitting an implement-turn while still gate-locked.
    const base = createMockProvider();
    let captured: PlanExitControls | undefined;
    const provider: ModelProvider = {
      name: 'reject-flip',
      query: (args: ProviderQueryArgs): ProviderQuery => {
        captured = args.config.planExitControls;
        const q = base.query(args);
        return {
          ...q,
          setPermissionMode: async () => {
            throw new Error('query handle closing');
          },
        };
      },
    };
    const session = new AgentSession({ model: 'sonnet', apiKey: 'test-key', provider });
    await session.waitForInitialization();

    captured!.requestImplementSeed('SEED-MSG', 'bypassPermissions');

    // Flip rejects → seed dropped, no throw, undefined returned.
    await expect(session.takePendingPlanExitSeed()).resolves.toBeUndefined();
    // Single-shot: the dropped seed is cleared (a retry still returns undefined).
    await expect(session.takePendingPlanExitSeed()).resolves.toBeUndefined();

    await session.close();
  });

  it('captures the pre-plan mode on entering plan, exposed via getPrePlanMode + controls', async () => {
    const { provider, getControls } = capturingProvider();
    const session = new AgentSession({ model: 'sonnet', apiKey: 'test-key', provider });
    await session.waitForInitialization();

    // No plan entered yet → nothing captured.
    expect(session.getPrePlanMode()).toBeUndefined();

    // Enter plan FROM bypass → bypass is captured as the restore target, and the
    // injected control bridge surfaces the same value to the exit_plan_mode tool.
    await session.setPermissionMode('bypassPermissions');
    await session.setPermissionMode('plan');
    expect(session.getPrePlanMode()).toBe('bypassPermissions');
    expect(getControls()?.getPrePlanMode()).toBe('bypassPermissions');

    // A redundant plan→plan flip must NOT clobber the captured mode with 'plan'.
    await session.setPermissionMode('plan');
    expect(session.getPrePlanMode()).toBe('bypassPermissions');

    await session.close();
  });

  it('does not capture autonomous (AFK) as a restorable pre-plan mode → restore falls back', async () => {
    const { provider } = capturingProvider();
    const session = new AgentSession({ model: 'sonnet', apiKey: 'test-key', provider });
    await session.waitForInitialization();

    await session.setPermissionMode('autonomous');
    await session.setPermissionMode('plan');
    // 'autonomous' is reset to undefined (AFK is not restorable by a bare flip)
    // so an approved exit falls back to 'default'.
    expect(session.getPrePlanMode()).toBeUndefined();

    await session.close();
  });

  it('subagent session (parentSessionId set): does NOT receive plan-exit controls', async () => {
    const { provider, getControls } = capturingProvider();
    const session = new AgentSession({
      model: 'sonnet',
      apiKey: 'test-key',
      provider,
      parentSessionId: 'parent-1',
    });
    await session.waitForInitialization();

    expect(getControls()).toBeUndefined();

    await session.close();
  });
});
