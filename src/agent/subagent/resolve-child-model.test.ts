import { describe, it, expect } from 'vitest';
import { resolveChildModel } from './resolve-child-model.js';

describe('resolveChildModel — centralized precedence chain', () => {
  it('callSiteModel wins over everything', () => {
    expect(resolveChildModel({
      callSiteModel: 'opus',
      namedAgentModel: 'haiku',
      defaultSubagentModel: 'sonnet',
      defaultModel: 'gpt-4o',
    })).toBe('opus');
  });

  it('namedAgentModel wins over defaultSubagentModel and defaultModel', () => {
    expect(resolveChildModel({
      namedAgentModel: 'haiku',
      defaultSubagentModel: 'sonnet',
      defaultModel: 'gpt-4o',
    })).toBe('haiku');
  });

  it('defaultSubagentModel wins over defaultModel', () => {
    expect(resolveChildModel({
      defaultSubagentModel: 'medium',
      defaultModel: 'opus',
    })).toBe('medium');
  });

  it('defaultModel wins over the hardcoded sonnet floor', () => {
    expect(resolveChildModel({
      defaultModel: 'gpt-4o',
    })).toBe('gpt-4o');
  });

  it('falls to sonnet when everything is undefined', () => {
    expect(resolveChildModel({})).toBe('sonnet');
  });

  it('skips undefined entries in the chain', () => {
    expect(resolveChildModel({
      callSiteModel: undefined,
      namedAgentModel: undefined,
      defaultSubagentModel: 'medium',
    })).toBe('medium');
  });

  // Regression: the agent-tool path (child-config.ts) intentionally omits
  // defaultModel. This test pins that the resolver works correctly when
  // only the fields that path supplies are present.
  it('agent-tool shape: callSite + namedAgent + defaultSubagentModel (no defaultModel)', () => {
    expect(resolveChildModel({
      callSiteModel: undefined,
      namedAgentModel: undefined,
      defaultSubagentModel: 'medium',
    })).toBe('medium');
  });

  // Regression: the compose/skill paths include defaultModel as a safety net.
  it('compose/skill shape: callSite + defaultSubagentModel + defaultModel', () => {
    expect(resolveChildModel({
      callSiteModel: undefined,
      defaultSubagentModel: undefined,
      defaultModel: 'grok-4.6',
    })).toBe('grok-4.6');
  });
});
