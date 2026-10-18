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
    `)).toEqual(['exit_plan_mode', 'tool_b']);
  });

  it('does not count inline tokens in MDX or HTML comments', () => {
    expect(missingTokens(['mdx', 'html', 'visible'], '{/* `mdx` */}\n<!-- `html` -->\n`visible`')).toEqual(['mdx', 'html']);
  });

  it.each([
    "import { NAME } from './names';\nconst tool = { name: NAME, input_schema: {} };",
    "const tool = { name: UNKNOWN, input_schema: {} };",
    "const NAME = 'outer';\nfunction local() { const NAME = 'inner'; return { name: NAME, input_schema: {} }; }",
    "function local() { const NAME = 'inner'; return { name: NAME, input_schema: {} }; }",
    "let NAME = 'mutable';\nconst tool = { name: NAME, input_schema: {} };",
    "const tool = { name: computeName(), input_schema: {} };",
  ])('fails closed on ambiguous or unresolved tool names: %s', (text) => {
    expect(() => schemaNames(text, 'fixture.ts')).toThrow(/fixture\.ts:\d+.*(?:name|NAME|UNKNOWN)/);
  });

  it('resolves unique top-level const aliases regardless of declaration order', () => {
    expect(schemaNames("const tool = { name: ALIAS, input_schema: {} }; const ALIAS = NAME; const NAME = `tool`;"))
      .toEqual(['tool']);
    expect(() => schemaNames('const A = B; const B = A; const tool = { name: A, input_schema: {} };', 'cycle.ts'))
      .toThrow('cycle.ts:1: cannot unambiguously resolve tool name A');
  });

  it('exempts only the known dynamic MCP adapter return, not other schemas in its file', () => {
    const filename = 'src/agent/mcp/manager.ts';
    const adapter = 'function mcpToolToAnthropic(wireName: string) { return { name: wireName, input_schema: {} }; }';
    expect(schemaNames(adapter, filename)).toEqual([]);
    expect(() => schemaNames(adapter, 'other.ts')).toThrow('other.ts:1:');
    expect(() => schemaNames(`${adapter}\nconst tool = { name: UNKNOWN, input_schema: {} };`, filename))
      .toThrow('src/agent/mcp/manager.ts:2:');
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
