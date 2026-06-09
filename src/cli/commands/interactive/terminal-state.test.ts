/**
 * Tests for the terminal-state parser.
 *
 * The parser sits at the heart of the verdict surface: misclassifying a
 * chatty turn as terminal would put a wrong-state card on screen, and
 * misclassifying a terminal turn as chatty would silently drop the very
 * signal AFK's prompt was designed to produce. These tests pin the
 * conservative-but-format-tolerant behaviour the renderer relies on.
 */

import { describe, it, expect } from 'vitest';
import { parseTerminalState } from './terminal-state.js';

describe('parseTerminalState — recognition', () => {
  it('returns null on empty input', () => {
    expect(parseTerminalState('')).toBeNull();
    expect(parseTerminalState('   \n  \n')).toBeNull();
  });

  it('returns null when no terminal heading is present', () => {
    const text = `I read three files and considered the options.\n\nIt looks like the bug is in line 42.`;
    expect(parseTerminalState(text)).toBeNull();
  });

  it('recognizes a plain "Done" heading at the tail', () => {
    const text = `I read the file.\n\nDone\n- What was done: fixed the typo\n- Evidence: tests pass`;
    const v = parseTerminalState(text);
    expect(v?.kind).toBe('done');
    expect(v?.whatWasDone).toBe('fixed the typo');
    expect(v?.evidence).toBe('tests pass');
  });

  it('recognizes a bold "**Done**" heading', () => {
    const text = `prose\n\n**Done**\n- What was done: shipped feature X`;
    expect(parseTerminalState(text)?.kind).toBe('done');
  });

  it('recognizes a markdown "### Done" heading', () => {
    const text = `prose\n\n### Done\n- What was done: shipped`;
    expect(parseTerminalState(text)?.kind).toBe('done');
  });

  it('recognizes "Done." with trailing punctuation', () => {
    const text = `prose\n\nDone.\nFinished the work.`;
    expect(parseTerminalState(text)?.kind).toBe('done');
  });

  it('recognizes Blocked', () => {
    const text = `prose\n\nBlocked\n- What blocks: missing API key\n- Unblock: set ANTHROPIC_API_KEY`;
    const v = parseTerminalState(text);
    expect(v?.kind).toBe('blocked');
    expect(v?.whatBlocks).toBe('missing API key');
    expect(v?.unblockCondition).toBe('set ANTHROPIC_API_KEY');
  });

  it('recognizes Asking', () => {
    const text = `prose\n\nAsking\n- Question: which branch should I push to?\n- Resolves: deploy target`;
    const v = parseTerminalState(text);
    expect(v?.kind).toBe('asking');
    expect(v?.question).toBe('which branch should I push to?');
    expect(v?.assumption).toBe('deploy target');
  });

  it('recognizes Interrupted', () => {
    const text = `prose\n\nInterrupted\n- What you were doing: running the test suite\n- State saved: in /tmp/afk-resume.json`;
    const v = parseTerminalState(text);
    expect(v?.kind).toBe('interrupted');
    expect(v?.whatWasInProgress).toBe('running the test suite');
    expect(v?.stateLocation).toBe('in /tmp/afk-resume.json');
  });

  it('does NOT match keyword appearing mid-sentence in body', () => {
    // A long body line containing "done" must not be treated as a heading.
    const text = `I'm done with the analysis and now I need to write the code.\nMore prose follows after this line.`;
    expect(parseTerminalState(text)).toBeNull();
  });

  it('does NOT match a long line that happens to start with the keyword', () => {
    const text = `prose\n\nDone with all the things and feeling great about it today.`;
    // The keyword line is too long to be a heading.
    expect(parseTerminalState(text)).toBeNull();
  });

  it('matches the LAST terminal heading when multiple appear', () => {
    // The prompt commands the terminal state to be the final element. If
    // an earlier turn-summary contains "Done", we still want the latest.
    const text = `Done\n- earlier work\n\nMore work happened.\n\nBlocked\n- What blocks: a thing`;
    expect(parseTerminalState(text)?.kind).toBe('blocked');
  });

  it('captures rawBody even when no labelled bullets matched', () => {
    const text = `prose\n\nDone\nFinished everything successfully.`;
    const v = parseTerminalState(text);
    expect(v?.kind).toBe('done');
    expect(v?.whatWasDone).toBeUndefined();
    expect(v?.rawBody).toBe('Finished everything successfully.');
  });
});

