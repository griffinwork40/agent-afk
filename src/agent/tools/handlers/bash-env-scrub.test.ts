/**
 * Tests for scrubBashEnv — ensures episode-revealing vars are stripped from
 * the env handed to bash child processes (issue #2425).
 */

import { describe, it, expect, vi } from 'vitest';
import { scrubBashEnv } from './bash-env-scrub.js';

describe('scrubBashEnv', () => {
  it('strips AFK_WHATIF_EPISODE from an explicit env object', () => {
    const result = scrubBashEnv({
      PATH: '/usr/bin',
      AFK_WHATIF_EPISODE: '1',
      HOME: '/home/user',
    });
    expect(result['AFK_WHATIF_EPISODE']).toBeUndefined();
    expect(result['PATH']).toBe('/usr/bin');
    expect(result['HOME']).toBe('/home/user');
  });

  it('strips AFK_WHATIF_EPISODE when inheriting from process.env', () => {
    vi.stubEnv('AFK_WHATIF_EPISODE', '1');
    const result = scrubBashEnv(undefined);
    expect(result['AFK_WHATIF_EPISODE']).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('leaves other vars intact when undefined env is passed', () => {
    vi.stubEnv('MY_CUSTOM_VAR', 'keep-me');
    const result = scrubBashEnv(undefined);
    expect(result['MY_CUSTOM_VAR']).toBe('keep-me');
    vi.unstubAllEnvs();
  });

  it('is safe when AFK_WHATIF_EPISODE is not present', () => {
    const result = scrubBashEnv({ PATH: '/usr/bin' });
    expect(result['PATH']).toBe('/usr/bin');
    expect(result['AFK_WHATIF_EPISODE']).toBeUndefined();
  });
});
