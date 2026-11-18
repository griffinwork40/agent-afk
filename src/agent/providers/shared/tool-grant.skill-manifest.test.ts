/**
 * Unit tests for `skillManifestGranted` in tool-grant.ts.
 *
 * Four cases required by the brief:
 *  1. callback absent
 *  2. callback present and returns true
 *  3. callback present and returns false
 *  4. kill switch on with callback false
 */

import { describe, it, expect } from 'vitest';
import { skillManifestGranted } from './tool-grant.js';

describe('skillManifestGranted', () => {
  it('no executor => false regardless of callback or kill switch', () => {
    expect(skillManifestGranted(false, undefined, false)).toBe(false);
    expect(skillManifestGranted(false, () => true, false)).toBe(false);
    expect(skillManifestGranted(false, () => false, true)).toBe(false);
  });

  it('executor present, callback absent => true (preserve pre-gate behaviour)', () => {
    // An embedder that never wired permissions must keep receiving the manifest.
    expect(skillManifestGranted(true, undefined, false)).toBe(true);
  });

  it('executor present, callback explicitly grants skill => true', () => {
    expect(skillManifestGranted(true, () => true, false)).toBe(true);
  });

  it('executor present, callback explicitly denies skill => false', () => {
    expect(skillManifestGranted(true, () => false, false)).toBe(false);
  });

  it('kill switch on overrides an explicit denial => true', () => {
    expect(skillManifestGranted(true, () => false, true)).toBe(true);
  });

  it('kill switch on with absent callback => true', () => {
    expect(skillManifestGranted(true, undefined, true)).toBe(true);
  });

  it('callback only denies skill, grants other tools', () => {
    const grants = (toolName: string): boolean => toolName !== 'skill';
    expect(skillManifestGranted(true, grants, false)).toBe(false);
  });
});
