/**
 * Unit tests for the delegation-profiles module.
 *
 * @module config/delegation-profiles.test
 */

import { describe, it, expect } from 'vitest';
import {
  resolveDelegationProfile,
  DELEGATION_PROFILES,
} from './delegation-profiles.js';

describe('resolveDelegationProfile', () => {
  it('returns undefined when raw is undefined', () => {
    expect(resolveDelegationProfile(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(resolveDelegationProfile('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only string', () => {
    expect(resolveDelegationProfile('   ')).toBeUndefined();
  });

  it('returns undefined for unknown profile name', () => {
    expect(resolveDelegationProfile('unknown')).toBeUndefined();
    expect(resolveDelegationProfile('turbo')).toBeUndefined();
  });

  it('resolves "normal" profile', () => {
    const profile = resolveDelegationProfile('normal');
    expect(profile).not.toBeUndefined();
    expect(profile?.maxNestingDepth).toBe(3);
    expect(profile?.maxConcurrentChildrenPerAgent).toBeUndefined();
    expect(profile?.maxConcurrentAgents).toBeUndefined();
    expect(profile?.maxTotalAgents).toBeUndefined();
  });

  it('resolves "deep" profile', () => {
    const profile = resolveDelegationProfile('deep');
    expect(profile).not.toBeUndefined();
    expect(profile?.maxNestingDepth).toBe(5);
    expect(profile?.maxConcurrentChildrenPerAgent).toBe(4);
    expect(profile?.maxConcurrentAgents).toBe(16);
    expect(profile?.maxTotalAgents).toBe(48);
  });

  it('resolves "shallow" profile', () => {
    const profile = resolveDelegationProfile('shallow');
    expect(profile).not.toBeUndefined();
    expect(profile?.maxNestingDepth).toBe(2);
    expect(profile?.maxConcurrentChildrenPerAgent).toBe(2);
    expect(profile?.maxConcurrentAgents).toBe(8);
    expect(profile?.maxTotalAgents).toBe(16);
  });

  it('is case-insensitive (DEEP resolves same as deep)', () => {
    const lower = resolveDelegationProfile('deep');
    const upper = resolveDelegationProfile('DEEP');
    const mixed = resolveDelegationProfile('Deep');
    expect(upper).toEqual(lower);
    expect(mixed).toEqual(lower);
  });

  it('trims leading/trailing whitespace', () => {
    const profile = resolveDelegationProfile('  deep  ');
    expect(profile).toEqual(DELEGATION_PROFILES['deep']);
  });
});

// ─── Profile value invariants ────────────────────────────────────────────────

describe('DELEGATION_PROFILES invariants', () => {
  it('normal has no budget limits (all undefined)', () => {
    const p = DELEGATION_PROFILES['normal']!;
    expect(p.maxConcurrentChildrenPerAgent).toBeUndefined();
    expect(p.maxConcurrentAgents).toBeUndefined();
    expect(p.maxTotalAgents).toBeUndefined();
  });

  it('deep depth is within the accepted ceiling (0–6)', () => {
    expect(DELEGATION_PROFILES['deep']!.maxNestingDepth).toBeGreaterThanOrEqual(0);
    expect(DELEGATION_PROFILES['deep']!.maxNestingDepth).toBeLessThanOrEqual(6);
  });

  it('shallow depth is within the accepted ceiling (0–6)', () => {
    expect(DELEGATION_PROFILES['shallow']!.maxNestingDepth).toBeGreaterThanOrEqual(0);
    expect(DELEGATION_PROFILES['shallow']!.maxNestingDepth).toBeLessThanOrEqual(6);
  });

  it('deep has more budget than shallow', () => {
    const deep = DELEGATION_PROFILES['deep']!;
    const shallow = DELEGATION_PROFILES['shallow']!;
    expect(deep.maxNestingDepth).toBeGreaterThan(shallow.maxNestingDepth);
    expect((deep.maxConcurrentAgents ?? 0)).toBeGreaterThan(shallow.maxConcurrentAgents ?? 0);
    expect((deep.maxTotalAgents ?? 0)).toBeGreaterThan(shallow.maxTotalAgents ?? 0);
  });
});


