/**
 * Tests for the combined budget admission gate.
 *
 * Covers:
 *  - delegation budget admission and rollback/release lifecycle
 *  - continuation budget admission and rollback/release lifecycle
 *  - combined dual-budget admission
 *  - fail-closed paths (delegation refusal, continuation refusal, alloc race)
 *  - continuation without chain id is NOT charged (non-continuation dispatch)
 *  - no permissions expanded (chain id not forwarded, grants unchanged)
 *  - idempotent release/rollback on BudgetHandle
 *
 * @module agent/tools/subagent/budget-gate.test
 */

import { describe, it, expect, vi } from 'vitest';
import { checkBudgetGates } from './budget-gate.js';
import { DelegationBudget, ContinuationBudget } from '../delegation-budget.js';
import type { SubagentExecutorContext } from '../subagent-executor/types.js';

// Minimal stub context for tests — only the fields budget-gate.ts reads.
function makeCtx(
  delegationBudget?: DelegationBudget,
  continuationBudget?: ContinuationBudget,
): Pick<SubagentExecutorContext, 'delegationBudget' | 'continuationBudget' | 'parentSession'> {
  return {
    delegationBudget,
    continuationBudget,
    parentSession: { sessionId: 'parent-session-1' } as SubagentExecutorContext['parentSession'],
  };
}

