/**
 * Tests for src/agent/memory/memory-loader.ts — hot memory injection.
 *
 * Invariant: hot memory (HOT.md) is carried on the dedicated `config.hotMemory`
 * field, NOT prepended into `config.systemPrompt`. The provider assembler then
 * places the `<cross-session-memory>` block in the cross-session-memory region
 * (after the memory instructions) while the `# Agent AFK` doctrine + operator
 * overlay (systemPrompt) is placed early — see
 * `providers/anthropic-direct/query/system-prompt.ts`.
 *
 * Points HOME at a tmp dir so nothing touches the real ~/.afk.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import type { AgentConfig } from '../../../src/agent/types/config-types.js';
import type { Fact } from '../../../src/agent/memory/types.js';
import {
  loadHotMemory,
  injectHotMemory,
  parseEpisodeFiles,
  buildHighFreqFiles,
  scoreEpisode,
  formatEpisodeForRecall,
  injectEpisodeRecall,
} from '../../../src/agent/memory/memory-loader.js';
import { useUnsetAfkHome } from '../../../src/__test-utils__/unset-afk-home.js';
import { rmSyncRetry } from '../../../src/__test-utils__/rm-sync-retry.js';

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

// HOT.md fixtures are written under $HOME/.afk/state/memory and the loader
// resolves that via the unset-AFK_HOME fallback — drop the global sentinel
// AFK_HOME per test; HOME is redirected to a tmp dir below.
useUnsetAfkHome();

beforeEach(() => {
  originalHome = process.env['HOME'];
  originalUserProfile = process.env['USERPROFILE'];
  tmpHome = join(tmpdir(), `afk-mem-loader-${randomUUID()}`);
  mkdirSync(join(tmpHome, '.afk', 'state', 'memory'), { recursive: true });
  process.env['HOME'] = tmpHome;
  process.env['USERPROFILE'] = tmpHome;
});

afterEach(() => {
  // best-effort: SQLite file handles may linger on Windows CI
  try { if (existsSync(tmpHome)) rmSyncRetry(tmpHome); } catch { /* EBUSY on CI */ }
  if (originalHome !== undefined) process.env['HOME'] = originalHome;
  else delete process.env['HOME'];
  if (originalUserProfile !== undefined) process.env['USERPROFILE'] = originalUserProfile;
  else delete process.env['USERPROFILE'];
});

describe('loadHotMemory', () => {
  it('returns null when no HOT.md exists', () => {
    const result = loadHotMemory();
    expect(result).toBeNull();
  });

  it('returns content when HOT.md exists', () => {
    const hotPath = join(tmpHome, '.afk', 'state', 'memory', 'HOT.md');
    const content = '# Hot Memory\nSome important facts';
    writeFileSync(hotPath, content, 'utf-8');

    const result = loadHotMemory();
    expect(result).toBe(content);
  });

  it('returns null for empty HOT.md', () => {
    const hotPath = join(tmpHome, '.afk', 'state', 'memory', 'HOT.md');
    writeFileSync(hotPath, '', 'utf-8');

    const result = loadHotMemory();
    expect(result).toBeNull();
  });

  it('returns null for whitespace-only HOT.md', () => {
    const hotPath = join(tmpHome, '.afk', 'state', 'memory', 'HOT.md');
    writeFileSync(hotPath, '   \n\n  ', 'utf-8');

    const result = loadHotMemory();
    expect(result).toBeNull();
  });

  it('handles read errors gracefully', () => {
    const hotPath = join(tmpHome, '.afk', 'state', 'memory', 'HOT.md');
    mkdirSync(hotPath, { recursive: true }); // Make it a directory, not a file

    const result = loadHotMemory();
    expect(result).toBeNull();
  });
});

