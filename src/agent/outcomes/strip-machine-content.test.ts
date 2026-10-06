/**
 * Unit tests for stripMachineContent — verifies that machine-injected harness
 * content is stripped from user turns before correction-keyword detection, while
 * genuine human-typed text is preserved.
 *
 * All tests are pure — no I/O, no filesystem access.
 */

import { describe, it, expect } from 'vitest';
import { stripMachineContent, lfInSessionCorrection } from './lf-immediate.js';
import type { Turn } from './artifacts.js';

// ---------------------------------------------------------------------------
// stripMachineContent
// ---------------------------------------------------------------------------

describe('stripMachineContent', () => {
  it('returns plain human text unchanged', () => {
    const text = 'No, that is wrong. Please revert.';
    expect(stripMachineContent(text)).toBe(text);
  });

  it('strips <peer-session-message> blocks', () => {
    const text = '<peer-session-message from="sess-a" id="1">please rebase</peer-session-message>\nActually, let us proceed.';
    const result = stripMachineContent(text);
    expect(result).not.toContain('<peer-session-message');
    expect(result).not.toContain('please rebase');
    expect(result).toContain('Actually, let us proceed.');
  });

  it('strips <background-subagent-result> blocks', () => {
    const text = '<background-subagent-result jobId="j1" status="completed"><task>some task</task><output>some output</output></background-subagent-result>\nDone, thanks.';
    const result = stripMachineContent(text);
    expect(result).not.toContain('background-subagent-result');
    expect(result).not.toContain('some task');
    expect(result).toContain('Done, thanks.');
  });

  it('strips <command-name> blocks', () => {
    const text = '<command-name>ground-state</command-name>\nNow fix the issue.';
    const result = stripMachineContent(text);
    expect(result).not.toContain('<command-name>');
    expect(result).toContain('Now fix the issue.');
  });

  it('strips <bash-passthrough> blocks', () => {
    const text = '<bash-passthrough mode="foreground" exit="0"><command>ls</command><output>file.ts</output></bash-passthrough>\nLooks good.';
    const result = stripMachineContent(text);
    expect(result).not.toContain('bash-passthrough');
    expect(result).toContain('Looks good.');
  });

  it('strips [jev rules] bracketed preamble lines', () => {
    const text = '[jev rules]: always return calibrated probabilities\nPlease summarize.';
    const result = stripMachineContent(text);
    expect(result).not.toContain('[jev rules]');
    expect(result).toContain('Please summarize.');
  });

  it('strips [memory: ...] lines', () => {
    const text = '[memory: user prefers concise output]\nWhat changed?';
    const result = stripMachineContent(text);
    expect(result).not.toContain('[memory:');
    expect(result).toContain('What changed?');
  });

  it('strips [bridge: ...] lines', () => {
    const text = '[bridge: session123] forwarded message\nSomething went wrong.';
    const result = stripMachineContent(text);
    expect(result).not.toContain('[bridge:');
    expect(result).toContain('Something went wrong.');
  });

  it('strips [placeholder-prevent] lines', () => {
    const text = '[placeholder-prevent]\nOkay, continue.';
    const result = stripMachineContent(text);
    expect(result).not.toContain('[placeholder-prevent]');
    expect(result).toContain('Okay, continue.');
  });

  it('returns empty string when entire turn is machine content', () => {
    const text = '<peer-session-message from="x" id="2">do something</peer-session-message>';
    expect(stripMachineContent(text)).toBe('');
  });

  it('preserves human text after machine block', () => {
    const machineAndHuman = [
      '<peer-session-message from="sess-a" id="1">relay</peer-session-message>',
      'No, that is not right.',
    ].join('\n');
    const result = stripMachineContent(machineAndHuman);
    expect(result).toContain('No, that is not right.');
    expect(result).not.toContain('sess-a');
  });

  it('does not strip normal sentence-embedded brackets like [1] citations', () => {
    // [1] is a short citation — the pattern requires at least one letter after [
    const text = 'See reference [1] for details.';
    // Note: this should NOT be stripped since [1] doesn't match [a-z][a-z0-9 _:-]*
    // Our pattern starts with [a-z], so numeric-only refs like [1] are safe
    const result = stripMachineContent(text);
    expect(result).toContain('[1]');
  });
});

// ---------------------------------------------------------------------------
// lfInSessionCorrection + machine content
// ---------------------------------------------------------------------------

