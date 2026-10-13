import { describe, expect, it } from 'vitest';
import { parseComposeBudgets, parseToolRounds } from './compose-input-parse.budgets.js';

describe('compose budget parsers', () => {
  it('keeps omitted budgets undefined without warnings', () => {
    expect(parseComposeBudgets({})).toEqual({
      nodeTimeoutMs: undefined,
      maxToolRoundsPerNode: undefined,
      warnings: [],
    });
  });

  it('reports timeout errors before round-budget errors', () => {
    expect(() => parseComposeBudgets({
      node_timeout_ms: 1,
      max_tool_rounds_per_node: 0,
    })).toThrow('"node_timeout_ms" must be at least 1000ms (got 1). Sub-second timeouts are almost always a unit mistake.');
  });

  it('orders timeout clamping before alias warnings and prefers the new key', () => {
    expect(parseComposeBudgets({
      node_timeout_ms: 4_000_000,
      max_tool_rounds_per_node: 5,
      max_tool_calls_per_node: 0,
    })).toEqual({
      nodeTimeoutMs: 3_600_000,
      maxToolRoundsPerNode: 5,
      warnings: [
        'node_timeout_ms clamped: requested 4000000ms exceeds the maximum 3600000ms; using 3600000ms.',
        'both "max_tool_rounds_per_node" and the deprecated "max_tool_calls_per_node" were supplied; using "max_tool_rounds_per_node" and ignoring the deprecated key.',
      ],
    });
  });

  it('normalizes the deprecated key with its unchanged warning', () => {
    expect(parseComposeBudgets({ max_tool_calls_per_node: 3 })).toEqual({
      nodeTimeoutMs: undefined,
      maxToolRoundsPerNode: 3,
      warnings: [
        '"max_tool_calls_per_node" is deprecated — use "max_tool_rounds_per_node". The unit is tool-use ROUNDS (a round with N parallel calls costs 1), and spending the budget now triggers a tools-stripped wind-down round instead of cancelling the node.',
      ],
    });
  });

  it('preserves tool-round validation precedence and boundaries', () => {
    expect(() => parseToolRounds(0, 'budget')).toThrow('"budget" must be a positive finite number');
    expect(() => parseToolRounds(1000.5, 'budget')).toThrow('"budget" must be an integer (got 1000.5). Tool-use rounds are discrete events; fractional budgets are not meaningful.');
    expect(() => parseToolRounds(1001, 'budget')).toThrow('"budget" must be at most 1000 (got 1001). A larger budget no longer constrains useful work.');
    expect(parseToolRounds(1, 'budget')).toBe(1);
    expect(parseToolRounds(1000, 'budget')).toBe(1000);
  });
});
