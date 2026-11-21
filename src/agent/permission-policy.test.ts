import { describe, it, expect } from 'vitest';
import { pathContainmentBypassed } from './permission-policy.js';
import type { PermissionMode } from './types/sdk-types.js';

describe('pathContainmentBypassed', () => {
  it('returns true for bypassPermissions (explicit full power)', () => {
    expect(pathContainmentBypassed('bypassPermissions')).toBe(true);
  });

  it.each<PermissionMode>(['plan', 'acceptEdits', 'dontAsk', 'auto'])(
    'returns false for containment-preserving mode %s',
    (mode) => {
      expect(pathContainmentBypassed(mode)).toBe(false);
    },
  );

  it('returns false for undefined / unknown strings', () => {
    expect(pathContainmentBypassed(undefined)).toBe(false);
    expect(pathContainmentBypassed('nonsense')).toBe(false);
  });
});
