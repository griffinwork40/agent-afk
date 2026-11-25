import { describe, expect, it } from 'vitest';
import { classifyCommandRisk } from './command-classifier.risk.js';
import type { MutationVerdict } from './command-classifier.js';

// Minimal stubs — these tests focus on risk level, not mutation or tokenization.
const noMutation = (): MutationVerdict => ({ mutating: false });
const noTokenize = (_view: string) => [] as readonly (readonly string[])[];

describe('classifyCommandRisk -- compound rm + other BASH_HIGH pattern (Item 1)', () => {
  it('ephemeral rm followed by chmod keeps HIGH (compound: ephemeral rm + chmod)', () => {
    // rm /tmp/a would normally downgrade to medium via classifyRmRisk, but
    // chmod is also in BASH_HIGH — the whole command must stay HIGH.
    expect(
      classifyCommandRisk('rm /tmp/a; chmod 777 /x', noMutation, noTokenize).level,
    ).toBe('high');
  });

  it('ephemeral rm alone downgrades to medium (baseline)', () => {
    expect(
      classifyCommandRisk('rm /tmp/stale.json', noMutation, noTokenize).level,
    ).toBe('medium');
  });

  it('ephemeral rm followed by eval keeps HIGH', () => {
    expect(
      classifyCommandRisk('rm /tmp/a; eval "$CMD"', noMutation, noTokenize).level,
    ).toBe('high');
  });

  it('ephemeral rm followed by sudo keeps HIGH', () => {
    expect(
      classifyCommandRisk('rm /tmp/a && sudo reboot', noMutation, noTokenize).level,
    ).toBe('high');
  });
});