describe('injectHotMemory', () => {
  it('returns config unchanged (no hotMemory) when no HOT.md exists', () => {
    const config: AgentConfig = {
      model: 'sonnet',
      systemPrompt: 'Base prompt',
    };

    const result = injectHotMemory(config);
    expect(result).toBe(config);
    expect(result.hotMemory).toBeUndefined();
  });

  it('stores the memory block on config.hotMemory, NOT prepended into systemPrompt', () => {
    const hotPath = join(tmpHome, '.afk', 'state', 'memory', 'HOT.md');
    const hotContent = 'Previous session: user prefers brevity';
    writeFileSync(hotPath, hotContent, 'utf-8');

    const config: AgentConfig = {
      model: 'sonnet',
      systemPrompt: 'Base system prompt',
    };

    const result = injectHotMemory(config);
    // Hot memory rides its own field so the assembler can place it in the
    // cross-session-memory region rather than ahead of the # Agent AFK doctrine.
    expect(result.hotMemory).toBe(
      `<cross-session-memory>\n${hotContent}\n</cross-session-memory>`,
    );
    // systemPrompt (the doctrine + operator overlay) is left untouched.
    expect(result.systemPrompt).toBe('Base system prompt');
    expect(result.systemPrompt).not.toContain('<cross-session-memory>');
  });

  it('leaves a preset systemPrompt untouched and carries hot memory on config.hotMemory', () => {
    const hotPath = join(tmpHome, '.afk', 'state', 'memory', 'HOT.md');
    const hotContent = 'Important context from previous session';
    writeFileSync(hotPath, hotContent, 'utf-8');

    const preset = {
      type: 'preset' as const,
      preset: 'claude_code' as const,
      append: 'Extra instructions',
    };
    const config: AgentConfig = { model: 'sonnet', systemPrompt: { ...preset } };

    const result = injectHotMemory(config);
    expect(result.systemPrompt).toEqual(preset);
    expect(result.hotMemory).toBe(
      `<cross-session-memory>\n${hotContent}\n</cross-session-memory>`,
    );
  });

  it('carries hot memory on config.hotMemory when systemPrompt is undefined (systemPrompt stays undefined)', () => {
    const hotPath = join(tmpHome, '.afk', 'state', 'memory', 'HOT.md');
    const hotContent = 'Memory block content';
    writeFileSync(hotPath, hotContent, 'utf-8');

    const config: AgentConfig = {
      model: 'sonnet',
    };

    const result = injectHotMemory(config);
    expect(result.systemPrompt).toBeUndefined();
    expect(result.hotMemory).toBe(
      `<cross-session-memory>\n${hotContent}\n</cross-session-memory>`,
    );
  });

  it('strips any pre-existing <cross-session-memory> tags before re-wrapping (no double-wrap)', () => {
    const hotPath = join(tmpHome, '.afk', 'state', 'memory', 'HOT.md');
    writeFileSync(hotPath, '<cross-session-memory>\nInner\n</cross-session-memory>', 'utf-8');

    const config: AgentConfig = { model: 'sonnet', systemPrompt: 'Base' };
    const result = injectHotMemory(config);
    const opens = (result.hotMemory?.match(/<cross-session-memory>/g) ?? []).length;
    const closes = (result.hotMemory?.match(/<\/cross-session-memory>/g) ?? []).length;
    expect(opens).toBe(1);
    expect(closes).toBe(1);
  });

  it('does not mutate the original config', () => {
    const hotPath = join(tmpHome, '.afk', 'state', 'memory', 'HOT.md');
    writeFileSync(hotPath, 'Hot content', 'utf-8');

    const config: AgentConfig = {
      model: 'sonnet',
      systemPrompt: 'Original',
    };
    const configBefore = JSON.stringify(config);

    injectHotMemory(config);

    expect(JSON.stringify(config)).toBe(configBefore);
    expect(config.hotMemory).toBeUndefined();
  });

  it('preserves all other config fields', () => {
    const hotPath = join(tmpHome, '.afk', 'state', 'memory', 'HOT.md');
    writeFileSync(hotPath, 'Memory', 'utf-8');

    const config: AgentConfig = {
      model: 'opus',
      apiKey: 'sk-test',
      maxTurns: 100,
      systemPrompt: 'Base',
      timeoutMs: 5000,
    };

    const result = injectHotMemory(config);
    expect(result.model).toBe('opus');
    expect(result.apiKey).toBe('sk-test');
    expect(result.maxTurns).toBe(100);
    expect(result.timeoutMs).toBe(5000);
    expect(result.systemPrompt).toBe('Base');
  });
});

