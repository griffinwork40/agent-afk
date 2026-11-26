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

// ---------------------------------------------------------------------------
// Spec item 4 — separator-evasion shapes keep HIGH after ephemeral rm
// (#5330 regression)
//
// classifyRmRisk returns 'medium' only when hasShellSeparator() is false
// (no ;, |, &, or \n). Any compound command — including separator-evasion
// shapes like `eval<TAB>` or `eval"$x"` — contains a semicolon before the
// eval token and therefore hits the separator rule in classifyRmRisk, which
// returns 'high' before the downgrade path is ever considered.
// ---------------------------------------------------------------------------
describe('classifyCommandRisk -- separator-evasion after ephemeral rm (Item 4)', () => {
  it('ephemeral rm then eval<TAB> keeps HIGH (semicolon triggers separator rule)', () => {
    expect(
      classifyCommandRisk('rm /tmp/a; eval\t"$CMD"', noMutation, noTokenize).level,
    ).toBe('high');
  });

  it('ephemeral rm then eval"$x" (no space) keeps HIGH (quote separator evasion)', () => {
    expect(
      classifyCommandRisk('rm /tmp/a; eval"$CMD"', noMutation, noTokenize).level,
    ).toBe('high');
  });

  it('ephemeral rm then RM<TAB> (uppercase rm, tab) keeps HIGH', () => {
    // RM (uppercase) with tab separator is covered by SEPARATOR_EVASION.
    expect(
      classifyCommandRisk('rm /tmp/a; RM\t/etc/hosts', noMutation, noTokenize).level,
    ).toBe('high');
  });

  it('ephemeral rm then grm (GNU rm prefix) keeps HIGH', () => {
    // grm is in BASH_HIGH at index 80 — Pass A matchesAtWordStart catches it.
    expect(
      classifyCommandRisk('rm /tmp/a; grm /etc/hosts', noMutation, noTokenize).level,
    ).toBe('high');
  });

  // Baseline: compound rm (separator present) is HIGH regardless of the
  // second segment — classifyRmRisk returns 'high' for any command containing
  // a shell separator, so the downgrade path is never reached.
  it('compound rm (rm /tmp/a; echo done) is HIGH (conservative compound policy)', () => {
    expect(
      classifyCommandRisk('rm /tmp/a; echo done', noMutation, noTokenize).level,
    ).toBe('high');
  });
});
