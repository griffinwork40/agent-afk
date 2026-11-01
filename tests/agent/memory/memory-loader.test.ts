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
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
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
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
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

  it('scores +2 per matching file basename', () => {
    const fact = makeFact({ content: '[episode:s]\nfiles: src/foo.ts, src/bar.ts' });
    const fileBasenames = new Set(['foo.ts', 'bar.ts']);
    const score = scoreEpisode(fact, fileBasenames, null, new Set());
    expect(score).toBe(4); // 2 files × 2
  });

  it('skips high-frequency files in scoring', () => {
    const fact = makeFact({ content: '[episode:s]\nfiles: package.json, foo.ts' });
    const fileBasenames = new Set(['package.json', 'foo.ts']);
    const highFreq = new Set(['package.json']);
    const score = scoreEpisode(fact, fileBasenames, null, highFreq);
    expect(score).toBe(2); // only foo.ts counts
  });

  it('scores +3 for branch name match in content', () => {
    const fact = makeFact({ content: '[episode:s]\nfiles:\nnarrative: worked on feat/auth branch' });
    const score = scoreEpisode(fact, new Set(), 'feat/auth', new Set());
    expect(score).toBe(3);
  });

  it('combines file and branch scores', () => {
    const fact = makeFact({
      content: '[episode:s]\nfiles: src/session.ts\nnarrative: fixed on feat/session branch',
    });
    const score = scoreEpisode(fact, new Set(['session.ts']), 'feat/session', new Set());
    expect(score).toBe(5); // 2 (file) + 3 (branch)
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
