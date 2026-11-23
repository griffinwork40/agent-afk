/**
 * Sync guard: VALID_PERMISSION_MODE_SET (Foundation) must have identical members
 * to VALID_PERMISSION_MODES (Core/sdk-types). Adding a mode to one but not the
 * other will fail this test.
 *
 * Foundation cannot import from Core/Infra (agent/), so the sets are duplicated
 * by necessity. This test is the only enforcement that keeps them in sync.
 */

import { describe, it, expect } from 'vitest';
import { VALID_PERMISSION_MODES } from '../agent/types/sdk-types.js';
import { VALID_PERMISSION_MODE_SET, CONFIG_PERMISSION_MODES } from './permission-mode.js';

describe('permission-mode sync guard', () => {
  it('VALID_PERMISSION_MODE_SET matches VALID_PERMISSION_MODES exactly', () => {
    const fromSdk = [...VALID_PERMISSION_MODES].sort();
    const fromUtils = [...VALID_PERMISSION_MODE_SET].sort();
    expect(fromUtils).toEqual(fromSdk);
  });

  it('CONFIG_PERMISSION_MODES is a strict subset of VALID_PERMISSION_MODE_SET', () => {
    for (const mode of CONFIG_PERMISSION_MODES) {
      expect(VALID_PERMISSION_MODE_SET.has(mode)).toBe(true);
    }
  });

  it('CONFIG_PERMISSION_MODES contains exactly plan and bypassPermissions', () => {
    expect([...CONFIG_PERMISSION_MODES].sort()).toEqual(['bypassPermissions', 'plan']);
  });
});
