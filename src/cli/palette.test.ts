/**
 * Tests for src/cli/palette.ts
 *
 * Verifies the palette exports all required semantic names and that each
 * role is a callable chalk function returning a string.
 */

import { describe, it, expect } from 'vitest';
import { palette } from './palette.js';

const REQUIRED_ROLES = [
  'brand', 'user', 'tool', 'toolArg',
  'success', 'error', 'warning', 'plan', 'meta', 'info', 'dim', 'bold',
] as const;

describe('palette', () => {
  it('exports all required semantic roles', () => {
    for (const role of REQUIRED_ROLES) {
      expect(palette).toHaveProperty(role);
      expect(typeof (palette as unknown as Record<string, unknown>)[role]).toBe('function');
    }
  });

  it('each role produces a string when called', () => {
    for (const role of REQUIRED_ROLES) {
      const fn = (palette as unknown as Record<string, (s: string) => string>)[role]!;
      const out = fn('hello');
      expect(typeof out).toBe('string');
      expect(out).toContain('hello');
    }
  });
});
