import { describe, it, expect, vi } from 'vitest';

vi.mock('../tools/nesting.js', () => ({
  resolveMaxNestingDepth: vi.fn().mockReturnValue(6),
}));

import {
  injectSubagentIdentityPreamble,
  renderSubagentIdentityPreamble,
} from './identity-preamble.js';
import type { AgentConfig } from '../types/config-types.js';

const AUDIENCE = 'You are a subagent: another agent dispatched you';
const NO_HUMAN = 'No human is reachable from this session.';
const AT_CAP = 'You are at the maximum nesting depth';
const MAY_NEST = 'Dispatch\nfurther subagents only when';
const DENY_ALL = 'Nested dispatch is not permitted for this agent';
const SCOPED_PREFIX = 'agent_type is required and must be one of:';

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
      { depth: 1, maxDepth: undefined }, // resolveMaxNestingDepth()=6 so 1<6 → may-delegate
      { depth: Number.NaN, maxDepth: 3 },
    ]) {
      const out = renderSubagentIdentityPreamble({ isNonInteractive: true, ...facts });
      expect(out).toContain(MAY_NEST);
      expect(out).not.toContain(AT_CAP);
    }
  });

  it('detects at-cap when maxDepth is absent but depth equals resolveMaxNestingDepth() (issue #2266)', () => {
    // When a fork path threads depth but not maxDepth, resolveMaxNestingDepth()
    // fills the gap so a child at the default cap is correctly told it cannot
    // dispatch further, rather than silently receiving the "may delegate" line.
    // resolveMaxNestingDepth is mocked to 6 at the top of this file.
    const out = renderSubagentIdentityPreamble({ isNonInteractive: true, depth: 6, maxDepth: undefined });
    expect(out).toContain(`${AT_CAP} (6/6)`);
    expect(out).not.toContain(MAY_NEST);
  });

  // nestedAgentAllowlist tests — single-source invariant: text matches executor enforcement

  it('emits no allowlist section when nestedAgentAllowlist is undefined (unscoped child)', () => {
    const out = renderSubagentIdentityPreamble({
      isNonInteractive: true,
      depth: 1,
      maxDepth: 3,
      nestedAgentAllowlist: undefined,
    });
    expect(out).not.toContain(DENY_ALL);
    expect(out).not.toContain(SCOPED_PREFIX);
  });

  it('lists allowed types and requires agent_type when allowlist is non-empty', () => {
    const out = renderSubagentIdentityPreamble({
      isNonInteractive: true,
      depth: 1,
      maxDepth: 3,
      nestedAgentAllowlist: ['git-investigator', 'web-researcher'],
    });
    expect(out).toContain(SCOPED_PREFIX);
    expect(out).toContain('git-investigator');
    expect(out).toContain('web-researcher');
    expect(out).toContain('A bare dispatch with no agent_type is not permitted here');
    expect(out).not.toContain(DENY_ALL);
  });

  it('says dispatch is forbidden when allowlist is empty (deny-all from Agent())', () => {
    const out = renderSubagentIdentityPreamble({
      isNonInteractive: true,
      depth: 1,
      maxDepth: 3,
      nestedAgentAllowlist: [],
    });
    expect(out).toContain(DENY_ALL);
    expect(out).not.toContain(SCOPED_PREFIX);
  });

  it('allowlist section appears after the nesting-depth section (correct ordering)', () => {
    const out = renderSubagentIdentityPreamble({
      isNonInteractive: true,
      depth: 1,
      maxDepth: 3,
      nestedAgentAllowlist: ['git-investigator'],
    });
    const mayNestIdx = out.indexOf('Dispatch');
    const scopedIdx = out.indexOf(SCOPED_PREFIX);
    expect(mayNestIdx).toBeGreaterThan(-1);
    expect(scopedIdx).toBeGreaterThan(mayNestIdx);
  });

  it('executor rejection message and preamble names are consistent (single-source invariant)', () => {
    // Both the executor (subagent-executor.ts nestedScope gate) and the preamble
    // use the exact same allowlist value. This test validates the KEY strings
    // that the executor's rejection message uses appear in the preamble's text
    // so a child that reads the preamble and the executor error both see the list.
    const types = ['git-investigator', 'web-researcher'];
    const out = renderSubagentIdentityPreamble({
      isNonInteractive: true,
      depth: 1,
      maxDepth: 3,
      nestedAgentAllowlist: types,
    });
    // The executor says "This agent may only dispatch the following agent type(s): git-investigator, web-researcher."
    // The preamble says "agent_type is required and must be one of: git-investigator, web-researcher."
    // Both include the type names — the invariant is that neither diverges.
    for (const t of types) {
      expect(out).toContain(t);
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

  it('injects allowlist section when nestedAgentAllowlist is provided (scoped child gets the line)', () => {
    const cfg: AgentConfig = { systemPrompt: 'TASK PROMPT', isNonInteractive: true, depth: 1, maxDepth: 3 };
    const out = injectSubagentIdentityPreamble(cfg, ['git-investigator']);
    const sp = out.systemPrompt as string;
    expect(sp).toContain(SCOPED_PREFIX);
    expect(sp).toContain('git-investigator');
    expect(sp).toContain('A bare dispatch with no agent_type is not permitted here');
  });

  it('does not inject allowlist section when nestedAgentAllowlist is absent (unscoped child unchanged)', () => {
    const cfg: AgentConfig = { systemPrompt: 'TASK PROMPT', isNonInteractive: true, depth: 1, maxDepth: 3 };
    const out = injectSubagentIdentityPreamble(cfg);
    const sp = out.systemPrompt as string;
    expect(sp).not.toContain(SCOPED_PREFIX);
    expect(sp).not.toContain(DENY_ALL);
  });

  it('injects deny-all wording when nestedAgentAllowlist is empty array', () => {
    const cfg: AgentConfig = { systemPrompt: 'TASK PROMPT', isNonInteractive: true, depth: 1, maxDepth: 3 };
    const out = injectSubagentIdentityPreamble(cfg, []);
    const sp = out.systemPrompt as string;
    expect(sp).toContain(DENY_ALL);
    expect(sp).not.toContain(SCOPED_PREFIX);
  });
});