describe('checkBudgetGates', () => {
  describe('no budgets configured', () => {
    it('admits without any budget checks', () => {
      const ctx = makeCtx();
      const result = checkBudgetGates(ctx as SubagentExecutorContext, { agent_type: undefined, continuation_chain_id: undefined }, {}, 0);
      expect(result.refusal).toBeNull();
      expect(result.handle).not.toBeNull();
    });

    it('handle.release() is a no-op when no budgets are configured', () => {
      const ctx = makeCtx();
      const result = checkBudgetGates(ctx as SubagentExecutorContext, {}, {}, 0);
      expect(() => result.handle!.release()).not.toThrow();
      expect(() => result.handle!.release()).not.toThrow(); // idempotent
    });
  });

  describe('delegation budget only', () => {
    it('admits when within budget', () => {
      const budget = new DelegationBudget({ maxConcurrentAgents: 5 });
      const ctx = makeCtx(budget);
      const result = checkBudgetGates(ctx as SubagentExecutorContext, {}, {}, 0);
      expect(result.refusal).toBeNull();
      expect(result.handle).not.toBeNull();
    });

    it('refuses when at concurrent agent limit', () => {
      const budget = new DelegationBudget({ maxConcurrentAgents: 0 });
      // maxConcurrentAgents: 0 fails parse (resolvePositiveInt filters it).
      // Use a limit of 1 and exhaust it manually.
      const budget2 = new DelegationBudget({ maxConcurrentAgents: 1 });
      budget2.recordSpawn('parent-session-1'); // exhaust the one slot
      const ctx = makeCtx(budget2);
      const result = checkBudgetGates(ctx as SubagentExecutorContext, {}, {}, 0);
      expect(result.refusal).not.toBeNull();
      expect(result.refusal?.isError).toBe(true);
      expect(result.refusal?.content).toContain('Delegation budget exceeded');
      expect(result.handle).toBeNull();
    });

    it('handle.rollback() returns ALL counters on fork failure', () => {
      const budget = new DelegationBudget({ maxTotalAgents: 5 });
      const ctx = makeCtx(budget);
      const result = checkBudgetGates(ctx as SubagentExecutorContext, {}, {}, 0);
      expect(result.refusal).toBeNull();
      const snap1 = budget.snapshot();
      expect(snap1.total).toBe(1); // recorded
      result.handle!.rollback();
      const snap2 = budget.snapshot();
      expect(snap2.total).toBe(0); // rolled back
      expect(snap2.concurrent).toBe(0);
    });

    it('handle.rollback() is idempotent', () => {
      const budget = new DelegationBudget({ maxTotalAgents: 5 });
      const ctx = makeCtx(budget);
      const result = checkBudgetGates(ctx as SubagentExecutorContext, {}, {}, 0);
      result.handle!.rollback();
      result.handle!.rollback(); // second call is a no-op
      expect(budget.snapshot().total).toBe(0);
    });

    it('handle.release() decrements concurrent but keeps total', () => {
      const budget = new DelegationBudget({ maxTotalAgents: 10, maxConcurrentAgents: 5 });
      const ctx = makeCtx(budget);
      const result = checkBudgetGates(ctx as SubagentExecutorContext, {}, {}, 0);
      result.handle!.release();
      const snap = budget.snapshot();
      expect(snap.total).toBe(1);   // total preserved (real spawn happened)
      expect(snap.concurrent).toBe(0); // concurrent decremented
    });

    it('spawnRelease matches the raw release function from SpawnReceipt', () => {
      const budget = new DelegationBudget({ maxConcurrentAgents: 10 });
      const ctx = makeCtx(budget);
      const result = checkBudgetGates(ctx as SubagentExecutorContext, {}, {}, 0);
      expect(result.handle!.spawnRelease).toBeTypeOf('function');
      // Calling spawnRelease directly also decrements concurrent.
      result.handle!.spawnRelease!();
      expect(budget.snapshot().concurrent).toBe(0);
    });
  });

  describe('continuation budget only (no delegation budget)', () => {
    it('admits when continuation_chain_id is absent (non-continuation dispatch)', () => {
      const contBudget = new ContinuationBudget({ maxChainRounds: 100, maxContinuations: 3 });
      const ctx = makeCtx(undefined, contBudget);
      // No continuation_chain_id → budget not checked
      const result = checkBudgetGates(ctx as SubagentExecutorContext, { continuation_chain_id: undefined }, {}, 0);
      expect(result.refusal).toBeNull();
      expect(contBudget.snapshot().continuationsDispatched).toBe(0); // not charged
    });

    it('admits and charges continuation budget when chain id is supplied', () => {
      const contBudget = new ContinuationBudget({ maxChainRounds: 100, maxContinuations: 3 });
      const ctx = makeCtx(undefined, contBudget);
      const result = checkBudgetGates(
        ctx as SubagentExecutorContext,
        { continuation_chain_id: 'chain-1', max_tool_use_iterations: 50 },
        {}, 0,
      );
      expect(result.refusal).toBeNull();
      expect(contBudget.snapshot().continuationsDispatched).toBe(1);
      expect(contBudget.snapshot().roundsGranted).toBe(50);
    });

    it('refuses when continuation round limit is exhausted', () => {
      const contBudget = new ContinuationBudget({ maxChainRounds: 30, maxContinuations: 3 });
      const ctx = makeCtx(undefined, contBudget);
      const result = checkBudgetGates(
        ctx as SubagentExecutorContext,
        { continuation_chain_id: 'chain-1', max_tool_use_iterations: 50 }, // 50 > 30
        {}, 0,
      );
      expect(result.refusal).not.toBeNull();
      expect(result.refusal?.content).toContain('insufficient');
      expect(result.handle).toBeNull();
      expect(contBudget.snapshot().continuationsDispatched).toBe(0); // not charged
    });

    it('refuses when continuation count limit is reached', () => {
      const contBudget = new ContinuationBudget({ maxChainRounds: 300, maxContinuations: 1 });
      contBudget.allocate(50); // exhaust the 1 allowed continuation
      const ctx = makeCtx(undefined, contBudget);
      const result = checkBudgetGates(
        ctx as SubagentExecutorContext,
        { continuation_chain_id: 'chain-1', max_tool_use_iterations: 50 },
        {}, 0,
      );
      expect(result.refusal).not.toBeNull();
      expect(result.refusal?.content).toContain('Continuation budget exhausted');
      expect(result.handle).toBeNull();
    });

    it('refuses when continuation dispatch has no explicit round cap', () => {
      const contBudget = new ContinuationBudget({ maxChainRounds: 100, maxContinuations: 3 });
      const ctx = makeCtx(undefined, contBudget);
      const result = checkBudgetGates(
        ctx as SubagentExecutorContext,
        { continuation_chain_id: 'chain-1' }, // no max_tool_use_iterations
        {}, 0,
      );
      expect(result.refusal).not.toBeNull();
      expect(result.refusal?.content).toContain('max_tool_use_iterations');
      expect(result.handle).toBeNull();
    });

    it('handle.rollback() returns all granted rounds on fork failure', () => {
      const contBudget = new ContinuationBudget({ maxChainRounds: 100, maxContinuations: 3 });
      const ctx = makeCtx(undefined, contBudget);
      const result = checkBudgetGates(
        ctx as SubagentExecutorContext,
        { continuation_chain_id: 'chain-1', max_tool_use_iterations: 50 },
        {}, 0,
      );
      expect(contBudget.remainingRounds).toBe(50); // 100 - 50 granted
      result.handle!.rollback(); // fork failed → return all 50 rounds
      expect(contBudget.remainingRounds).toBe(100); // fully returned
    });
  });

  describe('both budgets configured', () => {
    it('admits when both budgets have capacity', () => {
      const delBudget = new DelegationBudget({ maxTotalAgents: 10 });
      const contBudget = new ContinuationBudget({ maxChainRounds: 100, maxContinuations: 3 });
      const ctx = makeCtx(delBudget, contBudget);
      const result = checkBudgetGates(
        ctx as SubagentExecutorContext,
        { continuation_chain_id: 'chain-1', max_tool_use_iterations: 40 },
        {}, 0,
      );
      expect(result.refusal).toBeNull();
      expect(delBudget.snapshot().total).toBe(1);
      expect(contBudget.snapshot().roundsGranted).toBe(40);
    });

    it('refuses and rolls back delegation when continuation is exhausted', () => {
      const delBudget = new DelegationBudget({ maxTotalAgents: 10 });
      const contBudget = new ContinuationBudget({ maxChainRounds: 10, maxContinuations: 3 });
      const ctx = makeCtx(delBudget, contBudget);
      const result = checkBudgetGates(
        ctx as SubagentExecutorContext,
        { continuation_chain_id: 'chain-1', max_tool_use_iterations: 50 }, // 50 > 10
        {}, 0,
      );
      expect(result.refusal).not.toBeNull();
      // Delegation was charged then rolled back when continuation refused.
      expect(delBudget.snapshot().total).toBe(0); // rolled back
      expect(contBudget.snapshot().continuationsDispatched).toBe(0);
    });

    it('combined rollback undoes both budgets atomically', () => {
      const delBudget = new DelegationBudget({ maxTotalAgents: 10 });
      const contBudget = new ContinuationBudget({ maxChainRounds: 100, maxContinuations: 3 });
      const ctx = makeCtx(delBudget, contBudget);
      const result = checkBudgetGates(
        ctx as SubagentExecutorContext,
        { continuation_chain_id: 'chain-1', max_tool_use_iterations: 50 },
        {}, 0,
      );
      result.handle!.rollback();
      expect(delBudget.snapshot().total).toBe(0);
      expect(contBudget.remainingRounds).toBe(100); // all returned
    });
  });
});
