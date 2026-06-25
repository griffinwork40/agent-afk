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

function makeControls(): {
  controls: PlanExitControls;
  modeCalls: PermissionMode[];
  seeds: string[];
} {
  const modeCalls: PermissionMode[] = [];
  const seeds: string[] = [];
  return {
    modeCalls,
    seeds,
    controls: {
      setPermissionMode: async (mode) => {
        modeCalls.push(mode);
      },
      requestImplementSeed: (message) => {
        seeds.push(message);
      },
    },
  };
}

afterEach(() => {
  elicitationRouter.uninstall();
});

describe('exit_plan_mode handler', () => {
  it('approve→default: flips to default and seeds the same prompt as /plan off', async () => {
    installPicker(0); // first choice = approve/default
    const { controls, modeCalls, seeds } = makeControls();
    const handler = createExitPlanModeHandler(controls);

    const res = await handler({}, new AbortController().signal, { resolveBase: CWD });

    expect(modeCalls).toEqual(['default']);
    expect(seeds).toEqual([buildPlanExitPrompt(getProjectPlansDir(CWD))]);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('mode=default');
  });

  it('approve→bypass: flips to bypassPermissions and seeds the same prompt', async () => {
    installPicker(1); // second choice = approve/bypass
    const { controls, modeCalls, seeds } = makeControls();
    const handler = createExitPlanModeHandler(controls);

    const res = await handler({}, new AbortController().signal, { resolveBase: CWD });

    expect(modeCalls).toEqual(['bypassPermissions']);
    expect(seeds).toEqual([buildPlanExitPrompt(getProjectPlansDir(CWD))]);
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

    expect(seeds).toEqual([buildPlanExitPrompt(getProjectPlansDir(process.cwd()))]);
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

  it('top-level session: injects controls wired to a single-shot seed slot', async () => {
    const { provider, getControls } = capturingProvider();
    const session = new AgentSession({ model: 'sonnet', apiKey: 'test-key', provider });
    await session.waitForInitialization();

    expect(session.takePendingPlanExitSeed()).toBeUndefined();

    const controls = getControls();
    expect(controls).toBeDefined();
    controls!.requestImplementSeed('SEED-MSG');

    expect(session.takePendingPlanExitSeed()).toBe('SEED-MSG');
    // Single-shot: drained value is cleared.
    expect(session.takePendingPlanExitSeed()).toBeUndefined();

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
