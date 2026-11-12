/**
 * Integration tests: delegation profiles wired through nesting depth and budget config.
 *
 * These tests verify that AFK_DELEGATION_PROFILE env var correctly flows through
 * resolveMaxNestingDepth() and resolveDelegationBudgetConfig(). They live in
 * agent/tools/ (not config/) because they import from the agent/tools layer.
 *
 * @module agent/tools/delegation-profiles.integration.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveMaxNestingDepth } from './nesting.js';
import { resolveDelegationBudgetConfig } from './delegation-budget.js';

describe('AFK_DELEGATION_PROFILE env integration (resolveMaxNestingDepth)', () => {
  const PROFILE_KEY = 'AFK_DELEGATION_PROFILE';
  const DEPTH_KEY = 'AFK_MAX_NESTING_DEPTH';
  let savedProfile: string | undefined;
  let savedDepth: string | undefined;

  beforeEach(() => {
    savedProfile = process.env[PROFILE_KEY];
    savedDepth = process.env[DEPTH_KEY];
    delete process.env[PROFILE_KEY];
    delete process.env[DEPTH_KEY];
  });

  afterEach(() => {
    if (savedProfile === undefined) { delete process.env[PROFILE_KEY]; }
    else { process.env[PROFILE_KEY] = savedProfile; }
    if (savedDepth === undefined) { delete process.env[DEPTH_KEY]; }
    else { process.env[DEPTH_KEY] = savedDepth; }
  });

  it('profile=deep sets depth to 5', async () => {
    process.env[PROFILE_KEY] = 'deep';
    expect(resolveMaxNestingDepth()).toBe(5);
  });

  it('profile=shallow sets depth to 2', async () => {
    process.env[PROFILE_KEY] = 'shallow';
    expect(resolveMaxNestingDepth()).toBe(2);
  });

  it('explicit AFK_MAX_NESTING_DEPTH overrides profile', async () => {
    process.env[PROFILE_KEY] = 'deep'; // profile says 5
    process.env[DEPTH_KEY] = '1';       // explicit override
    expect(resolveMaxNestingDepth()).toBe(1);
  });

  it('unknown profile falls back to default depth 3', async () => {
    process.env[PROFILE_KEY] = 'turbo';
    expect(resolveMaxNestingDepth()).toBe(3);
  });

  it('unparseable AFK_MAX_NESTING_DEPTH returns default even when a profile is active (F1 regression)', async () => {
    // Invariant: individual env vars always override profile values.
    // An unparseable depth var must return the default immediately, not fall
    // through to the profile (which would return profile depth instead of 3).
    process.env[PROFILE_KEY] = 'deep'; // profile would give 5 if it wins
    process.env[DEPTH_KEY] = 'not-a-number'; // unparseable — must not fall through
    expect(resolveMaxNestingDepth()).toBe(3); // default, not profile depth 5
  });
});

// ─── Integration: budget config with profile ─────────────────────────────────

describe('AFK_DELEGATION_PROFILE env integration (resolveDelegationBudgetConfig)', () => {
  const PROFILE_KEY = 'AFK_DELEGATION_PROFILE';
  const CHILDREN_KEY = 'AFK_MAX_CONCURRENT_CHILDREN_PER_AGENT';
  const CONCURRENT_KEY = 'AFK_MAX_CONCURRENT_AGENTS';
  const TOTAL_KEY = 'AFK_MAX_TOTAL_AGENTS';
  const ALL_KEYS = [PROFILE_KEY, CHILDREN_KEY, CONCURRENT_KEY, TOTAL_KEY] as const;
  const saved: Partial<Record<string, string>> = {};

  beforeEach(() => {
    for (const k of ALL_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ALL_KEYS) {
      if (saved[k] === undefined) { delete process.env[k]; }
      else { process.env[k] = saved[k]; }
    }
  });

  it('profile=normal returns undefined (no budget limits)', async () => {
    process.env[PROFILE_KEY] = 'normal';
    expect(resolveDelegationBudgetConfig()).toBeUndefined();
  });

  it('profile=deep returns the deep budget values', async () => {
    process.env[PROFILE_KEY] = 'deep';
    const cfg = resolveDelegationBudgetConfig();
    expect(cfg).not.toBeUndefined();
    expect(cfg?.maxConcurrentChildrenPerAgent).toBe(4);
    expect(cfg?.maxConcurrentAgents).toBe(16);
    expect(cfg?.maxTotalAgents).toBe(48);
  });

  it('profile=shallow returns the shallow budget values', async () => {
    process.env[PROFILE_KEY] = 'shallow';
    const cfg = resolveDelegationBudgetConfig();
    expect(cfg).not.toBeUndefined();
    expect(cfg?.maxConcurrentChildrenPerAgent).toBe(2);
    expect(cfg?.maxConcurrentAgents).toBe(8);
    expect(cfg?.maxTotalAgents).toBe(16);
  });

  it('individual env var overrides the profile value', async () => {
    process.env[PROFILE_KEY] = 'deep';    // profile: maxConcurrentAgents=16
    process.env[CONCURRENT_KEY] = '5';    // explicit override
    const cfg = resolveDelegationBudgetConfig();
    expect(cfg?.maxConcurrentAgents).toBe(5);    // individual var wins
    expect(cfg?.maxConcurrentChildrenPerAgent).toBe(4); // profile fills in the rest
    expect(cfg?.maxTotalAgents).toBe(48);
  });

  it('unknown profile returns undefined (no budget)', async () => {
    process.env[PROFILE_KEY] = 'turbo';
    expect(resolveDelegationBudgetConfig()).toBeUndefined();
  });
});