// ── Episode recall helper unit tests ────────────────────────────────────────

function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: 1,
    session_id: 'sess-1',
    created_at: new Date().toISOString(),
    category: 'learning',
    content: '[episode:sess-1]\ngoal: fix bug\nfiles: src/foo.ts, src/bar.ts\nnarrative: fixed it',
    source_surface: 'episode-synthesis',
    superseded_by: null,
    confidence: 1,
    access_count: 0,
    last_accessed: null,
    evidence: null,
    ...overrides,
  };
}

describe('parseEpisodeFiles', () => {
  it('extracts files from the files: line', () => {
    const content = '[episode:s]\ngoal: x\nfiles: src/a.ts, lib/b.ts\nnarrative: done';
    expect(parseEpisodeFiles(content)).toEqual(['src/a.ts', 'lib/b.ts']);
  });

  it('returns empty array when no files line', () => {
    const content = '[episode:s]\ngoal: x\nnarrative: done';
    expect(parseEpisodeFiles(content)).toEqual([]);
  });

  it('trims whitespace from file entries', () => {
    const content = 'files:  a.ts ,  b.ts  ';
    expect(parseEpisodeFiles(content)).toEqual(['a.ts', 'b.ts']);
  });
});

describe('buildHighFreqFiles', () => {
  it('returns empty set for empty input', () => {
    expect(buildHighFreqFiles([])).toEqual(new Set());
  });

  it('flags files appearing in >30% of episodes', () => {
    // 4 episodes, package.json in all 4 = 100% > 30%
    const episodes = [1, 2, 3, 4].map((i) =>
      makeFact({ id: i, content: `[episode:s${i}]\nfiles: package.json, src/unique${i}.ts` }),
    );
    const highFreq = buildHighFreqFiles(episodes);
    expect(highFreq.has('package.json')).toBe(true);
    // unique files appear in only 1/4 = 25% — below threshold
    expect(highFreq.has('src/unique1.ts')).toBe(false);
  });

  it('does not flag files below the 30% threshold', () => {
    // 10 episodes, rare.ts in only 2 = 20%
    const episodes = Array.from({ length: 10 }, (_, i) =>
      makeFact({
        id: i,
        content: `[episode:s${i}]\nfiles: ${i < 2 ? 'rare.ts, ' : ''}common${i}.ts`,
      }),
    );
    const highFreq = buildHighFreqFiles(episodes);
    expect(highFreq.has('rare.ts')).toBe(false);
  });
});

