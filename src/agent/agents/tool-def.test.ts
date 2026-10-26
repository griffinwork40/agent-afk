/**
 * Tests for the `agent` tool definition builder and agent-type listing
 * formatter (#4217: description is now static; listing moves to system prompt).
 */

import { describe, expect, it } from 'vitest';
import { buildAgentToolDef, buildAgentTypeListing } from './tool-def.js';
import { builtinAgents } from './builtins.js';
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

// ---------------------------------------------------------------------------
// buildAgentToolDef — description must be STATIC regardless of registry
// ---------------------------------------------------------------------------

describe('buildAgentToolDef', () => {
  it('returns the static agentTool unchanged for empty/absent registries', () => {
    expect(buildAgentToolDef(undefined)).toBe(agentTool);
    expect(buildAgentToolDef(new Map())).toBe(agentTool);
  });

  it('adds the agent_type property when registry is non-empty', () => {
    const def = buildAgentToolDef(registryOf('research-agent', 'Explore'));
    expect(def.name).toBe('agent');
    expect(def.input_schema.properties).toHaveProperty('agent_type');
    // required fields unchanged — agent_type stays optional
    expect(def.input_schema.required).toEqual(['prompt']);
  });

  it('description does NOT contain individual agent names (listing moved to system prompt)', () => {
    const def = buildAgentToolDef(registryOf('research-agent', 'Explore'));
    expect(def.description).not.toContain('research-agent: research-agent does things');
    expect(def.description).not.toContain('Explore: Explore does things');
  });

  it('description is byte-identical regardless of registry contents (#4217)', () => {
    const defA = buildAgentToolDef(registryOf('research-agent'));
    const defB = buildAgentToolDef(registryOf('research-agent', 'Explore', 'probe-agent'));
    // Tool descriptions must match so the prefix cache is never busted by
    // agent-set differences between sessions.
    expect(defA.description).toBe(defB.description);
  });

  it('description refers the model to the system prompt for the listing', () => {
    const def = buildAgentToolDef(registryOf('research-agent'));
    expect(def.description).toContain('system prompt');
  });

  it('agent_type property description refers to system prompt, not tool description', () => {
    const def = buildAgentToolDef(registryOf('research-agent'));
    const agentTypeProp = def.input_schema.properties?.['agent_type'] as
      | { description?: string }
      | undefined;
    expect(agentTypeProp?.description).toContain('system prompt');
  });

  it('does not mutate the static agentTool', () => {
    const before = agentTool.description;
    const beforeProps = Object.keys(agentTool.input_schema.properties ?? {});
    buildAgentToolDef(registryOf('x'));
    expect(agentTool.description).toBe(before);
    expect(Object.keys(agentTool.input_schema.properties ?? {})).toEqual(beforeProps);
  });
});

// ---------------------------------------------------------------------------
// buildAgentTypeListing — dynamic listing for the system prompt
// ---------------------------------------------------------------------------

describe('buildAgentTypeListing', () => {
  it('returns empty string for empty/absent registries', () => {
    expect(buildAgentTypeListing(undefined)).toBe('');
    expect(buildAgentTypeListing(new Map())).toBe('');
  });

  it('lists every registered agent type', () => {
    const listing = buildAgentTypeListing(registryOf('research-agent', 'Explore'));
    expect(listing).toContain('research-agent: research-agent does things');
    expect(listing).toContain('Explore: Explore does things');
  });

  it('includes "Available agent types" header', () => {
    const listing = buildAgentTypeListing(registryOf('research-agent'));
    expect(listing).toContain('Available agent types');
  });

  it('includes budget metadata for named agents with explicit budgets', () => {
    const listing = buildAgentTypeListing(builtinAgents());
    const listingLine = listing
      .split('\n')
      .find((line) => line.includes('research-agent') && line.startsWith('- '));
    expect(listingLine).toContain('budget: 50 rounds');
  });

  it('advertises the research-agent write constraint before truncation', () => {
    const listing = buildAgentTypeListing(builtinAgents());
    const listingLine = listing
      .split('\n')
      .find((line) => line.includes('research-agent') && line.startsWith('- '));
    expect(listingLine).toContain(
      'CANNOT write files, edit code, run bash, commit, or push — read-only enforced.',
    );
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
    const listing = buildAgentTypeListing(registry);
    const listingLine = listing.split('\n').find((l) => l.startsWith('- wordy:'));
    expect(listingLine).toBeDefined();
    expect(listingLine).not.toContain('\n');
    expect((listingLine ?? '').length).toBeLessThanOrEqual(170);
    expect(listingLine).toContain('line one line two with spaces');
  });

  it('listing varies with registry contents (different sessions → different listing)', () => {
    const listingA = buildAgentTypeListing(registryOf('research-agent'));
    const listingB = buildAgentTypeListing(registryOf('research-agent', 'probe-agent'));
    expect(listingA).not.toBe(listingB);
    expect(listingB).toContain('probe-agent');
  });
});
