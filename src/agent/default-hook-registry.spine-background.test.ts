/**
 * Wiring pin: the SPINE SessionEnd hook (a model call, measured 1-5s) is
 * registered on the background lane, so a `reset` SessionEnd dispatch
 * (`/clear`) does not wait for it.
 */
import { describe, expect, it, vi } from 'vitest';

let releaseSpine!: () => void;
let spineFinished = false;
vi.mock('./spine/index.js', () => ({
  createSpineSessionEndHook: () => async () => {
    await new Promise<void>((r) => { releaseSpine = r; });
    spineFinished = true;
    return {};
  },
}));

const { createDefaultHookRegistry } = await import('./default-hook-registry.js');

describe('createDefaultHookRegistry — SPINE hook runs on the background lane', () => {
  it('a reset SessionEnd dispatch resolves while the spine hook is still running', async () => {
    const { registry } = createDefaultHookRegistry(undefined, 'cli');
    await registry.dispatch({ event: 'SessionEnd', sessionId: 'spine-bg', reason: 'reset' });
    expect(spineFinished).toBe(false);
    releaseSpine();
    await registry.drainBackground!();
    expect(spineFinished).toBe(true);
  });
});
