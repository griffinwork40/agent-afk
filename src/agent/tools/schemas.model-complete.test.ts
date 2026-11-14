/**
 * Positioning tests for `model_complete`: what its description leads with, and
 * the two neighbouring surfaces that decide whether an agent picks it or forks
 * a subagent instead.
 *
 * These pin intent, not exact wording, so the prose can be reworded freely as
 * long as the ordering and the caveats survive.
 */

import { describe, expect, it } from 'vitest';
import { modelCompleteTool } from './schemas.model-complete.js';
import { agentTool } from './schemas.agent-tools.js';
import { TOOL_SYSTEM_PROMPT_BASE } from './system-prompt.js';

const description = modelCompleteTool.description ?? '';

describe('model_complete description positioning', () => {
  it('leads with challenging a conclusion, ahead of offloading text work', () => {
    const challenge = description.indexOf('challenge a consequential conclusion');
    const offload = description.indexOf('offload bounded text work');
    expect(challenge).toBeGreaterThan(-1);
    expect(offload).toBeGreaterThan(-1);
    expect(challenge).toBeLessThan(offload);
  });

  it('does not let the caller assume independence it has not arranged', () => {
    // The default model is the session's own, and the callee sees only the
    // prompt: both must be stated or "second opinion" overpromises.
    expect(description).toContain('different family');
    expect(description).toContain('sees only what you send it');
    expect(description).toContain('usually the model you are already running on');
    expect(description).toContain('not as verification');
  });

  it('still routes tool-needing work to agent', () => {
    expect(description).toContain('Use `agent` instead when the work needs tools');
  });
});

describe('routing between agent and model_complete', () => {
  it('the agent description points at model_complete for prompt-sized second opinions', () => {
    expect(agentTool.description).toContain('`model_complete`');
    expect(agentTool.description).toContain('cheaper than a fork');
  });

  it('the base prompt sends only tool-needing verification to subagents', () => {
    expect(TOOL_SYSTEM_PROMPT_BASE).toContain('verification that needs tools or fresh evidence');
  });

  it('the base prompt names no tool that read-only agent types lack', () => {
    // TOOL_SYSTEM_PROMPT_BASE reaches agent types whose allowlist excludes
    // model_complete (e.g. Explore), so the routing rule lives in the agent
    // tool description instead.
    expect(TOOL_SYSTEM_PROMPT_BASE).not.toContain('model_complete');
  });
});
