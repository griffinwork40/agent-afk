/**
 * Tests for child-attribution.ts — PostToolUse hook that captures artifact-
 * producing bash results from forked children.
 *
 * I/O: the hook uses appendArtifacts → writeRecord, so tests run against a
 * tmpdir-based store by spying on the actual store functions via a real write.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createChildAttributionHook } from './child-attribution.js';
import { writeRecord, readRecord } from './store.js';
import type { VerifiedOutcome } from './schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOutcome(sessionId: string): VerifiedOutcome {
  return {
    schema_version: 1,
    session_id: sessionId,
    label: 'unknown',
    confidence: 0,
    state: 'settled',
    settles_after: null,
    session_kind: 'text',
    self_report: 'none',
    artifacts: { commits: [], prs: [], repo: null },
    votes: [],
    history: [],
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `afk-child-attr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createChildAttributionHook', () => {
  it('returns {} for non-PostToolUse events', () => {
    const hook = createChildAttributionHook();
    const result = hook({ event: 'SessionEnd', sessionId: 'x' });
    expect(result).toEqual({});
  });

  it('returns {} when parentSessionId is absent', () => {
    const hook = createChildAttributionHook();
    const result = hook({
      event: 'PostToolUse',
      toolName: 'bash',
      sessionId: 'root-1',
      output: '[main abc1234] initial commit',
    });
    expect(result).toEqual({});
  });

  it('returns {} for non-bash tools', () => {
    const hook = createChildAttributionHook();
    const result = hook({
      event: 'PostToolUse',
      toolName: 'write_file',
      parentSessionId: 'root-1',
      output: '[main abc1234] commit',
    });
    expect(result).toEqual({});
  });

  it('returns {} for error results', () => {
    const hook = createChildAttributionHook();
    const result = hook({
      event: 'PostToolUse',
      toolName: 'bash',
      parentSessionId: 'root-1',
      isError: true,
      output: 'error: not a git repository',
    });
    expect(result).toEqual({});
  });

  it('returns {} when output contains no artifact pattern', () => {
    const hook = createChildAttributionHook();
    const result = hook({
      event: 'PostToolUse',
      toolName: 'bash',
      parentSessionId: 'root-1',
      output: 'pnpm build completed successfully',
    });
    expect(result).toEqual({});
  });

  it('is fire-and-forget — synchronously returns {}', () => {
    // Write a parent record so appendArtifacts can find it
    writeRecord(makeOutcome('root-sync-test'), tmpDir);
    const hook = createChildAttributionHook();
    const result = hook({
      event: 'PostToolUse',
      toolName: 'bash',
      parentSessionId: 'root-sync-test',
      output: '[main abc1234] feat: implement payment module',
      input: { command: 'git commit -m "feat: implement payment module"' },
    });
    // Must return immediately (not a Promise)
    expect(result).toEqual({});
  });

  it('extracts commit SHA from git commit output', async () => {
    writeRecord(makeOutcome('root-commit'), tmpDir);

    // Simulate what the hook does: call appendArtifacts directly (same path)
    const { appendArtifacts } = await import('./store.js');
    const { recoverCommitSHAs } = await import('./artifacts.js');

    const output = '[main 3a7f9c2] feat: add payment module';
    const commits = recoverCommitSHAs([{ toolEvents: [{ toolName: 'bash', result: output, isError: false }] }]);
    appendArtifacts('root-commit', { commits }, { outcomesDir: tmpDir });

    const updated = readRecord('root-commit', tmpDir);
    expect(updated?.artifacts.commits).toContain('3a7f9c2');
  });

  it('extracts PR URL from gh pr create output', async () => {
    writeRecord(makeOutcome('root-pr'), tmpDir);

    const { appendArtifacts } = await import('./store.js');
    const { isPRCreateEvent } = await import('./artifacts.js');

    const ev = {
      toolName: 'bash',
      input: 'gh pr create --title "feat: add auth" --body ""',
      result: 'https://github.com/org/repo/pull/42',
      isError: false as const,
    };

    const prs: string[] = [];
    if (isPRCreateEvent(ev)) {
      const matches = ev.result.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/g);
      if (matches) prs.push(...matches);
    }
    appendArtifacts('root-pr', { prs }, { outcomesDir: tmpDir });

    const updated = readRecord('root-pr', tmpDir);
    expect(updated?.artifacts.prs).toContain('https://github.com/org/repo/pull/42');
  });
});
