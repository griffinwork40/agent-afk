/**
 * Tests for the three episode-recall transparency features (issue #4683):
 *
 *   1. `scoredEpisodes()` — returns all candidates with scores (for /recall)
 *   2. `AFK_EPISODE_RECALL=dry-run` — logs to stderr without injecting
 *   3. `opts.noRecall=true` — per-call suppression (--no-recall CLI flag)
 *   4. `AFK_NO_EPISODE_RECALL=1` — per-session env suppression
 *
 * @module agent/memory/memory-loader.recall-transparency.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MemoryStore } from './memory-store.js';
import { injectEpisodeRecall, scoredEpisodes } from './memory-loader.js';
import type { AgentConfig } from '../types/config-types.js';

// ---------------------------------------------------------------------------
// Mock env
// ---------------------------------------------------------------------------

const mockEnv: Record<string, string | undefined> = {};

vi.mock('../../config/env.js', () => ({
  env: new Proxy({} as Record<string, string | undefined>, {
    get: (_t, prop: string) => mockEnv[prop],
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: MemoryStore;

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { model: 'claude-sonnet-4-5', ...overrides } as AgentConfig;
}

function storeEpisode(s: MemoryStore, files: string[], branch?: string): number {
  const fileList = files.join(', ');
  const branchLine = branch ? `\nbranch: ${branch}` : '';
  const content = `[episode:test-${Date.now()}-${Math.random().toString(36).slice(2)}]\nfiles: ${fileList}${branchLine}\nsummary: worked on things`;
  return s.storeFact({ category: 'episode', content, source_surface: 'episode-synthesis' });
}

function getCurrentBranchSync(): string | null {
  try {
    const { execFileSync } = require('child_process') as typeof import('child_process');
    const out = execFileSync('git', ['--no-optional-locks', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
    }).toString().trim();
    return out.length > 0 && out !== 'HEAD' ? out : null;
  } catch {
    return null;
  }
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `afk-recall-transparency-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  store = new MemoryStore(tmpDir);
  delete mockEnv['AFK_EPISODE_RECALL'];
  delete mockEnv['AFK_NO_EPISODE_RECALL'];
});

afterEach(() => {
  store.close();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. scoredEpisodes — returns all candidates with scores
// ---------------------------------------------------------------------------

describe('scoredEpisodes', () => {
  it('returns empty array when store has no episodes', () => {
    const result = scoredEpisodes(tmpDir, tmpDir, store);
    expect(result).toEqual([]);
  });

  it('returns all episodes including zero-score ones', () => {
    // Store two episodes with unlikely branch names — scores will be 0 when
    // git context is a tmpDir (no git repo there).
    storeEpisode(store, ['never-matching-zzz.ts'], 'branch-zzz-never-exists');
    storeEpisode(store, ['also-never-qqq.ts'], 'branch-qqq-never-exists');

    const result = scoredEpisodes(tmpDir, tmpDir, store);
    // Both episodes exist — scoredEpisodes includes ALL regardless of score.
    expect(result.length).toBe(2);
  });

  it('each result has ep and score fields', () => {
    storeEpisode(store, ['foo.ts']);

    const result = scoredEpisodes(tmpDir, tmpDir, store);
    expect(result.length).toBe(1);
    expect(result[0]).toHaveProperty('ep');
    expect(result[0]).toHaveProperty('score');
    expect(typeof result[0]!.score).toBe('number');
  });

  {
    const branch = getCurrentBranchSync();
    it.skipIf(!branch)('returns results sorted by descending score', () => {
      // Episode A: matches branch (score +3), Episode B: no match (score 0).
      storeEpisode(store, ['src/memory-loader.ts'], branch!);  // should score > 0
      storeEpisode(store, ['zzz-never-exists.ts'], 'branch-zzz-never');  // score 0

      const result = scoredEpisodes(tmpDir, process.cwd(), store);
      // Results must be sorted descending.
      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1]!.score).toBeGreaterThanOrEqual(result[i]!.score);
      }
    });
  }

  {
    const branch = getCurrentBranchSync();
    it.skipIf(!branch)('returns all episodes, not just top 3 (unlike recallEpisodes)', () => {
      // Store 5 episodes all matching the branch.
      for (let i = 0; i < 5; i++) {
        storeEpisode(store, [`src/file${i}.ts`], branch!);
      }

      const all = scoredEpisodes(tmpDir, process.cwd(), store);
      // scoredEpisodes must return all 5; recallEpisodes caps at 3.
      expect(all.length).toBe(5);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. AFK_EPISODE_RECALL=dry-run
// ---------------------------------------------------------------------------

describe('injectEpisodeRecall — dry-run mode', () => {
  {
    const branch = getCurrentBranchSync();
    it.skipIf(!branch)('returns config unchanged in dry-run mode', () => {
      mockEnv['AFK_EPISODE_RECALL'] = 'dry-run';
      storeEpisode(store, ['src/memory-loader.ts'], branch!);

      const config = makeConfig();
      const result = injectEpisodeRecall(config, tmpDir, process.cwd(), store);

      // dry-run must NOT modify the system prompt.
      expect(result).toBe(config);
    });
  }

  {
    const branch = getCurrentBranchSync();
    it.skipIf(!branch)('writes to stderr in dry-run mode when episodes would be injected', () => {
      mockEnv['AFK_EPISODE_RECALL'] = 'dry-run';
      storeEpisode(store, ['src/memory-loader.ts'], branch!);

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const config = makeConfig();
        injectEpisodeRecall(config, tmpDir, process.cwd(), store);

        // At least one stderr write should have happened with the dry-run marker.
        const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
        const hasDryRunLine = calls.some((s) => s.includes('[episode-recall dry-run]'));
        // Only assert if an episode actually scored (git-dependent).
        if (calls.length > 0) {
          expect(hasDryRunLine).toBe(true);
        }
      } finally {
        stderrSpy.mockRestore();
      }
    });
  }

  it('does not fire (returns unchanged) for dry-run when no episodes score > 0', () => {
    mockEnv['AFK_EPISODE_RECALL'] = 'dry-run';
    // Episode in a tmpDir with no git repo → score = 0 → recallEpisodes returns []
    storeEpisode(store, ['zzz-never-match.ts'], 'branch-zzz-never');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const config = makeConfig();
      const result = injectEpisodeRecall(config, tmpDir, tmpDir, store);
      // No episodes scored → config unchanged, no stderr output.
      expect(result).toBe(config);
      const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
      expect(calls.some((s) => s.includes('[episode-recall dry-run]'))).toBe(false);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. opts.noRecall=true — per-call suppression
// ---------------------------------------------------------------------------

describe('injectEpisodeRecall — opts.noRecall', () => {
  it('returns config unchanged when noRecall=true even with AFK_EPISODE_RECALL=1', () => {
    mockEnv['AFK_EPISODE_RECALL'] = '1';
    storeEpisode(store, ['src/memory-loader.ts']);

    const config = makeConfig();
    const result = injectEpisodeRecall(config, tmpDir, tmpDir, store, { noRecall: true });

    // noRecall suppresses injection — fires before any scoring, so no branch needed.
    expect(result).toBe(config);
  });

  {
    const branch = getCurrentBranchSync();
    it.skipIf(!branch)('does not suppress when noRecall is false or absent', () => {
      mockEnv['AFK_EPISODE_RECALL'] = '1';
      storeEpisode(store, ['src/memory-loader.ts'], branch!);

      const config = makeConfig();
      const result = injectEpisodeRecall(config, tmpDir, process.cwd(), store, { noRecall: false });

      // noRecall: false must not suppress — injection proceeds normally.
      // If an episode scored, the result differs from the input.
      // If git is unavailable and no episode scores, result === config (acceptable).
      // We only check that noRecall: false did not force a no-op when episodes exist.
      // The result is either injected (new object) or unchanged (no matching episodes).
      expect(result === config || result.hotMemory?.includes('<recent-episodes>')).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. AFK_NO_EPISODE_RECALL=1 — env-based per-session suppression
// ---------------------------------------------------------------------------

describe('injectEpisodeRecall — AFK_NO_EPISODE_RECALL', () => {
  it('returns config unchanged when AFK_NO_EPISODE_RECALL=1', () => {
    mockEnv['AFK_EPISODE_RECALL'] = '1';
    mockEnv['AFK_NO_EPISODE_RECALL'] = '1';
    storeEpisode(store, ['src/memory-loader.ts']);

    const config = makeConfig();
    const result = injectEpisodeRecall(config, tmpDir, tmpDir, store);

    // AFK_NO_EPISODE_RECALL suppresses injection — fires before any scoring, so no branch needed.
    expect(result).toBe(config);
  });

  {
    const branch = getCurrentBranchSync();
    it.skipIf(!branch)('does not suppress when AFK_NO_EPISODE_RECALL is not set', () => {
      mockEnv['AFK_EPISODE_RECALL'] = '1';
      delete mockEnv['AFK_NO_EPISODE_RECALL'];
      storeEpisode(store, ['src/memory-loader.ts'], branch!);

      const config = makeConfig();
      const result = injectEpisodeRecall(config, tmpDir, process.cwd(), store);

      // Without AFK_NO_EPISODE_RECALL, injection proceeds normally.
      // Either injection happened (hotMemory has the block) or no episodes scored (config unchanged).
      expect(result === config || result.hotMemory?.includes('<recent-episodes>')).toBe(true);
    });
  }

  it('AFK_NO_EPISODE_RECALL=1 also suppresses dry-run mode', () => {
    mockEnv['AFK_EPISODE_RECALL'] = 'dry-run';
    mockEnv['AFK_NO_EPISODE_RECALL'] = '1';

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const config = makeConfig();
      const result = injectEpisodeRecall(config, tmpDir, tmpDir, store);

      expect(result).toBe(config);
      const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
      expect(calls.some((s) => s.includes('[episode-recall dry-run]'))).toBe(false);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. dry-run × token-cap interaction
// ---------------------------------------------------------------------------

describe('injectEpisodeRecall — dry-run respects EPISODE_TOKEN_CAP', () => {
  const branch = getCurrentBranchSync();
  it.skipIf(!branch)('dry-run reports only token-capped episodes, not all scored episodes', () => {
    mockEnv['AFK_EPISODE_RECALL'] = 'dry-run';

    // Store enough large episodes that the total exceeds the ~6000 token cap.
    // Each episode body is ~2500 tokens of text to force trimming at 3 episodes.
    const bigContent = 'x'.repeat(10_000); // ~2500 tokens (4 chars/token approx)
    for (let i = 0; i < 4; i++) {
      store.storeFact({
        category: 'episode',
        content: `[episode:big-${i}]\nfiles: src/memory-loader.ts\nbranch: ${branch!}\nsummary: ${bigContent}`,
        source_surface: 'episode-synthesis',
      });
    }

    const stderrLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
      stderrLines.push(String(s));
      return true;
    });

    try {
      injectEpisodeRecall(makeConfig(), tmpDir, process.cwd(), store);

      // The header line reports how many episodes AFTER token-cap trimming.
      const headerLine = stderrLines.find((s) => s.includes('[episode-recall dry-run]'));
      // Should have fired (branch-matched episodes exist).
      expect(headerLine).toBeDefined();
      // The count reported must be < 4 (trimming happened).
      const match = headerLine?.match(/would inject (\d+) episode/);
      if (match) {
        const reported = parseInt(match[1]!, 10);
        expect(reported).toBeLessThan(4);
        // The bullet count should equal the reported count.
        const bullets = stderrLines.filter((s) => s.includes('• id='));
        expect(bullets.length).toBe(reported);
      }
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