describe('parseTerminalState — bullet field mapping', () => {
  it('done: maps "What was done", "Evidence", "Deferred" via substring match', () => {
    const text = `prose\n\nDone\n- What was done: built the parser\n- Evidence that exists: see tests/parse.test.ts\n- Pending: integrate with renderer`;
    const v = parseTerminalState(text);
    expect(v?.whatWasDone).toBe('built the parser');
    expect(v?.evidence).toBe('see tests/parse.test.ts');
    expect(v?.deferred).toBe('integrate with renderer');
  });

  it('blocked: maps fields, tolerant of label drift', () => {
    const text = `prose\n\nBlocked\n- Blocker: API down\n- To unblock: wait or retry\n- Already done: scoped the change`;
    const v = parseTerminalState(text);
    expect(v?.whatBlocks).toBe('API down');
    expect(v?.unblockCondition).toBe('wait or retry');
    expect(v?.alreadyDone).toBe('scoped the change');
  });

  it('asking: maps the question and the assumption it resolves', () => {
    const text = `prose\n\nAsking\n- Precise question: keep or delete?\n- Assumption: file is no longer used\n- After answered: I will remove or archive accordingly`;
    const v = parseTerminalState(text);
    expect(v?.question).toBe('keep or delete?');
    expect(v?.assumption).toBe('file is no longer used');
    expect(v?.followup).toBe('I will remove or archive accordingly');
  });

  it('interrupted: maps progress, location, and resume', () => {
    const text = `prose\n\nInterrupted\n- In progress: writing tests\n- State saved at: branch foo-wip\n- Resumption requires: re-running the failed test`;
    const v = parseTerminalState(text);
    expect(v?.whatWasInProgress).toBe('writing tests');
    expect(v?.stateLocation).toBe('branch foo-wip');
    expect(v?.resumeRequires).toBe('re-running the failed test');
  });

  it('handles bullet continuation across two lines', () => {
    const text = `prose\n\nDone\n- What was done: shipped a long-running\n  feature with parts A, B, and C`;
    const v = parseTerminalState(text);
    expect(v?.whatWasDone).toBe('shipped a long-running feature with parts A, B, and C');
  });

  it('handles asterisk and unicode bullet markers', () => {
    const text = `prose\n\nDone\n* What was done: thing one\n• Evidence: thing two`;
    const v = parseTerminalState(text);
    expect(v?.whatWasDone).toBe('thing one');
    expect(v?.evidence).toBe('thing two');
  });

  // Regression: models emit `**Label:** value`, putting the colon inside the
  // bold span. The split stranded the closing `**` at the head of the value,
  // leaking a literal `**` into the card and the ledger rail.
  it('strips orphaned bold markers from labels and values (**Label:** form)', () => {
    const text = `prose\n\nDone\n- **What was done:** built the parser\n- **Evidence:** see tests/parse.test.ts\n- **Deferred:** integrate with renderer`;
    const v = parseTerminalState(text);
    expect(v?.whatWasDone).toBe('built the parser');
    expect(v?.evidence).toBe('see tests/parse.test.ts');
    expect(v?.deferred).toBe('integrate with renderer');
    expect(v?.whatWasDone).not.toContain('**');
    expect(v?.evidence).not.toContain('**');
  });

  it('preserves balanced bold and globs/paths inside values', () => {
    const text = `prose\n\nDone\n- What was done: touched **all** of src/**/*.ts\n- Evidence: see __init__ wiring`;
    const v = parseTerminalState(text);
    // A balanced `**all**` and a glob `src/**/*.ts` (no space after `**`) must
    // survive the orphaned-marker strip untouched.
    expect(v?.whatWasDone).toBe('touched **all** of src/**/*.ts');
    expect(v?.evidence).toBe('see __init__ wiring');
  });
});

describe('parseTerminalState — tail-anchored window', () => {
  it('ignores a terminal-looking heading buried far above the tail', () => {
    // Heading is ~50 lines above the end; well outside the 40-line window.
    const filler = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const text = `Done\n- What was done: old work\n${filler}\n\nThis is just chatty prose at the end.`;
    expect(parseTerminalState(text)).toBeNull();
  });

  it('still finds the heading when within the tail window', () => {
    const filler = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const text = `Done\n- What was done: built it\n${filler}`;
    // Buried 10 lines deep, still within the 40-line tail.
    expect(parseTerminalState(text)?.kind).toBe('done');
  });
});
