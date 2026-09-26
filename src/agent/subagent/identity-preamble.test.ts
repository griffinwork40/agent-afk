import { describe, it, expect } from 'vitest';

import {
  injectSubagentIdentityPreamble,
  renderSubagentIdentityPreamble,
} from './identity-preamble.js';
import type { AgentConfig } from '../types/config-types.js';

const AUDIENCE = 'You are a subagent: another agent dispatched you';
const NO_HUMAN = 'No human is reachable from this session.';
const AT_CAP = 'You are at the maximum nesting depth';
const MAY_NEST = 'Dispatch\nfurther subagents only when';

describe('renderSubagentIdentityPreamble', () => {
  it('always states the audience, even with no facts known', () => {
    const out = renderSubagentIdentityPreamble({
      isNonInteractive: undefined,
      depth: undefined,
      maxDepth: undefined,
    });
    expect(out.startsWith('# Subagent context')).toBe(true);
    expect(out).toContain(AUDIENCE);
    expect(out).toContain('not to a person');
  });

  it('asserts no human is reachable only when isNonInteractive is exactly true', () => {
    const base = { depth: 1, maxDepth: 3 };
    expect(renderSubagentIdentityPreamble({ ...base, isNonInteractive: true })).toContain(NO_HUMAN);
    expect(renderSubagentIdentityPreamble({ ...base, isNonInteractive: false })).not.toContain(NO_HUMAN);
    expect(renderSubagentIdentityPreamble({ ...base, isNonInteractive: undefined })).not.toContain(NO_HUMAN);
  });

  it('forbids further dispatch at the cap (depth >= maxDepth) and names the depth', () => {
    for (const [depth, maxDepth] of [[3, 3], [4, 3]] as const) {
      const out = renderSubagentIdentityPreamble({ isNonInteractive: true, depth, maxDepth });
      expect(out).toContain(`${AT_CAP} (${depth}/${maxDepth})`);
      expect(out).not.toContain(MAY_NEST);
    }
  });

  it('allows conditional delegation below the cap instead of forbidding it', () => {
    const out = renderSubagentIdentityPreamble({ isNonInteractive: true, depth: 1, maxDepth: 3 });
    expect(out).toContain(MAY_NEST);
    expect(out).toContain('your instructions call for it');
    expect(out).not.toContain(AT_CAP);
  });

  it('falls back to the conditional-delegation line when depth or maxDepth is unknown', () => {
    for (const facts of [
      { depth: undefined, maxDepth: 3 },
      { depth: 1, maxDepth: undefined },
      { depth: Number.NaN, maxDepth: 3 },
    ]) {
      const out = renderSubagentIdentityPreamble({ isNonInteractive: true, ...facts });
      expect(out).toContain(MAY_NEST);
      expect(out).not.toContain(AT_CAP);
    }
  });
});

describe('injectSubagentIdentityPreamble', () => {
  it('appends after an existing string prompt so the task keeps top salience', () => {
    const cfg: AgentConfig = { systemPrompt: 'TASK PROMPT', isNonInteractive: true, depth: 1, maxDepth: 3 };
    const out = injectSubagentIdentityPreamble(cfg);
    const sp = out.systemPrompt as string;
    expect(sp.startsWith('TASK PROMPT\n\n# Subagent context')).toBe(true);
    expect(sp).toContain(NO_HUMAN);
  });

  it('does not mutate the input config', () => {
    const cfg: AgentConfig = { systemPrompt: 'TASK PROMPT' };
    const out = injectSubagentIdentityPreamble(cfg);
    expect(cfg.systemPrompt).toBe('TASK PROMPT');
    expect(out).not.toBe(cfg);
  });

  it('becomes the prompt when no prompt (or an empty one) is set', () => {
    for (const cfg of [{}, { systemPrompt: '' }] as AgentConfig[]) {
      const sp = injectSubagentIdentityPreamble(cfg).systemPrompt as string;
      expect(sp.startsWith('# Subagent context')).toBe(true);
    }
  });

  it('appends into a preset prompt via `append`, preserving any existing append', () => {
    const cfg = {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'EXISTING' },
    } as unknown as AgentConfig;
    const sp = injectSubagentIdentityPreamble(cfg).systemPrompt as unknown as { append: string };
    expect(sp.append.startsWith('EXISTING\n\n# Subagent context')).toBe(true);
  });

  it('reads the facts from the config it is given', () => {
    const atCap = injectSubagentIdentityPreamble({ isNonInteractive: false, depth: 2, maxDepth: 2 });
    const sp = atCap.systemPrompt as string;
    expect(sp).toContain(`${AT_CAP} (2/2)`);
    expect(sp).not.toContain(NO_HUMAN);
  });
});
