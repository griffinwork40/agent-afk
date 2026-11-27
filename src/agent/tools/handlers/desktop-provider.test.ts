import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBackend } from '../../../desktop/types.js';
import { resolveNativeBackend } from '../../../desktop/platform.js';
import { desktopSchemas, desktopToolNames, isDesktopEnabled } from '../desktop-surface.js';
import { acquireDesktopBackend, DESKTOP_SETUP_INSTRUCTIONS } from './desktop-provider.js';

vi.mock('../../../desktop/platform.js', () => ({ resolveNativeBackend: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe('desktop opt-in gate parity', () => {
  it.each([
    [undefined, false], ['', false], ['0', false], ['false', false],
    [' OFF ', false], ['garbage', false],
    ['1', true], ['true', true], ['yes', true], ['on', true],
    [' TrUe ', true], [' YeS ', true], [' ON ', true], [' 1 ', true],
  ])('agrees across schemas, names, and native acquisition for %j', async (raw, enabled) => {
    vi.stubEnv('AFK_DESKTOP_ENABLED', raw);
    vi.stubEnv('AFK_SESSION_ID', 'desktop-gate-test');
    const backend = {} as DesktopBackend;
    vi.mocked(resolveNativeBackend).mockResolvedValue(backend);

    expect(isDesktopEnabled()).toBe(enabled);
    const names = enabled ? ['desktop_screenshot'] : [];
    expect(desktopToolNames()).toEqual(names);
    expect(desktopSchemas().map((schema) => schema.name)).toEqual(names);

    // No getBackend injection: exercise the production capability gate.
    const result = await acquireDesktopBackend('desktop_screenshot', {});
    if (enabled) {
      expect(result).toEqual({ ok: true, sessionId: 'desktop-gate-test', backend });
      expect(resolveNativeBackend).toHaveBeenCalledOnce();
    } else {
      expect(result).toEqual({ ok: false, isError: true, content: DESKTOP_SETUP_INSTRUCTIONS });
      expect(resolveNativeBackend).not.toHaveBeenCalled();
    }
  });

  it('reads the gate live rather than caching the first value', () => {
    vi.stubEnv('AFK_DESKTOP_ENABLED', '1');
    expect(desktopToolNames()).toEqual(['desktop_screenshot']);
    vi.stubEnv('AFK_DESKTOP_ENABLED', 'off');
    expect(desktopToolNames()).toEqual([]);
    expect(desktopSchemas()).toEqual([]);
  });
});
