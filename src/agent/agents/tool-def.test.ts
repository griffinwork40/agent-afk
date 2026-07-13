/**
 * Tests for the dynamic `agent` tool definition builder.
 */

import { describe, expect, it } from 'vitest';
import { buildAgentToolDef } from './tool-def.js';
import { agentTool } from '../tools/schemas.js';
import type { AgentRegistry, RegisteredAgent } from './types.js';

function registryOf(...names: string[]): AgentRegistry {
  return new Map<string, RegisteredAgent>(
    names.map((name) => [
      name,
      {
        name,
        source: 'builtin' as const,
        definition: { description: `${name} does things`, prompt: 'p' },
      },
    ]),
  );
}

describe('buildAgentToolDef', () => {
  it('returns the static agentTool unchanged for empty/absent registries', () => {
    expect(buildAgentToolDef(undefined)).toBe(agentTool);
    expect(buildAgentToolDef(new Map())).toBe(agentTool);
  });

  it('adds the agent_type property and lists available types', () => {
    const def = buildAgentToolDef(registryOf('research-agent', 'Explore'));
    expect(def.name).toBe('agent');
    expect(def.input_schema.properties).toHaveProperty('agent_type');
    expect(def.description).toContain('Available agent types');
    expect(def.description).toContain('- research-agent: research-agent does things');
    expect(def.description).toContain('- Explore: Explore does things');
    // required fields unchanged — agent_type stays optional
    expect(def.input_schema.required).toEqual(['prompt']);
  });

  it('does not mutate the static agentTool', () => {
    const before = agentTool.description;
    const beforeProps = Object.keys(agentTool.input_schema.properties ?? {});
    buildAgentToolDef(registryOf('x'));
    expect(agentTool.description).toBe(before);
    expect(Object.keys(agentTool.input_schema.properties ?? {})).toEqual(beforeProps);
  });

  it('compacts long descriptions to one line', () => {
    const registry: AgentRegistry = new Map([
      [
        'wordy',
        {
          name: 'wordy',
          source: 'builtin' as const,
          definition: {
            description: 'line one\nline two   with   spaces ' + 'x'.repeat(300),
            prompt: 'p',
          },
        },
      ],
    ]);
    const def = buildAgentToolDef(registry);
    const listingLine = def.description?.split('\n').find((l) => l.startsWith('- wordy:'));
    expect(listingLine).toBeDefined();
    expect(listingLine).not.toContain('\n');
    expect((listingLine ?? '').length).toBeLessThanOrEqual(170);
    expect(listingLine).toContain('line one line two with spaces');
  });
});
