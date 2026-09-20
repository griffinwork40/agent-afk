/**
 * Unit tests for `DelegationBudget`, `resolveDelegationBudgetConfig`,
 * and `buildBudgetRefusalMessage`.
 *
 * @module agent/tools/delegation-budget.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DelegationBudget,
  resolveDelegationBudgetConfig,
  buildBudgetRefusalMessage,
} from './delegation-budget.js';
import type { BudgetCheckResult } from './delegation-budget.js';

// ─── DelegationBudget ────────────────────────────────────────────────────────

describe('DelegationBudget', () => {
  const PARENT_A = 'session-a';
  const PARENT_B = 'session-b';

  it('canSpawn returns allowed when no limits set', () => {
    const budget = new DelegationBudget({});
    const result = budget.canSpawn(PARENT_A);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('canSpawn allows spawn when under all limits', () => {
    const budget = new DelegationBudget({
      maxConcurrentChildrenPerAgent: 3,
      maxConcurrentAgents: 5,
      maxTotalAgents: 10,
    });
    const result = budget.canSpawn(PARENT_A);
    expect(result.allowed).toBe(true);
  });

  describe('maxConcurrentChildrenPerAgent', () => {
    it('refuses when concurrent children reach the limit', () => {
      const budget = new DelegationBudget({ maxConcurrentChildrenPerAgent: 2 });
      // Spawn 2 without releasing — both are running
      budget.recordSpawn(PARENT_A);
      budget.recordSpawn(PARENT_A);
      const result = budget.canSpawn(PARENT_A);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('max_concurrent_children_per_agent');
      expect(result.detail).toContain('2');
    });

    it('allows after children finish (concurrent cap, not lifetime)', () => {
      const budget = new DelegationBudget({ maxConcurrentChildrenPerAgent: 2 });
      const r1 = budget.recordSpawn(PARENT_A);
      const r2 = budget.recordSpawn(PARENT_A);
      expect(budget.canSpawn(PARENT_A).allowed).toBe(false);
      // Release both — slots freed
      r1.release();
      r2.release();
      expect(budget.canSpawn(PARENT_A).allowed).toBe(true);
    });

    it('supports multi-wave workflows (research then build)', () => {
      const budget = new DelegationBudget({ maxConcurrentChildrenPerAgent: 2 });
      // Wave 1: research
      const r1 = budget.recordSpawn(PARENT_A);
      const r2 = budget.recordSpawn(PARENT_A);
      expect(budget.canSpawn(PARENT_A).allowed).toBe(false);
      r1.release();
      r2.release();
      // Wave 2: build — should be allowed
      const r3 = budget.recordSpawn(PARENT_A);
      const r4 = budget.recordSpawn(PARENT_A);
      expect(budget.canSpawn(PARENT_A).allowed).toBe(false);
      r3.release();
      r4.release();
      // Wave 3: still works
      expect(budget.canSpawn(PARENT_A).allowed).toBe(true);
    });

    it('release one slot allows one more spawn', () => {
      const budget = new DelegationBudget({ maxConcurrentChildrenPerAgent: 2 });
      const r1 = budget.recordSpawn(PARENT_A);
      budget.recordSpawn(PARENT_A);
      expect(budget.canSpawn(PARENT_A).allowed).toBe(false);
      r1.release(); // free one slot
      expect(budget.canSpawn(PARENT_A).allowed).toBe(true);
    });

    it('only counts children for the specific parent', () => {
      const budget = new DelegationBudget({ maxConcurrentChildrenPerAgent: 1 });
      budget.recordSpawn(PARENT_A); // PARENT_A at limit (1 running)
      // PARENT_B hasn't spawned any yet
      const result = budget.canSpawn(PARENT_B);
      expect(result.allowed).toBe(true);
    });
  });

  describe('maxConcurrentAgents', () => {
    it('refuses when maxConcurrentAgents exceeded', () => {
      const budget = new DelegationBudget({ maxConcurrentAgents: 2 });
      // Spawn 2 without releasing
      budget.recordSpawn(PARENT_A);
      budget.recordSpawn(PARENT_A);
      const result = budget.canSpawn(PARENT_A);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('max_concurrent_agents');
      expect(result.detail).toContain('2');
    });

    it('allows after concurrent slots freed', () => {
      const budget = new DelegationBudget({ maxConcurrentAgents: 1 });
      const { release } = budget.recordSpawn(PARENT_A);
      expect(budget.canSpawn(PARENT_A).allowed).toBe(false);
      release();
      expect(budget.canSpawn(PARENT_A).allowed).toBe(true);
    });
  });

  describe('maxTotalAgents', () => {
    it('refuses when maxTotalAgents exceeded', () => {
      const budget = new DelegationBudget({ maxTotalAgents: 2 });
      // Spawn and release (total goes up, concurrent goes back down)
      budget.recordSpawn(PARENT_A).release();
      budget.recordSpawn(PARENT_A).release();
      const result = budget.canSpawn(PARENT_A);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('max_total_agents');
      expect(result.detail).toContain('2');
    });
  });

  describe('recordSpawn', () => {
    it('increments concurrent and total counters', () => {
      const budget = new DelegationBudget({ maxConcurrentAgents: 10, maxTotalAgents: 10 });
      budget.recordSpawn(PARENT_A);
      budget.recordSpawn(PARENT_A);
      const snap = budget.snapshot();
      expect(snap.concurrent).toBe(2);
      expect(snap.total).toBe(2);
    });

    it('increments per-parent child counter', () => {
      const budget = new DelegationBudget({ maxConcurrentChildrenPerAgent: 5 });
      budget.recordSpawn(PARENT_A);
      budget.recordSpawn(PARENT_A);
      budget.recordSpawn(PARENT_B);
      // PARENT_A has 2, PARENT_B has 1 — both under limit
      expect(budget.canSpawn(PARENT_A).allowed).toBe(true);
      expect(budget.canSpawn(PARENT_B).allowed).toBe(true);
    });

    it('rollback undoes all three counters', () => {
      const budget = new DelegationBudget({
        maxConcurrentChildrenPerAgent: 2,
        maxConcurrentAgents: 10,
        maxTotalAgents: 10,
      });
      const { rollback } = budget.recordSpawn(PARENT_A);
      expect(budget.snapshot().concurrent).toBe(1);
      expect(budget.snapshot().total).toBe(1);
      rollback();
      const snap = budget.snapshot();
      // All three counters must be restored to zero
      expect(snap.concurrent).toBe(0);
      expect(snap.total).toBe(0);
      // concurrentChildrenByAgent must also be reverted: after rollback, PARENT_A has 0
      // children again, so two more spawns are still under the limit of 2.
      budget.recordSpawn(PARENT_A);
      expect(budget.canSpawn(PARENT_A).allowed).toBe(true); // 1 running, limit 2
      budget.recordSpawn(PARENT_A);
      expect(budget.canSpawn(PARENT_A).allowed).toBe(false); // 2 running == limit 2
    });

    it('rollback is idempotent', () => {
      const budget = new DelegationBudget({});
      const { rollback } = budget.recordSpawn(PARENT_A);
      rollback();
      rollback(); // second call must not underflow
      expect(budget.snapshot().concurrent).toBe(0);
      expect(budget.snapshot().total).toBe(0);
    });
  });

  describe('release callback', () => {
    it('decrements concurrent and concurrentChildrenByAgent but not total', () => {
      const budget = new DelegationBudget({ maxConcurrentChildrenPerAgent: 5 });
      const { release } = budget.recordSpawn(PARENT_A);
      expect(budget.snapshot().concurrent).toBe(1);
      expect(budget.snapshot().total).toBe(1);
      release();
      const snap = budget.snapshot();
      expect(snap.concurrent).toBe(0);
      expect(snap.total).toBe(1); // total does not decrement on release
      // concurrentChildrenByAgent was decremented — can spawn again
      expect(budget.canSpawn(PARENT_A).allowed).toBe(true);
    });

    it('is idempotent (double-call safe)', () => {
      const budget = new DelegationBudget({ maxConcurrentAgents: 10 });
      const { release } = budget.recordSpawn(PARENT_A);
      release();
      release(); // second call must not underflow
      const snap = budget.snapshot();
      expect(snap.concurrent).toBe(0);
      // Calling release again must not throw or corrupt state
    });

    it('concurrent never goes below zero on double-release', () => {
      const budget = new DelegationBudget({});
      const { release } = budget.recordSpawn(PARENT_A);
      release();
      release();
      release(); // triple release
      expect(budget.snapshot().concurrent).toBe(0);
    });
  });

  describe('snapshot', () => {
    it('returns current state', () => {
      const cfg = { maxConcurrentAgents: 10, maxTotalAgents: 20 };
      const budget = new DelegationBudget(cfg);
      budget.recordSpawn(PARENT_A);
      const snap = budget.snapshot();
      expect(snap.concurrent).toBe(1);
      expect(snap.total).toBe(1);
      expect(snap.config.maxConcurrentAgents).toBe(10);
    });
  });
});

// ─── resolveDelegationBudgetConfig ───────────────────────────────────────────

describe('resolveDelegationBudgetConfig', () => {
  const ENV_KEYS = [
    'AFK_MAX_CONCURRENT_CHILDREN_PER_AGENT',
    'AFK_MAX_CONCURRENT_AGENTS',
    'AFK_MAX_TOTAL_AGENTS',
  ] as const;

  // Save and restore env around each test
  const saved: Partial<Record<string, string>> = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    vi.resetModules();
  });

  it('returns undefined when no env vars set', async () => {
    // Import fresh so the env module re-reads process.env
    const { resolveDelegationBudgetConfig: resolve } = await import('./delegation-budget.js');
    const result = resolve();
    // The module-level `env` object is frozen at import time, but
    // resolveDelegationBudgetConfig reads from it. If all three are undefined,
    // the function returns undefined.
    // Since the env object is imported at module load time, we test with the
    // currently-imported version which already has the env cleared.
    expect(result).toBeUndefined();
  });

  it('parses valid numbers from env', () => {
    // The env object uses lazy Object.defineProperty getters that re-read
    // process.env on every access, so setting process.env before calling
    // resolveDelegationBudgetConfig() works without vi.resetModules().
    process.env['AFK_MAX_CONCURRENT_CHILDREN_PER_AGENT'] = '5';
    process.env['AFK_MAX_CONCURRENT_AGENTS'] = '10';
    process.env['AFK_MAX_TOTAL_AGENTS'] = '50';
    const config = resolveDelegationBudgetConfig();
    expect(config).not.toBeUndefined();
    expect(config?.maxConcurrentChildrenPerAgent).toBe(5);
    expect(config?.maxConcurrentAgents).toBe(10);
    expect(config?.maxTotalAgents).toBe(50);
  });

  it('clamps to ceilings (value above ceiling is clamped)', () => {
    // CEILING_CONCURRENT_CHILDREN_PER_AGENT=20, CEILING_CONCURRENT=64, CEILING_TOTAL=200
    process.env['AFK_MAX_CONCURRENT_CHILDREN_PER_AGENT'] = '21';
    const config = resolveDelegationBudgetConfig();
    expect(config).not.toBeUndefined();
    expect(config?.maxConcurrentChildrenPerAgent).toBe(20); // clamped from 21 to 20
  });

  it('returns undefined for non-numeric string', () => {
    process.env['AFK_MAX_CONCURRENT_CHILDREN_PER_AGENT'] = 'abc';
    // Only this one var set, and it is non-numeric — all three resolve undefined
    const config = resolveDelegationBudgetConfig();
    expect(config).toBeUndefined();
  });

  it('returns undefined for zero (zero is not a positive int)', () => {
    process.env['AFK_MAX_CONCURRENT_CHILDREN_PER_AGENT'] = '0';
    const config = resolveDelegationBudgetConfig();
    expect(config).toBeUndefined();
  });

  it('valid value passes through unchanged', () => {
    process.env['AFK_MAX_CONCURRENT_CHILDREN_PER_AGENT'] = '5';
    const config = resolveDelegationBudgetConfig();
    expect(config?.maxConcurrentChildrenPerAgent).toBe(5);
  });

  it('at least one var set returns non-undefined config', () => {
    process.env['AFK_MAX_TOTAL_AGENTS'] = '100';
    const config = resolveDelegationBudgetConfig();
    expect(config).not.toBeUndefined();
    expect(config?.maxTotalAgents).toBe(100);
    // Fields not set remain absent
    expect(config?.maxConcurrentChildrenPerAgent).toBeUndefined();
    expect(config?.maxConcurrentAgents).toBeUndefined();
  });
});

// ─── buildBudgetRefusalMessage ───────────────────────────────────────────────

describe('buildBudgetRefusalMessage', () => {
  it('returns empty string when allowed', () => {
    const check: BudgetCheckResult = { allowed: true };
    expect(buildBudgetRefusalMessage(check)).toBe('');
  });

  it('returns appropriate message for max_concurrent_children_per_agent', () => {
    const check: BudgetCheckResult = {
      allowed: false,
      reason: 'max_concurrent_children_per_agent',
      detail: 'Agent X has 3 children running (max 3).',
    };
    const msg = buildBudgetRefusalMessage(check);
    expect(msg).toContain('Delegation budget exceeded');
    expect(msg).toContain('Agent X');
    expect(msg).toContain('Wait for a running child');
  });

  it('returns appropriate message for max_concurrent_agents', () => {
    const check: BudgetCheckResult = {
      allowed: false,
      reason: 'max_concurrent_agents',
      detail: '5 agents already running (max 5).',
    };
    const msg = buildBudgetRefusalMessage(check);
    expect(msg).toContain('Delegation budget exceeded');
    expect(msg).toContain('5 agents');
    expect(msg).toContain('Work inline');
  });

  it('returns appropriate message for max_total_agents', () => {
    const check: BudgetCheckResult = {
      allowed: false,
      reason: 'max_total_agents',
      detail: '100 agents has this session (max 100).',
    };
    const msg = buildBudgetRefusalMessage(check);
    expect(msg).toContain('Delegation budget exceeded');
    expect(msg).toContain('100 agents');
    expect(msg).toContain('Work inline');
  });

  it('returns fallback message for unknown reason', () => {
    const check: BudgetCheckResult = {
      allowed: false,
      // reason intentionally omitted / undefined
    };
    const msg = buildBudgetRefusalMessage(check);
    expect(msg).toContain('Delegation budget exceeded');
  });
});
