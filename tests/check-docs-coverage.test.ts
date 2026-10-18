import { describe, expect, it } from 'vitest';
import { checkCoverage, collectCoverageNames, hookEvents, missingTokens, schemaNames } from '../scripts/check-docs-coverage.js';
import { repoRoot } from '../scripts/lib/docs-reference.js';
import { ALL_TOOL_SCHEMAS } from '../src/agent/tools/schemas.js';
import { memoryToolSchemas } from '../src/agent/memory/memory-tools.js';
import { stateToolSchemas } from '../src/agent/state/state-schemas.js';
import { workspaceToolSchemas } from '../src/agent/workspace/workspace-tools.js';
import { getRuntimeStateTool } from '../src/agent/awareness/tool.js';
import { exitPlanModeTool } from '../src/agent/tools/handlers/exit-plan-mode.js';

describe('tool and hook documentation coverage', () => {
  it('derives the complete registry universe independently of runtime handlers', () => {
    const expected = [...new Set([...ALL_TOOL_SCHEMAS, ...memoryToolSchemas, ...stateToolSchemas,
      ...workspaceToolSchemas, getRuntimeStateTool, exitPlanModeTool].map((tool) => tool.name))].sort();
    const actual = collectCoverageNames(repoRoot);
    expect(actual.tools).toEqual(expected);
    expect(actual.tools).toContain('git_read');
    expect(actual.tools).toContain('exit_plan_mode');
    expect(actual.hooks).toHaveLength(10);
  });

  it('finds literal and constant tool names, ignores nested option names and spread-only wrappers', () => {
    expect(schemaNames(`
      const NAME = 'exit_plan_mode';
      export const a = { name: NAME, input_schema: { properties: { name: { type: 'string' } } } };
      const b = { name: 'tool_b', input_schema: {} };
      const wrapper = { ...a, input_schema: { ...a.input_schema } };
      const notTool = { name: 'not_tool' };
      const dynamic = { name: runtimeName, input_schema: {} };
    `)).toEqual(['exit_plan_mode', 'tool_b']);
  });

  it('parses the event union and fails loudly if the definition changes shape', () => {
    expect(hookEvents("export type HarnessHookEvent = 'Z' | 'A';")).toEqual(['A', 'Z']);
    expect(() => hookEvents('export type HarnessHookEvent = string;')).toThrow('union not found');
    expect(() => hookEvents("export type HarnessHookEvent = 'A' | string;")).toThrow('Nonliteral');
  });

  it('passes complete fixtures and requires exact inline-code tokens', () => {
    expect(checkCoverage(['alpha', 'beta'], ['Start'], '`alpha` and `beta`', '`Start`')).toEqual([]);
    expect(checkCoverage(['alpha', 'beta'], ['Start'], 'alpha and `betamax`', 'Start')).toEqual([
      'reference/tools: missing alpha', 'reference/tools: missing beta', 'reference/hooks: missing Start',
    ]);
    expect(missingTokens(['alpha'], '```ts\n`alpha`\n```')).toEqual(['alpha']);
    expect(missingTokens(['alpha'], '``alpha``')).toEqual(['alpha']);
  });
});