describe('scoreEpisode', () => {
  it('scores 0 when no matching files and no branch match', () => {
    const fact = makeFact({ content: '[episode:s]\nfiles: other.ts\nnarrative: x' });
    const score = scoreEpisode(fact, new Set(['unrelated.ts']), 'main', new Set());
    expect(score).toBe(0);
  });

  it('scores +3 per full relative-path match (recent episode, decay ≈ 1)', () => {
    // Episode stores src/foo.ts and src/bar.ts; caller passes the same full paths.
    const fact = makeFact({ content: '[episode:s]\nfiles: src/foo.ts, src/bar.ts' });
    const filePaths = new Set(['src/foo.ts', 'src/bar.ts']);
    const score = scoreEpisode(fact, filePaths, null, new Set());
    expect(score).toBeCloseTo(6, 1); // 2 files × 3 (full-path match)
  });

  it('scores +1 per basename-only match when full path does not match', () => {
    // Episode stores src/foo.ts; caller has lib/foo.ts — basename matches but
    // full path does not, so only +1 (weaker collision signal).
    const fact = makeFact({ content: '[episode:s]\nfiles: src/foo.ts, src/bar.ts' });
    const filePaths = new Set(['lib/foo.ts', 'lib/bar.ts']);
    const score = scoreEpisode(fact, filePaths, null, new Set());
    expect(score).toBeCloseTo(2, 1); // 2 files × 1 (basename-only match)
  });

  it('full-path match outweighs basename-only match for the same file', () => {
    // src/utils.ts in episode; caller has both src/utils.ts (full match) and
    // lib/utils.ts (basename collision). Only src/utils.ts should score (+3),
    // lib/utils.ts must not add an extra +1 for the same episode file entry.
    const fact = makeFact({ content: '[episode:s]\nfiles: src/utils.ts' });
    const filePaths = new Set(['src/utils.ts', 'lib/utils.ts']);
    const score = scoreEpisode(fact, filePaths, null, new Set());
    expect(score).toBeCloseTo(3, 1); // full-path match only, no double-count
  });

  it('skips high-frequency files in scoring', () => {
    const fact = makeFact({ content: '[episode:s]\nfiles: package.json, src/foo.ts' });
    const filePaths = new Set(['package.json', 'src/foo.ts']);
    const highFreq = new Set(['package.json']);
    const score = scoreEpisode(fact, filePaths, null, highFreq);
    expect(score).toBeCloseTo(3, 1); // only src/foo.ts counts (full-path match)
  });

  it('scores +3 for branch name match in content', () => {
    const fact = makeFact({ content: '[episode:s]\nfiles:\nnarrative: worked on feat/auth branch' });
    const score = scoreEpisode(fact, new Set(), 'feat/auth', new Set());
    expect(score).toBeCloseTo(3, 1);
  });

  it('combines full-path file and branch scores', () => {
    const fact = makeFact({
      content: '[episode:s]\nfiles: src/session.ts\nnarrative: fixed on feat/session branch',
    });
    const score = scoreEpisode(fact, new Set(['src/session.ts']), 'feat/session', new Set());
    expect(score).toBeCloseTo(6, 1); // 3 (full-path file) + 3 (branch)
  });

  it('applies recency decay: a 90-day-old episode is multiplied by the floor (0.1)', () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const fact = makeFact({
      content: '[episode:s]\nfiles: src/foo.ts',
      created_at: ninetyDaysAgo,
    });
    const score = scoreEpisode(fact, new Set(['src/foo.ts']), null, new Set());
    // Raw score = 3 (full-path match); decay = max(0.1, 1 - 90/90) = max(0.1, 0) = 0.1
    expect(score).toBeCloseTo(3 * 0.1, 5);
  });

  it('applies recency decay: a 45-day-old episode is multiplied by 0.5', () => {
    const fortyFiveDaysAgo = new Date(Date.now() - 45 * 86_400_000).toISOString();
    const fact = makeFact({
      content: '[episode:s]\nfiles: src/foo.ts',
      created_at: fortyFiveDaysAgo,
    });
    const score = scoreEpisode(fact, new Set(['src/foo.ts']), null, new Set());
    // Raw score = 3; decay = max(0.1, 1 - 45/90) = 0.5
    expect(score).toBeCloseTo(3 * 0.5, 5);
  });

  it('applies recency decay to branch-match-only episodes: 45-day-old episode scores ≈ 1.5', () => {
    // Branch-only match: no files overlap, only the branch name appears in content.
    // Raw score = 3 (branch match); decay = max(0.1, 1 - 45/90) = 0.5
    // Final score = 3 × 0.5 = 1.5
    const fortyFiveDaysAgo = new Date(Date.now() - 45 * 86_400_000).toISOString();
    const fact = makeFact({
      content: '[episode:s]\nfiles:\nnarrative: worked on feat/my-branch branch',
      created_at: fortyFiveDaysAgo,
    });
    const score = scoreEpisode(fact, new Set(), 'feat/my-branch', new Set());
    expect(score).toBeCloseTo(1.5, 2);
  });

  it('explicit now parameter produces deterministic score independent of wall-clock time', () => {
    // Use a fixed epoch anchor so the test never drifts with wall-clock time.
    // created_at = Unix epoch (0); now = exactly 45 days later.
    // Raw score = 3 (branch match); decay = max(0.1, 1 - 45/90) = 0.5
    // Final score = 3 × 0.5 = 1.5 — exact, not approximate.
    const created_at = new Date(0).toISOString();
    const fixedNow = 45 * 86_400_000;
    const fact = makeFact({
      content: '[episode:s]\nfiles:\nnarrative: worked on feat/my-branch branch',
      created_at,
    });
    const score = scoreEpisode(fact, new Set(), 'feat/my-branch', new Set(), fixedNow);
    expect(score).toBeCloseTo(1.5, 5);
  });

  it('recent episode (age ~ 0) has decay ≈ 1 and scores full raw value', () => {
    const fact = makeFact({ content: '[episode:s]\nfiles: src/foo.ts' });
    const score = scoreEpisode(fact, new Set(['src/foo.ts']), null, new Set());
    // created_at defaults to now — decay should be essentially 1.0
    expect(score).toBeCloseTo(3, 1);
  });

  it('a very old episode (>90 days) is clamped to the floor multiplier (0.1)', () => {
    const twoYearsAgo = new Date(Date.now() - 730 * 86_400_000).toISOString();
    const fact = makeFact({
      content: '[episode:s]\nfiles: src/foo.ts',
      created_at: twoYearsAgo,
    });
    const score = scoreEpisode(fact, new Set(['src/foo.ts']), null, new Set());
    // decay = max(0.1, 1 - 730/90) is negative → clamped to 0.1
    expect(score).toBeCloseTo(3 * 0.1, 5);
  });

  it('score 0 before decay skips decay multiplication and returns 0', () => {
    const fact = makeFact({
      content: '[episode:s]\nfiles: other.ts',
      created_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    });
    const score = scoreEpisode(fact, new Set(['unrelated.ts']), null, new Set());
    expect(score).toBe(0);
  });
});

