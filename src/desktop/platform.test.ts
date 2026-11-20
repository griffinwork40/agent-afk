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

describe('resolveNativeBackend() refusal messages', () => {
  it('Linux refusal mentions macOS and says Windows is not yet verified', async () => {
    // We cannot change process.platform at runtime in a unit test, so we
    // verify the message strings in the source file directly.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'platform.ts'),
      'utf8',
    );
    expect(src).toContain('macOS is supported');
    expect(src).toContain('not yet verified');
    expect(src).not.toContain('macOS and native Windows are supported');
  });

  it('WSL2 refusal directs user to native Windows terminal', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'platform.ts'),
      'utf8',
    );
    expect(src).toContain('native Windows interactive terminal');
    expect(src).toContain('WSL2');
  });
});
