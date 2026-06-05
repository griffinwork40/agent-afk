/**
 * Tests for the semver tag picker.
 */

import { describe, it, expect } from 'vitest';
import { pickLatestSemverTag } from './versions.js';

describe('pickLatestSemverTag', () => {
  it('returns null for an empty list', () => {
    expect(pickLatestSemverTag([])).toBeNull();
  });

  it('returns null when no tag is semver', () => {
    expect(pickLatestSemverTag(['stable', 'latest', 'banana'])).toBeNull();
  });

  it('picks the highest version with a v prefix', () => {
    expect(pickLatestSemverTag(['v1.0.0', 'v2.0.0', 'v1.5.0'])).toBe('v2.0.0');
  });

  it('picks the highest version without a v prefix', () => {
    expect(pickLatestSemverTag(['1.0.0', '2.0.0', '1.5.0'])).toBe('2.0.0');
  });

  it('mixes v and no-v prefixes — returns the matching input string', () => {
    expect(pickLatestSemverTag(['1.0.0', 'v2.0.0', '1.5.0'])).toBe('v2.0.0');
  });

  it('filters non-semver entries but considers the rest', () => {
    expect(pickLatestSemverTag(['latest', 'v0.9.0', 'banana', 'v1.0.0'])).toBe('v1.0.0');
  });

  it('ranks stable releases above their pre-releases', () => {
    expect(pickLatestSemverTag(['v1.0.0-rc.1', 'v1.0.0'])).toBe('v1.0.0');
  });

  it('orders pre-releases by semver precedence', () => {
    expect(pickLatestSemverTag(['v1.0.0-alpha', 'v1.0.0-beta', 'v1.0.0-rc.1'])).toBe('v1.0.0-rc.1');
  });

  it('numeric prerelease identifiers rank lower than alphanumeric', () => {
    expect(pickLatestSemverTag(['v1.0.0-1', 'v1.0.0-alpha'])).toBe('v1.0.0-alpha');
  });

  it('tolerates whitespace', () => {
    expect(pickLatestSemverTag(['  v1.0.0  ', 'v0.9.9'])).toBe('v1.0.0');
  });

  it('ignores build metadata', () => {
    // Build metadata is discarded per semver spec; the base version wins.
    expect(pickLatestSemverTag(['v1.0.0+build.1', 'v0.9.0'])).toBe('v1.0.0+build.1');
  });

  it('returns the first of equal versions', () => {
    expect(pickLatestSemverTag(['v1.0.0', '1.0.0'])).toBe('v1.0.0');
  });
});