describe('formatEpisodeForRecall', () => {
  it('strips the [episode:<id>] prefix line', () => {
    const fact = makeFact({
      content: '[episode:sess-abc]\ngoal: fix bug\noutcome: done',
    });
    const formatted = formatEpisodeForRecall(fact);
    expect(formatted).not.toContain('[episode:');
    expect(formatted).toContain('goal: fix bug');
    expect(formatted).toContain('outcome: done');
  });

  it('trims leading/trailing whitespace', () => {
    const fact = makeFact({ content: '[episode:x]\n\ngoal: y\n\n' });
    const formatted = formatEpisodeForRecall(fact);
    expect(formatted.startsWith('\n')).toBe(false);
    expect(formatted.endsWith('\n')).toBe(false);
  });
});

describe('injectEpisodeRecall', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns config unchanged when AFK_EPISODE_RECALL is not set', () => {
    vi.stubEnv('AFK_EPISODE_RECALL', '0');
    const config: AgentConfig = { model: 'sonnet' };
    // Re-import to pick up env stub
    const result = injectEpisodeRecall(config);
    expect(result).toBe(config);
  });

  it('returns config unchanged when parentSessionId is set (subagent guard)', () => {
    vi.stubEnv('AFK_EPISODE_RECALL', '1');
    const config: AgentConfig = { model: 'sonnet', parentSessionId: 'parent-123' };
    const result = injectEpisodeRecall(config);
    expect(result).toBe(config);
  });

  it('returns config unchanged when no relevant episodes found', () => {
    vi.stubEnv('AFK_EPISODE_RECALL', '1');
    // Point to an empty tmp memory dir
    const emptyDir = join(tmpHome, 'empty-mem-' + randomUUID());
    mkdirSync(emptyDir, { recursive: true });
    const config: AgentConfig = { model: 'sonnet' };
    const result = injectEpisodeRecall(config, emptyDir);
    expect(result).toBe(config);
  });

  it('does not mutate the original config', () => {
    vi.stubEnv('AFK_EPISODE_RECALL', '1');
    const config: AgentConfig = { model: 'sonnet' };
    const before = JSON.stringify(config);
    injectEpisodeRecall(config);
    expect(JSON.stringify(config)).toBe(before);
  });
});