describe('lfInSessionCorrection with machine-injected content', () => {
  const now = '2024-01-01T00:00:00.000Z';

  function makeTurns(userTexts: string[]): Turn[] {
    return userTexts.map((user) => ({ user }));
  }

  it('returns null when correction language is only in injected content', () => {
    const turns = makeTurns([
      'Please build the feature.',
      '<peer-session-message from="x" id="1">No, revert that.</peer-session-message>',
    ]);
    const vote = lfInSessionCorrection(turns, now);
    expect(vote).toBeNull();
  });

  it('returns vote when human correction follows injected content', () => {
    const turns = makeTurns([
      'Build the feature.',
      '<peer-session-message from="x" id="1">relay</peer-session-message>\nNo, that is wrong.',
    ]);
    const vote = lfInSessionCorrection(turns, now);
    expect(vote).not.toBeNull();
    expect(vote?.lf).toBe('in_session_correction');
  });

  it('skips turns that are entirely machine content', () => {
    const turns = makeTurns([
      'Start the task.',
      '[jev rules]: use calibrated priors\n[memory: user name is Griffin]',
      'No, actually revert.',
    ]);
    // Turn 1 (index 1) is all machine — skipped
    // Turn 2 (index 2) has correction language — should fire
    const vote = lfInSessionCorrection(turns, now);
    expect(vote).not.toBeNull();
    expect(vote?.lf).toBe('in_session_correction');
  });

  it('correctly detects human correction without machine content', () => {
    const turns = makeTurns([
      'Fix the bug.',
      'No, that is still broken.',
    ]);
    const vote = lfInSessionCorrection(turns, now);
    expect(vote).not.toBeNull();
  });

  it('first turn (original task) is excluded even with correction keywords', () => {
    const turns = makeTurns(['No, this is wrong. Fix it.']);
    const vote = lfInSessionCorrection(turns, now);
    expect(vote).toBeNull();
  });

  it('returns severity minor', () => {
    const turns = makeTurns([
      'Do something.',
      'No, that is not right.',
    ]);
    const vote = lfInSessionCorrection(turns, now);
    expect(vote?.severity).toBe('minor');
  });
});

// ---------------------------------------------------------------------------
// Finding #5: MACHINE_BLOCK_PATTERNS must not strip human text like [please fix]
// ---------------------------------------------------------------------------

describe('stripMachineContent – bracket pattern does not strip human text (finding #5)', () => {
  it('does NOT strip [please fix] — plain human correction text', () => {
    const text = '[please fix] the auth module\nThis is broken.';
    const result = stripMachineContent(text);
    expect(result).toContain('[please fix]');
    expect(result).toContain('This is broken.');
  });

  it('does NOT strip [note] — common human bracket usage', () => {
    const text = '[note] please review this section carefully';
    const result = stripMachineContent(text);
    expect(result).toContain('[note]');
  });

  it('does NOT strip [TODO] style human markers (uppercase — pattern is case-sensitive start)', () => {
    // The pattern starts with [a-z] — uppercase brackets are not stripped regardless
    const text = '[TODO] implement the missing handler';
    const result = stripMachineContent(text);
    expect(result).toContain('[TODO]');
  });

  it('DOES strip [memory: ...] lines (internal colon)', () => {
    const text = '[memory: user prefers verbose output]\nThen do this.';
    const result = stripMachineContent(text);
    expect(result).not.toContain('[memory:');
    expect(result).toContain('Then do this.');
  });

  it('DOES strip [jev rules]: lines (external colon)', () => {
    const text = '[jev rules]: always return calibrated probabilities\nPlease proceed.';
    const result = stripMachineContent(text);
    expect(result).not.toContain('[jev rules]');
    expect(result).toContain('Please proceed.');
  });

  it('DOES strip [placeholder-prevent] (hyphenated label)', () => {
    const text = '[placeholder-prevent]\nContinue.';
    const result = stripMachineContent(text);
    expect(result).not.toContain('[placeholder-prevent]');
    expect(result).toContain('Continue.');
  });

  it('does NOT strip two-word human phrases with no colon or hyphen: [my note]', () => {
    const text = '[my note] this was tricky to debug';
    const result = stripMachineContent(text);
    // [my note] has no colon and no hyphen → should NOT be stripped
    expect(result).toContain('[my note]');
  });

  it('does NOT vote on correction when human text [please fix] is NOT stripped and has no correction keywords', () => {
    // Confirm that [please fix] is preserved AND that lfInSessionCorrection does NOT
    // falsely fire solely because of the bracket content (no correction keywords present).
    const now = '2024-01-01T00:00:00.000Z';
    function makeTurns(userTexts: string[]): Array<{ user: string }> {
      return userTexts.map((user) => ({ user }));
    }

    // [please fix] the output — no correction keywords present, so no vote
    const turns = makeTurns([
      'Do the task.',
      '[please fix] the output',
    ]);
    const vote = lfInSessionCorrection(turns, now);
    // Before fix: [please fix] would have been stripped → empty turn → skipped → no vote.
    // After fix: [please fix] is preserved; since the remaining text has no correction
    // keywords, lfInSessionCorrection still returns null (correct).
    expect(vote).toBeNull();
  });

  it('detects correction keywords in human text that was NOT stripped', () => {
    // With the fix, [please fix] is no longer stripped. If the human turn ALSO
    // contains correction language, lfInSessionCorrection should detect it.
    const now = '2024-01-01T00:00:00.000Z';
    function makeTurns(userTexts: string[]): Array<{ user: string }> {
      return userTexts.map((user) => ({ user }));
    }

    // "No, [please fix]..." starts with "No," which matches the correction pattern
    const turns = makeTurns([
      'Do the task.',
      'No, [please fix] this — it is wrong.',
    ]);
    const vote = lfInSessionCorrection(turns, now);
    // "No," at the start of the message matches CORRECTION_PATTERNS[0]
    expect(vote).not.toBeNull();
    expect(vote?.lf).toBe('in_session_correction');
  });
});
