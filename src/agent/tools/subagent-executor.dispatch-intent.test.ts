/**
 * Tests for the #3754 pre-dispatch implementation-intent gate: the classifier,
 * the agent-tool refusal, and the compose refusal.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyDispatchIntent,
  checkReadOnlyDispatchIntent,
  checkComposeReadOnlyDispatchIntent,
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
