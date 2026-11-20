/**
 * Tests for desktop/platform.ts — platform detection and backend resolution.
 *
 * All tests mock child-process spawning. No real screenshot is taken.
 *
 * @module desktop/platform.test
 */

import { describe, it, expect, vi } from 'vitest';
import { isWsl2 } from './platform.js';

describe('isWsl2()', () => {
  it('returns false when neither WSL env var is set', () => {
    vi.stubEnv('WSL_DISTRO_NAME', undefined as unknown as string);
    vi.stubEnv('WSL_INTEROP', undefined as unknown as string);
    expect(isWsl2()).toBe(false);
    vi.unstubAllEnvs();
  });

  it('returns true when WSL_DISTRO_NAME is set', () => {
    vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu');
    vi.stubEnv('WSL_INTEROP', undefined as unknown as string);
    expect(isWsl2()).toBe(true);
    vi.unstubAllEnvs();
  });

  it('returns true when WSL_INTEROP is set', () => {
    vi.stubEnv('WSL_DISTRO_NAME', undefined as unknown as string);
    vi.stubEnv('WSL_INTEROP', '/run/WSL/1_interop');
    expect(isWsl2()).toBe(true);
    vi.unstubAllEnvs();
  });

  it('returns true when both WSL vars are set', () => {
    vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu');
    vi.stubEnv('WSL_INTEROP', '/run/WSL/1_interop');
    expect(isWsl2()).toBe(true);
    vi.unstubAllEnvs();
  });
});
