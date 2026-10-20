/**
 * Tests for the #3754 pre-dispatch implementation-intent gate: the classifier,
 * the agent-tool refusal, and the compose refusal.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyDispatchIntent,
  checkReadOnlyDispatchIntent,
  checkComposeReadOnlyDispatchIntent,
  stripQuotedContent,
} from './subagent-executor.dispatch-intent.js';
import type { RegisteredAgent } from '../agents/types.js';

// Two real research-agent review briefs the pre-fix classifier refused
// (matched "fix commit" and "change file" respectively). Copied verbatim.
const REAL_REVIEW_BRIEF_1 = "Light review (all dimensions: security, api-compat, correctness, spec-compliance, test-coverage, perf-observability) of a small fix commit on PR #3889 in /path/to/agent-afk. Reviewed ref: 4b6babb80758ca763a511397e19c8962e893b4f2. Inputs: `.afk/land/pr-3889-r4/fix-delta.diff` (e836ee43d..4b6babb80, 237 lines) and full post-change files under `.afk/land/pr-3889-r4/files/`. Context: `.afk/land/pr-3889-r3/brief.md` and the round-3 comment `.afk/land/pr-3889-round3-comment.md`. The working tree is on a different branch: cite file-state lines from the prefetched files dir only; unchanged files may be read from src/ for reachability.\n\nStated intent (spec): close round-3 finding R3.1 — compose DAG nodes fork through the ComposeExecutor's own ephemeral managers, not the root manager, so every production surface (chat.session-setup.ts, daemon-session-factory.ts, interactive/bootstrap.ts, telegram/wire-telegram-executors.ts, web-server/session-owner.wiring.ts, and the SDK bundle in create-wired-executors.ts) must report root + compose pending billing streams so session-shutdown.ts waits for them (bounded) before the accounting snapshot. Also: remove the dead config.composeExecutor path in session-shutdown.ts; tests go through the production helpers; rerun-ownership test captures the context before the overlapping run().\n\nCheck: every surface that constructs a session with a ComposeExecutor now passes it (Grep src/ for `new ComposeExecutor` and `wireExecutors(` callers; flag any session-constructing surface still missed, e.g. farm/remote/other commands); `toggles.compose` handling in the SDK bundle is right; removing the session-shutdown compose lines drops no path that some production config relies on; dedup Set still dedups; no import cycle introduced (manager-shutdown-config.ts imported by telegram/web/create-wired-executors); tests discriminate.\n\nSeverity (impact only): critical data loss/auth/secret/RCE; high wrong output under reachable production conditions; medium same but narrow/rare; low no production impact today; nit naming. blocking defaults critical/high/medium true, low/nit false; data-integrity mediums never waivable. Absence claims: Grep first. Finding schema per line: `severity · blocking · confidence · dimension · file:line_range · ref:4b6babb · citation-type · finding · evidence (≤4 lines verbatim) · suggestion`. No file:line → omit. Banned words in findings: ensure, consider, may, could.\n\nEnd with exactly one line: `Decision: MERGE|DO NOT MERGE — <counts>`. ≤400 words. Read-only.";
const REAL_REVIEW_BRIEF_2 = "Read-only code review. Inspect and report findings only.\n\nTarget: a small change set on PR #3889 in /path/to/agent-afk, at ref 4b6babb80758ca763a511397e19c8962e893b4f2. Inputs: `.afk/land/pr-3889-r4/fix-delta.diff` (the diff e836ee43d..4b6babb80, 237 lines) and the full post-change file contents under `.afk/land/pr-3889-r4/files/`. Background: `.afk/land/pr-3889-r3/brief.md` and `.afk/land/pr-3889-round3-comment.md`. The working tree is on a different branch: cite file-state lines from the files dir; unchanged files can be read from src/ for reachability.\n\nWhat the change set is meant to do: compose DAG nodes run through the ComposeExecutor's own ephemeral managers, not the root manager, so every production surface (chat.session-setup.ts, daemon-session-factory.ts, interactive/bootstrap.ts, telegram/wire-telegram-executors.ts, web-server/session-owner.wiring.ts, and the SDK bundle in create-wired-executors.ts) should report root + compose pending billing streams, which session-shutdown.ts awaits (bounded) before the accounting snapshot. The change set also drops an unused config.composeExecutor path in session-shutdown.ts and adjusts two tests.\n\nQuestions to answer with evidence:\n1. Does every surface that builds a session with a ComposeExecutor now report its streams? Grep src/ for `new ComposeExecutor` and `wireExecutors(` callers; name any session-building surface not covered.\n2. Is the `toggles.compose` handling in the SDK bundle right?\n3. Did any production config depend on the dropped session-shutdown lines?\n4. Any import cycle from manager-shutdown-config.ts being imported by telegram/web/create-wired-executors?\n5. Do the adjusted tests discriminate?\nAlso any other security / api-compat / correctness / perf issue in the diff.\n\nSeverity (impact only): critical data loss/auth/secret/RCE; high wrong output under reachable production conditions; medium same but narrow/rare; low no production impact today; nit naming. blocking defaults: critical/high/medium true, low/nit false; data-integrity mediums are never waived. Grep before any absence claim. One finding per line: `severity · blocking · confidence · dimension · file:line_range · ref:4b6babb · citation-type · finding · evidence (≤4 lines verbatim) · suggestion`. No file:line, no finding. Avoid the words ensure, consider, may, could in findings.\n\nEnd with exactly one line: `Decision: MERGE|DO NOT MERGE — <counts>`. ≤400 words.";

// Only `name` is read by checkReadOnlyDispatchIntent; `readOnly` does not
// exist on RegisteredAgent and is never consulted — the write-capability flag
// is the separate `childWriteCapable` boolean parameter.
const reconAgent = { name: 'research-agent' } as unknown as RegisteredAgent;

describe('classifyDispatchIntent (#3754)', () => {
  describe('true positives — implementation briefs that must be rejected', () => {
    it.each([
      ['edit src/foo.ts to fix the bug', 'edit src/foo.ts'],
      ['apply the patch to the codebase', 'apply the patch'],
      ['implement the feature in the module', 'implement the feature'],
      ['fix the bug in auth.ts', 'fix the bug'],
      ['refactor the module to use the new API', 'refactor the module'],
      ['commit the changes to main', 'commit the changes'],
      ['push to main branch', 'push to main branch'],
      ['use edit_file to update the config', 'use edit_file'],
      ['call write_file with the new content', 'call write_file'],
      ['update config.ts with the new settings', 'update config.ts'],
      ['write the implementation to disk', 'write the implementation'],
      ['Read auth.ts first. Then fix the bug it contains.', 'fix the bug'],
      ['Investigate the failure and then edit src/foo.ts accordingly.', 'edit src/foo.ts'],
      ['Steps:\n- edit src/a.ts\n- run the tests', 'edit src/a.ts'],
      ['You must implement the feature described below.', 'implement the feature'],
      ['When done: commit your changes.', 'commit your changes'],
      ['commit to main', 'commit to main'],
      ['deploy to the release branch', 'deploy to the release branch'],
      ['push origin main', 'push origin main'],
    ])('detects %j (matched %j)', (prompt, matched) => {
      expect(classifyDispatchIntent(prompt)).toBe(matched);
    });
  });

  describe('false positives — recon/review briefs that must NOT be rejected', () => {
    it.each([
      'do not edit files, only report findings',
      'report what should be changed in the codebase',
      'identify which files need updating',
      'describe edits needed without making them',
      'find where the bug is but do not fix it',
      'research the codebase and return findings',
      'check if edit_file was called anywhere in the session',
      'analyse the module and describe what should change',
      '',
      'grep for TODO comments across the repo',
      'list files that need to be updated',
      'never modify the files, just audit them',
      // Review briefs: commit/fix/change as nouns, not imperatives.
      'Review the fix commit 4b6babb for correctness.',
      'Review commit 4b6babb on branch afk/pr-3889.',
      'The head commit 4b6babb pushed to the PR branch; review it.',
      'Inputs: the diff and the full post-change file contents under .afk/land/pr-3889-r4/files/',
      'Light review of a small fix commit on PR #3889.',
    ])('passes %j', (prompt) => {
      expect(classifyDispatchIntent(prompt)).toBeUndefined();
    });

    it('passes real refused review brief #1 (previously matched "fix commit")', () => {
      expect(classifyDispatchIntent(REAL_REVIEW_BRIEF_1)).toBeUndefined();
    });

    it('passes real refused review brief #2 (previously matched "change file")', () => {
      expect(classifyDispatchIntent(REAL_REVIEW_BRIEF_2)).toBeUndefined();
    });
  });

  // #3796: mixed-intent prompts — document where RECON_EXEMPTION_RE can hide genuine write intent.
  // These tests pin the current behaviour so any future regex change is visible.
  describe('mixed-intent prompts — RECON_EXEMPTION_RE boundary cases', () => {
    // Known gap: "report what changed" in the tail triggers the recon exemption even though
    // "edit the file" in the head is a clear write imperative.  Pinned as a false-negative
    // so the boundary is explicit and a future fix must update this test.
    it('[known-gap] "edit the file, then report what changed" — currently exempted (false negative)', () => {
      expect(classifyDispatchIntent('edit the file, then report what changed')).toBeUndefined();
    });

    // This one correctly rejects: "implement the fix" matches the impl pattern and
    // "describe your changes" does NOT match the recon-exemption pattern (no what/which/etc.).
    it('rejects "implement the fix and describe your changes" — implement is write intent', () => {
      expect(classifyDispatchIntent('implement the fix and describe your changes')).toBeDefined();
    });

    // Known gap: "list what you modified" triggers the recon exemption even though
    // "patch src/foo.ts" in the head is a clear write imperative.  Same category as above.
    it('[known-gap] "patch src/foo.ts … then list what you modified" — currently exempted (false negative)', () => {
      expect(classifyDispatchIntent('patch src/foo.ts to add the feature, then list what you modified')).toBeUndefined();
    });

    // Pure recon brief with negation — must continue to pass.
    it('still passes a pure recon brief that mentions verbs in negation context', () => {
      expect(classifyDispatchIntent('do not edit anything, just report what changed')).toBeUndefined();
    });
  });
});

describe('checkReadOnlyDispatchIntent (#3754)', () => {
  const alwaysImpl = (_: string): string | undefined => 'edit src/foo.ts';
  const alwaysRecon = (_: string): string | undefined => undefined;

  it('returns undefined when child is write-capable', () => {
    expect(checkReadOnlyDispatchIntent(true, reconAgent, 'edit src/foo.ts', alwaysImpl)).toBeUndefined();
  });

  it('returns undefined when child is write-capable even with no named agent', () => {
    // Isolates the childWriteCapable=true branch from the namedAgent===undefined guard.
    expect(checkReadOnlyDispatchIntent(true, undefined, 'edit src/foo.ts', alwaysImpl)).toBeUndefined();
  });

  it('returns undefined for a bare dispatch', () => {
    expect(checkReadOnlyDispatchIntent(false, undefined, 'edit src/foo.ts', alwaysImpl)).toBeUndefined();
  });

  it('returns undefined when the classifier finds no intent', () => {
    expect(checkReadOnlyDispatchIntent(false, reconAgent, 'do not edit files', alwaysRecon)).toBeUndefined();
  });

  it('refuses an impl brief and names agent, alternative, and the matched phrase', () => {
    const result = checkReadOnlyDispatchIntent(false, reconAgent, 'edit src/foo.ts', classifyDispatchIntent);
    expect(result?.isError).toBe(true);
    expect(result!.content).toContain('research-agent');
    expect(result!.content).toContain('read-only');
    expect(result!.content).toContain('general-purpose');
    expect(result!.content).toContain('patch');
    expect(result!.content).toContain('matched: "edit src/foo.ts"');
  });

  it('end-to-end: refuses tool-name pattern through the gate', () => {
    // Ensures the gate catches prompts that name a write tool directly
    // (e.g. 'use edit_file to update config') — not just verb+object patterns.
    const result = checkReadOnlyDispatchIntent(false, reconAgent, 'use edit_file to update config', classifyDispatchIntent);
    expect(result?.isError).toBe(true);
    expect(result!.content).toContain('research-agent');
    expect(result!.content).toContain('use edit_file');
  });

  it('end-to-end: passes passive and negation recon briefs', () => {
    expect(checkReadOnlyDispatchIntent(false, reconAgent, 'report what should be changed', classifyDispatchIntent)).toBeUndefined();
    expect(checkReadOnlyDispatchIntent(false, reconAgent, 'do not edit files, only report findings', classifyDispatchIntent)).toBeUndefined();
  });

  it('end-to-end: passes the real review briefs', () => {
    expect(checkReadOnlyDispatchIntent(false, reconAgent, REAL_REVIEW_BRIEF_1, classifyDispatchIntent)).toBeUndefined();
    expect(checkReadOnlyDispatchIntent(false, reconAgent, REAL_REVIEW_BRIEF_2, classifyDispatchIntent)).toBeUndefined();
  });
});

describe('checkComposeReadOnlyDispatchIntent (#3754)', () => {
  it('refuses a read-only node with an impl brief, naming node id and match', () => {
    const result = checkComposeReadOnlyDispatchIntent(
      [
        { id: 'ok', prompt: 'grep for TODOs', agent_type: 'research-agent' },
        { id: 'bad', prompt: 'implement the feature in src/a.ts', agent_type: 'research-agent' },
      ],
      [{ readOnly: true }, { readOnly: true }],
    );
    expect(result?.isError).toBe(true);
    expect(result!.content).toContain('Compose node "bad"');
    expect(result!.content).toContain('research-agent');
    expect(result!.content).toContain('matched: "implement the feature"');
  });

  it('passes write-capable named nodes and bare nodes with impl briefs', () => {
    expect(checkComposeReadOnlyDispatchIntent(
      [
        { id: 'gp', prompt: 'edit src/foo.ts', agent_type: 'general-purpose' },
        { id: 'bare', prompt: 'edit src/foo.ts' },
      ],
      [{}, {}],
    )).toBeUndefined();
  });

  it('passes a read-only node with a review brief', () => {
    expect(checkComposeReadOnlyDispatchIntent(
      [{ id: 'r', prompt: REAL_REVIEW_BRIEF_1, agent_type: 'research-agent' }],
      [{ readOnly: true }],
    )).toBeUndefined();
  });

  it('RECON_EXEMPTION_RE: negation phrases exempt a read-only node that would otherwise match', () => {
    // "fix the bug" clause-starts and matches Pattern 2; "do not fix it" negates via RECON_EXEMPTION_RE.
    // Verify the exemption is load-bearing: without RECON_EXEMPTION_RE this prompt would be refused.
    expect(checkComposeReadOnlyDispatchIntent(
      [{ id: 'n', prompt: 'Read auth.ts. Fix the bug you find, but do not commit it.', agent_type: 'research-agent' }],
      [{ readOnly: true }],
    )).toBeUndefined();
    // "fix the bug" matched via "then" connector (CLAUSE_LEAD); "don't fix" negates.
    expect(checkComposeReadOnlyDispatchIntent(
      [{ id: 'n2', prompt: 'Read the code, then fix the bug — but do not commit the fix.', agent_type: 'research-agent' }],
      [{ readOnly: true }],
    )).toBeUndefined();
  });

  it('RECON_EXEMPTION_RE: passive recon phrases exempt a read-only node that would otherwise match', () => {
    // "implement the feature" matches Pattern 2 at sentence start; "describe what" triggers passive branch.
    expect(checkComposeReadOnlyDispatchIntent(
      [{ id: 'p', prompt: 'Inspect the module. Implement the feature. Describe what the changes do.', agent_type: 'research-agent' }],
      [{ readOnly: true }],
    )).toBeUndefined();
    // "implement the feature" via "you must" connector; "identify which" triggers passive branch.
    expect(checkComposeReadOnlyDispatchIntent(
      [{ id: 'p2', prompt: 'You must implement the feature; identify which files are affected without editing them.', agent_type: 'research-agent' }],
      [{ readOnly: true }],
    )).toBeUndefined();
  });

  it('RECON_EXEMPTION_RE: exemption does not fire when no impl pattern matches (early-exit path)', () => {
    // Prompt contains a negation phrase but no impl pattern matches at a clause boundary,
    // so classifyDispatchIntent returns undefined before RECON_EXEMPTION_RE is evaluated.
    // The node must be allowed through (undefined), confirming the early-exit is correct.
    expect(checkComposeReadOnlyDispatchIntent(
      [{ id: 'e', prompt: 'do not edit files, only report findings', agent_type: 'research-agent' }],
      [{ readOnly: true }],
    )).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #4057 — stripQuotedContent + quoted-verb exemption
// ---------------------------------------------------------------------------

describe('stripQuotedContent (#4057)', () => {
  it('strips fenced code blocks (backtick fence)', () => {
    const s = stripQuotedContent('before\n```\nedit src/foo.ts\n```\nafter');
    expect(s).not.toContain('edit src/foo.ts');
    expect(s).toContain('before');
    expect(s).toContain('after');
  });

  it('strips fenced code blocks (tilde fence)', () => {
    const s = stripQuotedContent('before\n~~~\nfix the bug\n~~~\nafter');
    expect(s).not.toContain('fix the bug');
  });

  it('strips inline code spans', () => {
    const s = stripQuotedContent('run `edit src/foo.ts` to see');
    expect(s).not.toContain('edit src/foo.ts');
    expect(s).toContain('run');
    expect(s).toContain('to see');
  });

  it('strips markdown blockquote lines', () => {
    const s = stripQuotedContent('context:\n> edit git-investigator.md\nrank these');
    expect(s).not.toContain('edit git-investigator.md');
    expect(s).toContain('context');
    expect(s).toContain('rank these');
  });

  it('strips double-quoted strings (balanced)', () => {
    const s = stripQuotedContent('the proposal was "edit git-investigator.md directly" — rank it');
    expect(s).not.toContain('edit git-investigator.md directly');
    expect(s).toContain('rank it');
  });

  it('strips attributed list items (the #4057 exact repro shape)', () => {
    const s = stripQuotedContent('- pragmatist (medium): edit git-investigator.md directly');
    expect(s).not.toContain('edit git-investigator.md');
  });

  it('does NOT strip an unbalanced backtick (fails closed)', () => {
    // A prompt that opens a code span but never closes it must leave the
    // content in place so a real instruction cannot hide behind it.
    const s = stripQuotedContent('please `edit src/foo.ts and keep going');
    expect(s).toContain('edit src/foo.ts');
  });

  it('does NOT strip an unbalanced double-quote (fails closed)', () => {
    const s = stripQuotedContent('the plan is "edit src/foo.ts and keep going');
    expect(s).toContain('edit src/foo.ts');
  });

  it('does NOT strip a plain bullet with no label: colon pattern', () => {
    // A genuine imperative bullet like "- edit src/foo.ts" must NOT be stripped
    // because it IS addressed to the dispatched agent.
    const s = stripQuotedContent('- edit src/foo.ts');
    expect(s).toContain('edit src/foo.ts');
  });

  // --- #4101 regression: overly-broad label pattern must not strip labelled imperatives ---

  it('does NOT strip a numbered-step bullet (- Step 1: ...)', () => {
    // "Step 1" is a procedural label, not a critic-name+severity — must stay.
    const s = stripQuotedContent('- Step 1: edit src/a.ts');
    expect(s).toContain('edit src/a.ts');
  });

  it('does NOT strip a bare capitalised-word label with no severity (- Fix: ...)', () => {
    // "Fix" has no parenthesised severity — the label pattern must not match it.
    const s = stripQuotedContent('- Fix: rewrite the handler');
    expect(s).toContain('rewrite the handler');
  });

  it('does NOT strip a bare task label with no severity (- Task: ...)', () => {
    const s = stripQuotedContent('- Task: implement the parser');
    expect(s).toContain('implement the parser');
  });

  it('does NOT strip a cross-line sequence where \\s spanning newline caused a false match', () => {
    // The old [\w\s] label matched across the newline in
    // "- inspect the context\nTask: edit src/foo.ts", swallowing both lines.
    // With [ \t] the match cannot cross the newline, so the second line survives.
    const s = stripQuotedContent('- inspect the context\nTask: edit src/foo.ts');
    expect(s).toContain('edit src/foo.ts');
  });

  it('still strips attributed critic items that have the severity paren (pragmatist/paranoid/etc.)', () => {
    // Positive-control: the narrowed pattern must still strip the exact #4057 shapes.
    expect(stripQuotedContent('- pragmatist (medium): edit git-investigator.md')).not.toContain('edit git-investigator.md');
    expect(stripQuotedContent('- paranoid (high): patch the config')).not.toContain('patch the config');
    expect(stripQuotedContent('- architect (low): refactor the module')).not.toContain('refactor the module');
    expect(stripQuotedContent('- steelman (critical): rewrite the handler')).not.toContain('rewrite the handler');
  });
});

describe('classifyDispatchIntent — #4057 quoted-verb exemptions', () => {
  // --- Exact repro from the issue ---
  it('passes: attributed list item with edit verb (exact #4057 repro)', () => {
    const prompt =
      'Here are the critic proposals:\n' +
      '- pragmatist (medium): edit git-investigator.md directly to add context\n' +
      '- contrarian (high): rewrite the approach entirely\n\n' +
      'Please rank these options by feasibility.';
    expect(classifyDispatchIntent(prompt)).toBeUndefined();
  });

  // --- Fenced code block ---
  it('passes: write verb inside a fenced code block', () => {
    const prompt =
      'Review the following patch:\n' +
      '```diff\n' +
      '- edit src/auth.ts to add the guard\n' +
      '```\n' +
      'Tell me if it looks correct.';
    expect(classifyDispatchIntent(prompt)).toBeUndefined();
  });

  // --- Inline code span ---
  it('passes: write verb inside an inline code span', () => {
    expect(classifyDispatchIntent('The critic suggested `edit git-investigator.md` — rank the options.')).toBeUndefined();
  });

  // --- Blockquote line ---
  it('passes: write verb on a markdown blockquote line', () => {
    const prompt = 'Previous agent said:\n> edit git-investigator.md directly\nPlease rank the options.';
    expect(classifyDispatchIntent(prompt)).toBeUndefined();
  });

  // --- Double-quoted string ---
  it('passes: write verb inside a double-quoted string', () => {
    expect(classifyDispatchIntent('Critic A proposed "edit git-investigator.md" — synthesise and rank.')).toBeUndefined();
  });

  // --- /devils-advocate synthesis shape ---
  it('passes: devils-advocate synthesis prompt with attributed critic lines', () => {
    const prompt =
      'Three critics evaluated the approach:\n' +
      '- pragmatist (medium): edit git-investigator.md directly\n' +
      '- paranoid (high): patch the config to add a guard\n' +
      '- architect (low): refactor the module entirely\n\n' +
      'Rank these by safety and feasibility. Return findings only.';
    expect(classifyDispatchIntent(prompt)).toBeUndefined();
  });

  // --- Genuine imperatives outside quotes must still be refused ---
  it('still refuses: genuine imperative edit verb outside any quoted region', () => {
    expect(classifyDispatchIntent('edit git-investigator.md directly')).toBeDefined();
  });

  it('still refuses: edit verb after bullet with no label:colon', () => {
    // Plain bullet "- edit src/a.ts" is a genuine directive, not attributed.
    expect(classifyDispatchIntent('Steps:\n- edit src/a.ts\n- run the tests')).toBeDefined();
  });

  it('still refuses: genuine imperative after attributed list items', () => {
    // The attributed lines are stripped but the plain imperative at the end is not.
    const prompt =
      '- pragmatist (medium): edit git-investigator.md\n' +
      '- contrarian (high): patch the config\n\n' +
      'Now implement the feature described above.';
    expect(classifyDispatchIntent(prompt)).toBeDefined();
  });

  // --- Adversarial: unbalanced delimiters must NOT hide real instructions ---
  //
  // Inline code spans (`...`) and double-quoted strings ("...") are only
  // stripped when the closing delimiter is present on the same line.  A quote
  // character that sits BETWEEN the clause-lead position and the write verb
  // naturally breaks CLAUSE_LEAD matching regardless of balance, so those
  // shapes are protected by the pattern structure rather than by the stripper.
  // The stripQuotedContent unit tests above verify the "fails closed" invariant
  // for the stripping logic directly.
  //
  // Fenced code blocks DO permit CLAUSE_LEAD to fire via the `\n` anchor inside
  // the block, so an unclosed fence is the meaningful adversarial case:
  it('still refuses: unclosed fenced block does not hide a real instruction', () => {
    // No closing ``` — stripQuotedContent leaves the block in place.
    // The verb sits on its own line so CLAUSE_LEAD fires via the \n branch.
    const prompt = 'Review this:\n```\nedit src/foo.ts\ndo the work';
    expect(classifyDispatchIntent(prompt)).toBeDefined();
  });

  // --- #4101 regression: labelled-step/fix/task bullets must not bypass the gate ---

  it('still refuses: numbered-step bullet (- Step 1: edit src/a.ts)', () => {
    // "Step 1:" is a procedural step label. The imperative edit verb must still
    // be detected after the narrowed strip no longer swallows this line.
    expect(classifyDispatchIntent('- Step 1: edit src/a.ts')).toBeDefined();
  });

  it('still refuses: bare Fix label (- Fix: rewrite the handler)', () => {
    // "Fix:" has no parenthesised severity, so the attributed-label strip must
    // not remove this line. The write verb must be detected by the classifier.
    expect(classifyDispatchIntent('- Fix: rewrite the handler')).toBeDefined();
  });

  it('still refuses: bare Task label (- Task: implement the parser)', () => {
    expect(classifyDispatchIntent('- Task: implement the parser')).toBeDefined();
  });

  it('still refuses: cross-line shape (- inspect the context\\nTask: edit src/foo.ts)', () => {
    // Exact example from spec: the old regex matched across the newline via \s,
    // stripping both lines and hiding the real directive on the second line.
    // With [ \t] the cross-line match is impossible; the second line is retained
    // and the classifier detects the edit verb via the colon branch of CLAUSE_LEAD.
    expect(classifyDispatchIntent('- inspect the context\nTask: edit src/foo.ts')).toBeDefined();
  });
});
