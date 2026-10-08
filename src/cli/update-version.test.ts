import { describe, it, expect } from 'vitest';
import { isNewerVersion } from './update-version.js';

describe('isNewerVersion', () => {
  // --- basic numeric ordering -------------------------------------------------

  it('returns true when latest has a higher patch', () => {
    expect(isNewerVersion('1.2.3', '1.2.4')).toBe(true);
  });

  it('returns true when latest has a higher minor', () => {
    expect(isNewerVersion('1.2.3', '1.3.0')).toBe(true);
  });

  it('returns true when latest has a higher major', () => {
    expect(isNewerVersion('1.2.3', '2.0.0')).toBe(true);
  });

  it('returns false when versions are identical', () => {
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false);
  });

  it('returns false when current is newer than latest (downgrade)', () => {
    expect(isNewerVersion('1.3.0', '1.2.9')).toBe(false);
  });

  // --- prerelease suffix on current -------------------------------------------
  // These are the cases that the naive split('.').map(Number) approach gets
  // wrong: Number('3-beta.1') === NaN, so comparisons silently evaluate false.

  it('returns true when current is a prerelease and latest is the final release (same core)', () => {
    // 1.2.3-beta.1 should be offered 1.2.3 as an update.
    expect(isNewerVersion('1.2.3-beta.1', '1.2.3')).toBe(true);
  });

  it('returns true when current is an rc prerelease and latest is the final release', () => {
    expect(isNewerVersion('4.7.5-rc.2', '4.7.5')).toBe(true);
  });

  it('returns true when current is a prerelease and latest is a higher minor', () => {
    expect(isNewerVersion('1.10.1-rc.1', '1.11.0')).toBe(true);
  });

  it('returns true when current is a prerelease and latest is a higher major', () => {
    expect(isNewerVersion('2.0.0-beta.1', '3.0.0')).toBe(true);
  });

  // --- prerelease suffix on latest --------------------------------------------

  it('returns false when latest is a prerelease of the same core as current release', () => {
    // A running release should NOT be offered its own prerelease as an update.
    expect(isNewerVersion('1.2.3', '1.2.3-beta.5')).toBe(false);
  });

  it('returns false when both have the same core and latest is a prerelease', () => {
    expect(isNewerVersion('1.10.1', '1.10.1-beta.5')).toBe(false);
  });

  // --- prerelease on both sides -----------------------------------------------

  it('returns false when both are prereleases of the same core', () => {
    // Prerelease-to-prerelease ordering is intentionally undefined (returns false).
    expect(isNewerVersion('1.2.3-alpha.1', '1.2.3-beta.1')).toBe(false);
  });

  it('returns true when both are prereleases but latest has a higher core', () => {
    expect(isNewerVersion('1.2.3-alpha.1', '1.3.0-beta.1')).toBe(true);
  });

  // --- build-metadata (+ suffix) ---------------------------------------------
  // Build metadata MUST be ignored in precedence comparisons per semver §10.

  it('ignores build-metadata suffix on current', () => {
    expect(isNewerVersion('1.2.3+sha.abc', '1.2.4')).toBe(true);
  });

  it('ignores build-metadata suffix on latest', () => {
    expect(isNewerVersion('1.2.3', '1.2.3+sha.abc')).toBe(false);
  });

  it('ignores build-metadata on both sides with identical cores', () => {
    expect(isNewerVersion('1.2.3+build.1', '1.2.3+build.2')).toBe(false);
  });

  // --- large version numbers --------------------------------------------------

  it('handles large minor/patch versions correctly', () => {
    expect(isNewerVersion('5.259.1', '5.260.0')).toBe(true);
    expect(isNewerVersion('5.260.0', '5.259.1')).toBe(false);
  });
});
