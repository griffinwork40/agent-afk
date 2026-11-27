/**
 * Tests for the `agent` tool definition builder and agent-type listing
 * formatter (#4217: description is now static; listing moves to system prompt).
 * (#4509: model param description is now dynamic, reflecting live slot bindings.)
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { buildAgentToolDef, buildAgentTypeListing, buildComposeTool, buildAgentModelParamDescription } from './tool-def.js';
import { builtinAgents } from './builtins.js';
import { agentTool } from '../tools/schemas.js';
import { setSlotBindings, resetSlotBindings } from '../session/model-slots.js';
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
  it('returns a copy (not the static agentTool) even for empty/absent registries (#4509)', () => {
    // #4509: model param description is now always patched, so a copy is always
    // returned. The returned schema is still functionally equivalent for empty
    // registries — no agent_type property, no AGENT_TYPE_STATIC_SUFFIX in the
    // top-level description — but the object reference will differ.
    const def = buildAgentToolDef(undefined);
    expect(def.name).toBe('agent');
    expect(def.input_schema.properties).not.toHaveProperty('agent_type');
    const modelProp = (def.input_schema.properties as Record<string, { description?: string }>)['model'];
    // Dynamic description must mention slot name options.
    expect(modelProp?.description).toContain('slot name');
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
// buildAgentModelParamDescription — dynamic model param description (#4509)
// ---------------------------------------------------------------------------

describe('buildAgentModelParamDescription', () => {
  afterEach(() => {
    resetSlotBindings();
    vi.unstubAllEnvs();
  });

  it('mentions slot name options in the default (unconfigured) state', () => {
    const desc = buildAgentModelParamDescription();
    expect(desc).toContain('slot name');
    expect(desc).toContain('small');
    expect(desc).toContain('medium');
    expect(desc).toContain('large');
  });

  it('lists a configured local slot as a bound target', () => {
    setSlotBindings({
      local: { id: 'llama-3.1-8b' },
      small: { id: 'claude-haiku-5-5' },
      medium: { id: 'claude-sonnet-4-6' },
      large: { id: 'claude-opus-5-5' },
      subagent: { id: '' },
    });
    const desc = buildAgentModelParamDescription();
    expect(desc).toContain('`local`');
    expect(desc).toContain('llama-3.1-8b');
  });

  it('names AFK_DEFAULT_SUBAGENT_MODEL as the default when set', () => {
    vi.stubEnv('AFK_DEFAULT_SUBAGENT_MODEL', 'local');
    const desc = buildAgentModelParamDescription();
    expect(desc).toContain('AFK_DEFAULT_SUBAGENT_MODEL');
    expect(desc).toContain('`local`');
    vi.unstubAllEnvs();
  });

  it('names subagent slot default when subagent slot is configured', () => {
    setSlotBindings({
      local: { id: '' },
      small: { id: 'claude-haiku-5-5' },
      medium: { id: 'claude-sonnet-4-6' },
      large: { id: 'claude-opus-5-5' },
      subagent: { id: 'gpt-4o-mini' },
    });
    const desc = buildAgentModelParamDescription();
    expect(desc).toContain('subagent');
    expect(desc).toContain('gpt-4o-mini');
  });

  it('falls back to medium as default with no special config', () => {
    const desc = buildAgentModelParamDescription();
    expect(desc).toMatch(/Default:.*`medium`/);
  });

  it('inherits a non-default parentModel when it resolves to openai-compatible (#4663)', () => {
    // The OpenAI-compatible parent-inherit path: when no env var or subagent
    // slot overrides the default, a GPT/o-series parent should be inherited
    // so local/OpenAI-only setups don't silently dispatch Anthropic subagents.
    const desc = buildAgentModelParamDescription('gpt-4o');
    expect(desc).toMatch(/Default: `gpt-4o`/);
    // Must NOT fall back to medium for an OpenAI-compatible parent.
    expect(desc).not.toMatch(/Default: `medium`/);
  });
});

// ---------------------------------------------------------------------------
// buildComposeTool — compose node model description is also dynamic (#4509)
// ---------------------------------------------------------------------------

describe('buildComposeTool', () => {
  afterEach(() => {
    resetSlotBindings();
  });

  it('patches the node model description with slot info', () => {
    setSlotBindings({
      local: { id: 'llama-3.1-8b' },
      small: { id: 'claude-haiku-5-5' },
      medium: { id: 'claude-sonnet-4-6' },
      large: { id: 'claude-opus-5-5' },
      subagent: { id: '' },
    });
    const def = buildComposeTool();
    const nodesItems = (def.input_schema.properties as Record<string, {
      items?: { properties?: Record<string, { description?: string }> };
    }>)['nodes']?.items;
    const modelDesc = nodesItems?.properties?.['model']?.description ?? '';
    expect(modelDesc).toContain('`local`');
    expect(modelDesc).toContain('llama-3.1-8b');
    expect(modelDesc).toContain('slot name');
  });

  it('does not mutate the static composeTool', async () => {
    const { composeTool } = await import('../tools/schemas.js');
    type NodesProp = { items?: { properties?: Record<string, { description?: string }> } };
    const nodeModelDesc = (props: Record<string, NodesProp>) =>
      props['nodes']?.items?.properties?.['model']?.description;
    const beforeDesc = nodeModelDesc(composeTool.input_schema.properties as Record<string, NodesProp>);
    buildComposeTool();
    const afterDesc = nodeModelDesc(composeTool.input_schema.properties as Record<string, NodesProp>);
    expect(afterDesc).toBe(beforeDesc);
  });
});

// ---------------------------------------------------------------------------
// buildAgentTypeListing — dynamic listing for the system prompt
// ---------------------------------------------------------------------------

describe('buildAgentTypeListing', () => {
  // #4220: empty registry → no delimiter block injected into the system prompt.
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

  // #4220 item 4: listing is wrapped in a named delimiter block so the model
  // and any downstream parser can unambiguously identify the content as data.
  it('wraps the listing in <available-agent-types> delimiters (#4220)', () => {
    const listing = buildAgentTypeListing(registryOf('research-agent'));
    // Single anchored regex: open tag at start, non-empty content, close tag at end.
    expect(listing).toMatch(/^<available-agent-types>\n[\s\S]+\n<\/available-agent-types>$/);
    // Footer line must appear before the closing tag.
    expect(listing.indexOf('When `agent_type` is omitted')).toBeLessThan(
      listing.indexOf('</available-agent-types>'),
    );
  });

  // #4873: scoped child agents must only see the types they are permitted to dispatch.
  describe('nestedAgentAllowlist filtering (#4873)', () => {
    it('returns empty string when allowlist is empty (no dispatch permitted)', () => {
      const listing = buildAgentTypeListing(registryOf('research-agent', 'git-investigator'), []);
      expect(listing).toBe('');
    });

    it('filters listing to only allowed types when allowlist is non-empty', () => {
      const listing = buildAgentTypeListing(
        registryOf('research-agent', 'git-investigator', 'Explore'),
        ['git-investigator'],
      );
      expect(listing).toContain('git-investigator');
      expect(listing).not.toContain('research-agent');
      expect(listing).not.toContain('Explore');
    });

    it('returns empty string when allowlist names no types in the registry', () => {
      const listing = buildAgentTypeListing(
        registryOf('research-agent'),
        ['nonexistent-agent'],
      );
      expect(listing).toBe('');
    });

    it('unfiltered listing is unchanged when allowlist is undefined', () => {
      const withoutAllowlist = buildAgentTypeListing(registryOf('research-agent', 'git-investigator'));
      const withUndefined = buildAgentTypeListing(registryOf('research-agent', 'git-investigator'), undefined);
      expect(withoutAllowlist).toBe(withUndefined);
    });
  });
});

// ---------------------------------------------------------------------------
// buildAgentToolDef — nestedAgentAllowlist (#4873)
// ---------------------------------------------------------------------------

describe('buildAgentToolDef with nestedAgentAllowlist (#4873)', () => {
  it('returns null-equivalent: no agent_type for empty allowlist', () => {
    // Empty allowlist: agent tool should still be a valid def (providers gate on null
    // from describeAgentTool, but buildAgentToolDef itself omits agent_type property).
    const def = buildAgentToolDef(registryOf('research-agent', 'git-investigator'), undefined, []);
    expect(def.input_schema.properties).not.toHaveProperty('agent_type');
  });

  it('adds agent_type enum constrained to allowed types when allowlist is non-empty', () => {
    const def = buildAgentToolDef(
      registryOf('research-agent', 'git-investigator', 'Explore'),
      undefined,
      ['git-investigator'],
    );
    const agentTypeProp = def.input_schema.properties?.['agent_type'] as
      | { enum?: string[]; description?: string }
      | undefined;
    expect(agentTypeProp).toBeDefined();
    expect(agentTypeProp?.enum).toEqual(['git-investigator']);
    expect(agentTypeProp?.enum).not.toContain('research-agent');
    expect(agentTypeProp?.enum).not.toContain('Explore');
  });

  it('agent_type description mentions the allowed types when scoped', () => {
    const def = buildAgentToolDef(
      registryOf('research-agent', 'git-investigator'),
      undefined,
      ['git-investigator'],
    );
    const agentTypeProp = def.input_schema.properties?.['agent_type'] as
      | { description?: string }
      | undefined;
    expect(agentTypeProp?.description).toContain('git-investigator');
    expect(agentTypeProp?.description).toContain('ONLY dispatch');
  });

  it('agent_type has no enum when allowlist is undefined (unscoped)', () => {
    const def = buildAgentToolDef(registryOf('research-agent', 'git-investigator'), undefined, undefined);
    const agentTypeProp = def.input_schema.properties?.['agent_type'] as
      | { enum?: string[] }
      | undefined;
    expect(agentTypeProp).toBeDefined();
    expect(agentTypeProp?.enum).toBeUndefined();
  });
});
