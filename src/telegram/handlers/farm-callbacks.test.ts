/**
 * Tests for src/telegram/handlers/farm-callbacks.ts
 */

import { describe, it, expect, vi } from 'vitest';
import type { Context } from 'telegraf';

import { handleFarmCallback } from './farm-callbacks.js';
import type { FarmManifest } from '../../agent/worktree.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(over: Partial<FarmManifest> = {}): FarmManifest {
  return {
    schemaVersion: 2,
    taskId: 'task-id',
    taskSlug: 'my-slug',
    taskName: 'My task',
    repoRoot: '/tmp/repo',
    baseRef: 'abc1234def5678',
    farmDir: '/tmp/farm',
    createdAt: '2026-05-14T00:00:00.000Z',
    branches: [
      { index: 1, path: '/tmp/farm/branch-1', branch: 'afk/farm/my-slug/1-branch-1' },
    ],
    ...over,
  };
}

function makeCtx(callbackData: string | undefined, chatId: number = 42) {
  const answerCbQuery = vi.fn(async () => true);
  const reply = vi.fn(async () => ({ message_id: 1 }));
  const ctx = {
    chat: chatId === -1 ? undefined : { id: chatId, type: 'private' as const },
    callbackQuery: callbackData === undefined ? undefined : { data: callbackData },
    answerCbQuery,
    reply,
  } as unknown as Context;
  return { ctx, answerCbQuery, reply };
}

// ---------------------------------------------------------------------------
// Parse fallthrough
// ---------------------------------------------------------------------------

describe('handleFarmCallback — malformed payloads', () => {
  it('answers "Unknown action" on missing callbackQuery', async () => {
    const { ctx, answerCbQuery } = makeCtx(undefined);
    await handleFarmCallback(ctx);
    expect(answerCbQuery).toHaveBeenCalledWith('Unknown action');
  });

  it('answers "Unknown action" on bad prefix', async () => {
    const { ctx, answerCbQuery } = makeCtx('not-afk:x:slug');
    await handleFarmCallback(ctx);
    expect(answerCbQuery).toHaveBeenCalledWith('Unknown action');
  });

  it('answers "Unknown action" on path-traversal slug', async () => {
    const { ctx, answerCbQuery } = makeCtx('afk:f:x:../escape');
    await handleFarmCallback(ctx);
    expect(answerCbQuery).toHaveBeenCalledWith('Unknown action');
  });

  it('answers "No chat context" if ctx.chat is missing', async () => {
    const { ctx, answerCbQuery } = makeCtx('afk:f:x:my-slug', -1);
    await handleFarmCallback(ctx);
    expect(answerCbQuery).toHaveBeenCalledWith('No chat context');
  });

  it('answers "Farm not found" when manifest is null', async () => {
    const { ctx, answerCbQuery } = makeCtx('afk:f:x:missing');
    await handleFarmCallback(ctx, { loadFarm: async () => null });
    expect(answerCbQuery).toHaveBeenCalled();
    const arg = (answerCbQuery.mock.calls[0]?.[0] ?? '') as string;
    expect(arg).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// Discard happy + idempotency
// ---------------------------------------------------------------------------

describe('handleFarmCallback — Discard (x)', () => {
  it('records human_decision=rejected and writes a farm-decision fact', async () => {
    const manifest = makeManifest();
    const loadFarm = vi.fn(async () => manifest);
    const recordHumanDecision = vi.fn(async (slug: string, _d: 'rejected') => ({
      ...manifest,
      taskSlug: slug,
      human_decision: 'rejected' as const,
      decidedAt: '2026-05-14T01:00:00.000Z',
    }));
    const writeFarmDecisionFact = vi.fn(() => ({ factId: 1 }));
    const { ctx, answerCbQuery, reply } = makeCtx('afk:f:x:my-slug');

    await handleFarmCallback(ctx, { loadFarm, recordHumanDecision, writeFarmDecisionFact });

    expect(recordHumanDecision).toHaveBeenCalledWith('my-slug', 'rejected');
    expect(writeFarmDecisionFact).toHaveBeenCalledWith({
      taskSlug: 'my-slug',
      decision: 'rejected',
      decidedAt: '2026-05-14T01:00:00.000Z',
      via: 'telegram',
    });
    expect(answerCbQuery).toHaveBeenCalledWith('Discarded ✓');
    expect(reply).toHaveBeenCalled();
  });

  it('is idempotent: a re-click on an already-rejected farm acks but does not double-write', async () => {
    const manifest = makeManifest({
      human_decision: 'rejected',
      decidedAt: '2026-05-14T01:00:00.000Z',
    });
    const recordHumanDecision = vi.fn();
    const writeFarmDecisionFact = vi.fn();
    const { ctx, answerCbQuery, reply } = makeCtx('afk:f:x:my-slug');

    await handleFarmCallback(ctx, {
      loadFarm: async () => manifest,
      recordHumanDecision,
      writeFarmDecisionFact,
    });

    expect(recordHumanDecision).not.toHaveBeenCalled();
    expect(writeFarmDecisionFact).not.toHaveBeenCalled();
    expect(answerCbQuery).toHaveBeenCalledWith('Already discarded');
    expect(reply).not.toHaveBeenCalled();
  });

  it('does NOT overwrite an existing approved decision via the discard button', async () => {
    const manifest = makeManifest({
      human_decision: 'approved',
      decidedAt: '2026-05-14T01:00:00.000Z',
    });
    const recordHumanDecision = vi.fn();
    const { ctx, answerCbQuery } = makeCtx('afk:f:x:my-slug');

    await handleFarmCallback(ctx, {
      loadFarm: async () => manifest,
      recordHumanDecision,
      writeFarmDecisionFact: vi.fn(),
    });

    expect(recordHumanDecision).not.toHaveBeenCalled();
    const ack = answerCbQuery.mock.calls[0]?.[0] as string;
    expect(ack).toMatch(/already resolved/i);
    expect(ack).toMatch(/approved/);
  });

  it('survives a memory-write failure without breaking the manifest write', async () => {
    const manifest = makeManifest();
    const recordHumanDecision = vi.fn(async () => ({
      ...manifest,
      human_decision: 'rejected' as const,
      decidedAt: '2026-05-14T01:00:00.000Z',
    }));
    const writeFarmDecisionFact = vi.fn(() => ({ skipped: true as const, reason: 'sqlite locked' }));
    const { ctx, answerCbQuery } = makeCtx('afk:f:x:my-slug');

    await handleFarmCallback(ctx, {
      loadFarm: async () => manifest,
      recordHumanDecision,
      writeFarmDecisionFact,
    });

    expect(recordHumanDecision).toHaveBeenCalled();
    expect(answerCbQuery).toHaveBeenCalledWith('Discarded ✓');
  });
});

// ---------------------------------------------------------------------------
// Open PR (p)
// ---------------------------------------------------------------------------

describe('handleFarmCallback — Open PR (p)', () => {
  const prUrl = 'https://github.com/org/repo/pull/42';
  const winnerBranch = { index: 1, path: '/tmp/farm/branch-1', branch: 'afk/farm/my-slug/1-branch-1' };

  it('success path: resolves winner, creates PR, records it, acks and replies', async () => {
    const manifest = makeManifest();
    const checkGhReady = vi.fn().mockResolvedValue({ ok: true });
    const createPr = vi.fn().mockResolvedValue(prUrl);
    const recordPrCreated = vi.fn().mockResolvedValue({ ...manifest, prUrl });
    const { ctx, answerCbQuery, reply } = makeCtx('afk:f:p:my-slug');

    await handleFarmCallback(ctx, {
      loadFarm: async () => manifest,
      checkGhReady,
      resolveWinnerBranch: async () => ({ source: 'winner', branch: winnerBranch }),
      createPr,
      recordPrCreated,
    });

    expect(createPr).toHaveBeenCalledWith(
      expect.objectContaining({ head: winnerBranch.branch }),
    );
    expect(recordPrCreated).toHaveBeenCalledWith('my-slug', prUrl);
    // Progress ack 'Opening PR…' is the single answerCbQuery; success is now a ctx.reply.
    expect(answerCbQuery).toHaveBeenCalledWith('Opening PR…');
    expect(reply).toHaveBeenCalledWith(expect.stringContaining(prUrl));
  });

  it('idempotency: manifest has prUrl set → acks with existing URL, createPr not called', async () => {
    const manifest = makeManifest({ prUrl });
    const createPr = vi.fn();
    const { ctx, answerCbQuery } = makeCtx('afk:f:p:my-slug');

    await handleFarmCallback(ctx, {
      loadFarm: async () => manifest,
      createPr,
    });

    expect(createPr).not.toHaveBeenCalled();
    expect(answerCbQuery).toHaveBeenCalledWith(expect.stringContaining(prUrl));
  });

  it('pre-flight checkGhReady failure: progress-ack fires then hint is replied, createPr not called', async () => {
    const manifest = makeManifest();
    const hint = '`gh` CLI not found — install with: brew install gh';
    const checkGhReady = vi.fn().mockResolvedValue({ ok: false, hint });
    const createPr = vi.fn();
    const { ctx, answerCbQuery, reply } = makeCtx('afk:f:p:my-slug');

    await handleFarmCallback(ctx, {
      loadFarm: async () => manifest,
      checkGhReady,
      createPr,
    });

    expect(createPr).not.toHaveBeenCalled();
    // Progress ack fires first (only answerCbQuery call); hint arrives via ctx.reply.
    expect(answerCbQuery).toHaveBeenCalledWith('Opening PR…');
    expect(reply).toHaveBeenCalledWith(hint);
  });

  it('winner lookup failure: progress-ack fires then "Winner lookup failed" is replied, createPr not called', async () => {
    const manifest = makeManifest();
    const checkGhReady = vi.fn().mockResolvedValue({ ok: true });
    const createPr = vi.fn();
    const { ctx, answerCbQuery, reply } = makeCtx('afk:f:p:my-slug');

    await handleFarmCallback(ctx, {
      loadFarm: async () => manifest,
      checkGhReady,
      resolveWinnerBranch: async () => { throw new Error('no scores'); },
      createPr,
    });

    expect(createPr).not.toHaveBeenCalled();
    // Progress ack fires first; error arrives via ctx.reply.
    expect(answerCbQuery).toHaveBeenCalledWith('Opening PR…');
    expect(reply).toHaveBeenCalledWith('Winner lookup failed');
  });

  it('createPr already-exists: progress-ack fires then "PR already exists" is replied', async () => {
    const manifest = makeManifest();
    const checkGhReady = vi.fn().mockResolvedValue({ ok: true });
    const { GhError } = await import('../../agent/gh.js');
    const createPr = vi.fn().mockRejectedValue(
      new GhError('already exists', 'already-exists', 1, 'already exists'),
    );
    const { ctx, answerCbQuery, reply } = makeCtx('afk:f:p:my-slug');

    await handleFarmCallback(ctx, {
      loadFarm: async () => manifest,
      checkGhReady,
      resolveWinnerBranch: async () => ({ source: 'winner', branch: winnerBranch }),
      createPr,
    });

    // Progress ack fires first; GhError message arrives via ctx.reply.
    expect(answerCbQuery).toHaveBeenCalledWith('Opening PR…');
    expect(reply).toHaveBeenCalledWith('PR already exists for this branch');
  });

  it('createPr network error: progress-ack fires then "Network error" is replied', async () => {
    const manifest = makeManifest();
    const checkGhReady = vi.fn().mockResolvedValue({ ok: true });
    const { GhError } = await import('../../agent/gh.js');
    const createPr = vi.fn().mockRejectedValue(
      new GhError('network error', 'network', 1, ''),
    );
    const { ctx, answerCbQuery, reply } = makeCtx('afk:f:p:my-slug');

    await handleFarmCallback(ctx, {
      loadFarm: async () => manifest,
      checkGhReady,
      resolveWinnerBranch: async () => ({ source: 'winner', branch: winnerBranch }),
      createPr,
    });

    // Progress ack fires first; GhError message arrives via ctx.reply.
    expect(answerCbQuery).toHaveBeenCalledWith('Opening PR…');
    expect(reply).toHaveBeenCalledWith('Network error — check gh connectivity');
  });

  it('createPr unknown error: progress-ack fires then "gh pr create failed" is replied', async () => {
    const manifest = makeManifest();
    const checkGhReady = vi.fn().mockResolvedValue({ ok: true });
    const { GhError } = await import('../../agent/gh.js');
    const createPr = vi.fn().mockRejectedValue(
      new GhError('unknown failure', 'unknown', 1, ''),
    );
    const { ctx, answerCbQuery, reply } = makeCtx('afk:f:p:my-slug');

    await handleFarmCallback(ctx, {
      loadFarm: async () => manifest,
      checkGhReady,
      resolveWinnerBranch: async () => ({ source: 'winner', branch: winnerBranch }),
      createPr,
    });

    // Progress ack fires first; GhError message arrives via ctx.reply.
    expect(answerCbQuery).toHaveBeenCalledWith('Opening PR…');
    expect(reply).toHaveBeenCalledWith('gh pr create failed — see daemon logs');
  });

  it('recordPrCreated failure is best-effort: still fires progress-ack and replies with success', async () => {
    const manifest = makeManifest();
    const checkGhReady = vi.fn().mockResolvedValue({ ok: true });
    const createPr = vi.fn().mockResolvedValue(prUrl);
    const recordPrCreated = vi.fn().mockRejectedValue(new Error('disk full'));
    const { ctx, answerCbQuery, reply } = makeCtx('afk:f:p:my-slug');

    await handleFarmCallback(ctx, {
      loadFarm: async () => manifest,
      checkGhReady,
      resolveWinnerBranch: async () => ({ source: 'winner', branch: winnerBranch }),
      createPr,
      recordPrCreated,
    });

    // Progress ack fires; success message (including URL) arrives via ctx.reply.
    expect(answerCbQuery).toHaveBeenCalledWith('Opening PR…');
    expect(reply).toHaveBeenCalledWith(expect.stringContaining(prUrl));
  });
});

// ---------------------------------------------------------------------------
// Full diff is read-only
// ---------------------------------------------------------------------------

describe('handleFarmCallback — Full diff (d)', () => {
  it('replies with git log + stat output and never mutates state', async () => {
    const manifest = makeManifest();
    const recordHumanDecision = vi.fn();
    const writeFarmDecisionFact = vi.fn();
    const execGit = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === 'log') return { stdout: 'abc123 add jose', stderr: '' };
      if (args[0] === 'diff') return { stdout: ' src/auth.ts | 12 +++++++-----', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const { ctx, answerCbQuery, reply } = makeCtx('afk:f:d:my-slug');

    await handleFarmCallback(ctx, {
      loadFarm: async () => manifest,
      recordHumanDecision,
      writeFarmDecisionFact,
      execGit,
      // Single-branch manifest — winner resolution trivially picks branch-1.
      resolveWinnerBranch: async (m) => ({ branch: m.branches[0]!, source: 'winner' }),
    });

    expect(recordHumanDecision).not.toHaveBeenCalled();
    expect(writeFarmDecisionFact).not.toHaveBeenCalled();
    expect(answerCbQuery).toHaveBeenCalledWith('Computing diff…');
    expect(reply).toHaveBeenCalled();
    const body = reply.mock.calls[0]?.[0] as string;
    expect(body).toContain('abc123 add jose');
    expect(body).toContain('src/auth.ts');
    expect(body).toContain(manifest.branches[0]!.branch);
  });

  it('runs git in the WINNING branch worktree, not branches[0]', async () => {
    // Three branches: branch-1 exists at index 0 of the array, branch-2 is
    // the winner. If the handler ever falls back to `manifest.branches[0]`
    // (the old bug), `execGit` will receive branch-1's path and this test
    // will fail.
    const manifest = makeManifest({
      branches: [
        { index: 1, path: '/tmp/farm/branch-1', branch: 'afk/farm/my-slug/1-a' },
        { index: 2, path: '/tmp/farm/branch-2', branch: 'afk/farm/my-slug/2-b' },
        { index: 3, path: '/tmp/farm/branch-3', branch: 'afk/farm/my-slug/3-c' },
      ],
    });
    const winnerBranch = manifest.branches[1]!; // index: 2

    const execGit = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === 'log') return { stdout: 'def456 winner commit', stderr: '' };
      if (args[0] === 'diff') return { stdout: ' src/winner.ts | 9 +++++----', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const { ctx, reply } = makeCtx('afk:f:d:my-slug');

    await handleFarmCallback(ctx, {
      loadFarm: async () => manifest,
      resolveWinnerBranch: async () => ({ branch: winnerBranch, source: 'winner' }),
      execGit,
    });

    // Every git invocation must use branch-2's worktree path.
    expect(execGit).toHaveBeenCalled();
    for (const call of execGit.mock.calls) {
      expect(call[0]).toBe(winnerBranch.path);
      expect(call[0]).not.toBe(manifest.branches[0]!.path);
    }

    // Reply names branch-2, not branch-1.
    const body = reply.mock.calls[0]?.[0] as string;
    expect(body).toContain(winnerBranch.branch);
    expect(body).not.toContain(manifest.branches[0]!.branch);
    expect(body).toContain('← winner');
  });

  it('annotates the reply when falling back to top-scored (no clean test pass)', async () => {
    const manifest = makeManifest({
      branches: [
        { index: 1, path: '/tmp/farm/branch-1', branch: 'afk/farm/my-slug/1-a' },
        { index: 2, path: '/tmp/farm/branch-2', branch: 'afk/farm/my-slug/2-b' },
      ],
    });
    const execGit = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const { ctx, reply } = makeCtx('afk:f:d:my-slug');

    await handleFarmCallback(ctx, {
      loadFarm: async () => manifest,
      resolveWinnerBranch: async () => ({
        branch: manifest.branches[1]!,
        source: 'top-scored',
      }),
      execGit,
    });

    const body = reply.mock.calls[0]?.[0] as string;
    expect(body).toMatch(/top-scored/);
  });

  it('answers "Winner lookup failed" if the resolver throws', async () => {
    const manifest = makeManifest();
    const { ctx, answerCbQuery, reply } = makeCtx('afk:f:d:my-slug');

    await handleFarmCallback(ctx, {
      loadFarm: async () => manifest,
      resolveWinnerBranch: async () => {
        throw new Error('disk on fire');
      },
      execGit: vi.fn(),
    });

    expect(answerCbQuery).toHaveBeenCalledWith('Winner lookup failed');
    expect(reply).not.toHaveBeenCalled();
  });

  it('replies with a friendly error when git fails', async () => {
    const manifest = makeManifest();
    const execGit = vi.fn(async () => {
      throw new Error('git not found');
    });
    const { ctx, reply } = makeCtx('afk:f:d:my-slug');

    await handleFarmCallback(ctx, {
      loadFarm: async () => manifest,
      resolveWinnerBranch: async (m) => ({ branch: m.branches[0]!, source: 'winner' }),
      execGit,
    });

    expect(reply).toHaveBeenCalledWith(expect.stringMatching(/Diff failed/i));
  });
});

// ---------------------------------------------------------------------------
// Respawn from winner (r) — fully implemented in Day 4c
// ---------------------------------------------------------------------------

describe('handleFarmCallback — Respawn (r)', () => {
  const winnerBranch = { index: 1, path: '/tmp/farm/branch-1', branch: 'afk/farm/my-slug/1-branch-1' };

  it('happy path: spawns child farm with correct args, records respawn, acks and replies', async () => {
    const manifest = makeManifest();
    const spawnFarm = vi.fn();
    const recordRespawnFn = vi.fn().mockResolvedValue({ ...manifest, respawnedAs: '20260514T120000-my-task-abcd' });
    const { ctx, answerCbQuery, reply } = makeCtx('afk:f:r:my-slug');

    await handleFarmCallback(ctx, {
      loadFarm: async () => manifest,
      resolveWinnerBranch: async () => ({ source: 'score', branch: winnerBranch }),
      spawnFarm,
      recordRespawn: recordRespawnFn,
      _now: () => new Date('2026-05-14T12:00:00.000Z'),
      _randomSuffix: () => 'abcd',
    });

    const childSlug = '20260514T120000-my-task-abcd'; // derived from taskName 'My task'
    expect(spawnFarm).toHaveBeenCalledWith([
      'farm', 'My task',
      '--branches', '1',
      '--base-ref', 'afk/farm/my-slug/1-branch-1',
      '--task-slug', childSlug,
    ]);
    expect(recordRespawnFn).toHaveBeenCalledWith('my-slug', childSlug);
    expect(answerCbQuery).toHaveBeenCalledWith(expect.stringMatching(/Respawning/i));
    expect(reply).toHaveBeenCalled();
  });

  it('idempotency: does not spawn or record when respawnedAs is already set', async () => {
    const manifest = makeManifest({ respawnedAs: 'existing-child-slug' });
    const spawnFarm = vi.fn();
    const recordRespawnFn = vi.fn();
    const { ctx, answerCbQuery } = makeCtx('afk:f:r:my-slug');

    await handleFarmCallback(ctx, {
      loadFarm: async () => manifest,
      resolveWinnerBranch: vi.fn(),
      spawnFarm,
      recordRespawn: recordRespawnFn,
    });

    expect(spawnFarm).not.toHaveBeenCalled();
    expect(recordRespawnFn).not.toHaveBeenCalled();
    expect(answerCbQuery).toHaveBeenCalledWith(
      expect.stringMatching(/Already respawned as existing-child-slug/),
    );
  });

  it('fallback-first-branch: proceeds with fallback source branch', async () => {
    const manifest = makeManifest();
    const spawnFarm = vi.fn();
    const recordRespawnFn = vi.fn().mockResolvedValue(manifest);
    const { ctx, answerCbQuery } = makeCtx('afk:f:r:my-slug');

    await handleFarmCallback(ctx, {
      loadFarm: async () => manifest,
      resolveWinnerBranch: async () => ({ source: 'fallback-first-branch', branch: winnerBranch }),
      spawnFarm,
      recordRespawn: recordRespawnFn,
      _now: () => new Date('2026-05-14T12:00:00.000Z'),
      _randomSuffix: () => 'abcd',
    });

    expect(spawnFarm).toHaveBeenCalledWith(expect.arrayContaining([
      '--base-ref', 'afk/farm/my-slug/1-branch-1',
    ]));
    expect(answerCbQuery).toHaveBeenCalledWith(expect.stringMatching(/Respawning/i));
  });

  it('spawn failure: progress-ack fires then "Respawn failed" is replied, does not record respawn', async () => {
    const manifest = makeManifest();
    const recordRespawnFn = vi.fn();
    const { ctx, answerCbQuery, reply } = makeCtx('afk:f:r:my-slug');

    await handleFarmCallback(ctx, {
      loadFarm: async () => manifest,
      resolveWinnerBranch: async () => ({ source: 'score', branch: winnerBranch }),
      spawnFarm: vi.fn(() => { throw new Error('spawn failed'); }),
      recordRespawn: recordRespawnFn,
      _now: () => new Date('2026-05-14T12:00:00.000Z'),
      _randomSuffix: () => 'abcd',
    });

    // Progress ack fires first; error arrives via ctx.reply.
    expect(answerCbQuery).toHaveBeenCalledWith('Respawning…');
    expect(reply).toHaveBeenCalledWith('Respawn failed');
    expect(recordRespawnFn).not.toHaveBeenCalled();
  });

  it('winner resolution failure: progress-ack fires then "Winner lookup failed" is replied, neither spawns nor records', async () => {
    const manifest = makeManifest();
    const spawnFarm = vi.fn();
    const recordRespawnFn = vi.fn();
    const { ctx, answerCbQuery, reply } = makeCtx('afk:f:r:my-slug');

    await handleFarmCallback(ctx, {
      loadFarm: async () => manifest,
      resolveWinnerBranch: async () => { throw new Error('no scores'); },
      spawnFarm,
      recordRespawn: recordRespawnFn,
    });

    // Progress ack fires first; error arrives via ctx.reply.
    expect(answerCbQuery).toHaveBeenCalledWith('Respawning…');
    expect(reply).toHaveBeenCalledWith('Winner lookup failed');
    expect(spawnFarm).not.toHaveBeenCalled();
    expect(recordRespawnFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T2: checkGhReady throwing inside handleOpenPr
// ---------------------------------------------------------------------------

describe('handleFarmCallback — checkGhReady throws (T2)', () => {
  it('progress-ack fires then readiness-check failure message is replied when checkGhReady rejects', async () => {
    const manifest = makeManifest();
    const { ctx, answerCbQuery, reply } = makeCtx('afk:f:p:my-slug');
    await handleFarmCallback(ctx, {
      loadFarm: vi.fn().mockResolvedValue(manifest),
      checkGhReady: vi.fn().mockRejectedValue(new Error('boom')),
    });
    // handleOpenPr sends 'Opening PR…' BEFORE checkGhReady (C2 early-ack) as
    // the single answerCbQuery. The error then arrives via ctx.reply.
    expect(answerCbQuery).toHaveBeenCalledWith('Opening PR…');
    expect(reply).toHaveBeenCalledWith(
      expect.stringMatching(/gh readiness check failed/i),
    );
  });
});

// ---------------------------------------------------------------------------
// T3: createPr throws a plain Error (not GhError)
// ---------------------------------------------------------------------------

describe('handleFarmCallback — createPr plain Error (T3)', () => {
  it('progress-ack fires then "gh pr create failed" is replied when createPr throws a non-GhError', async () => {
    const manifest = makeManifest();
    const { ctx, answerCbQuery, reply } = makeCtx('afk:f:p:my-slug');
    await handleFarmCallback(ctx, {
      loadFarm: vi.fn().mockResolvedValue(manifest),
      checkGhReady: vi.fn().mockResolvedValue({ ok: true }),
      resolveWinnerBranch: vi.fn().mockResolvedValue({
        branch: manifest.branches[0],
        source: 'winner',
      }),
      createPr: vi.fn().mockRejectedValue(new Error('exploded')),
    });
    // Progress ack fires first; error arrives via ctx.reply.
    expect(answerCbQuery).toHaveBeenCalledWith('Opening PR…');
    expect(reply).toHaveBeenCalledWith(
      expect.stringMatching(/gh pr create failed/i),
    );
  });
});

// ---------------------------------------------------------------------------
// T5: recordRespawn rejects — ack still fires
// ---------------------------------------------------------------------------

describe('handleFarmCallback — recordRespawn rejects (T5)', () => {
  it('still fires progress-ack and replies with success when recordRespawn rejects (best-effort)', async () => {
    const manifest = makeManifest();
    const { ctx, answerCbQuery, reply } = makeCtx('afk:f:r:my-slug');
    await handleFarmCallback(ctx, {
      loadFarm: vi.fn().mockResolvedValue(manifest),
      resolveWinnerBranch: vi.fn().mockResolvedValue({
        branch: manifest.branches[0],
        source: 'winner',
      }),
      spawnFarm: vi.fn(), // no-op
      recordRespawn: vi.fn().mockRejectedValue(new Error('db locked')),
      _now: () => new Date('2026-05-14T15:07:24Z'),
      _randomSuffix: () => 'abcd',
    });
    // handleRespawn sends 'Respawning…' (C2 progress ack) as the single
    // answerCbQuery call. The terminal success is now a ctx.reply.
    expect(answerCbQuery).toHaveBeenCalledWith('Respawning…');
    expect(reply).toHaveBeenCalledWith(expect.stringMatching(/Respawning/i));
  });
});

// ---------------------------------------------------------------------------
// C3: Empty branches guard in handleRespawn
// ---------------------------------------------------------------------------

describe('handleFarmCallback — empty branches guard (C3)', () => {
  it('acks with "No branches remain" when manifest.branches is empty', async () => {
    const manifest = makeManifest({ branches: [] });
    const { ctx, answerCbQuery } = makeCtx('afk:f:r:my-slug');
    const spawnFarm = vi.fn();
    await handleFarmCallback(ctx, {
      loadFarm: vi.fn().mockResolvedValue(manifest),
      spawnFarm,
    });
    expect(answerCbQuery).toHaveBeenCalledWith(
      expect.stringMatching(/No branches remain/i),
    );
    expect(spawnFarm).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Concurrent dispatch under action lock (M1 — Issues 1 & 2 regression tests)
// ---------------------------------------------------------------------------

describe('concurrent dispatch under action lock', () => {
  const winnerBranch = { index: 1, path: '/tmp/farm/branch-1', branch: 'afk/farm/my-slug/1-branch-1' };

  /**
   * Test 1: Two concurrent taps for the same slug both succeed.
   * Tap 1 holds the lock; tap 2 waits, then re-reads the manifest and runs
   * independently. Handler is called once per tap (idempotency inside the
   * handler is a separate concern); both taps get their own answerCbQuery.
   */
  it('serialization: two concurrent taps both succeed; each gets a progress ack', async () => {
    const manifest = makeManifest();

    // Gate tap-1's loadFarm so we can hold it in-flight.
    let resolveTap1Load!: (m: FarmManifest) => void;
    const tap1LoadPromise = new Promise<FarmManifest>((resolve) => {
      resolveTap1Load = resolve;
    });

    let tap1LoadCalled = false;
    let tap2LoadCalled = false;

    const loadFarmFn = vi.fn((_slug: string) => {
      if (!tap1LoadCalled) {
        tap1LoadCalled = true;
        return tap1LoadPromise;
      }
      tap2LoadCalled = true;
      return Promise.resolve(manifest);
    });

    const { ctx: ctx1, answerCbQuery: acq1 } = makeCtx('afk:f:p:my-slug');
    const { ctx: ctx2, answerCbQuery: acq2 } = makeCtx('afk:f:p:my-slug');

    const sharedDeps = {
      loadFarm: loadFarmFn,
      checkGhReady: vi.fn().mockResolvedValue({ ok: true }),
      resolveWinnerBranch: vi.fn().mockResolvedValue({ source: 'winner', branch: winnerBranch }),
      createPr: vi.fn().mockResolvedValue('https://github.com/org/repo/pull/1'),
      recordPrCreated: vi.fn().mockResolvedValue(manifest),
    };

    // Fire both taps concurrently without awaiting.
    const p1 = handleFarmCallback(ctx1, sharedDeps);
    const p2 = handleFarmCallback(ctx2, sharedDeps);

    // Unblock tap 1's manifest load so its handler runs to completion.
    resolveTap1Load(manifest);

    // Wait for both to settle.
    await Promise.all([p1, p2]);

    // Tap 2 must have done a fresh loadFarm after tap 1 settled.
    expect(tap2LoadCalled).toBe(true);

    // Both taps must have fired their own progress ack.
    expect(acq1).toHaveBeenCalledWith('Opening PR…');
    expect(acq2).toHaveBeenCalledWith('Opening PR…');
  });

  /**
   * Test 2: Tap 1 rejecting its handler does NOT poison tap 2.
   * After the fix (try/catch around `await existing`), tap 2 continues
   * independently: it re-reads the manifest and calls the handler, which
   * fires its own progress ack. The outer dispatch catch must NOT swallow
   * tap 2's flow — tap 2's answerCbQuery must NOT be 'Internal error'.
   */
  it('tap 1 rejection does not poison tap 2: tap 2 acks independently', async () => {
    const manifest = makeManifest();

    // Gate: tap 1's handler will be held in-flight then rejected.
    let rejectTap1!: (err: Error) => void;
    const tap1HandlerPromise = new Promise<never>((_resolve, reject) => {
      rejectTap1 = reject;
    });

    // The shared loadFarm always resolves immediately for tap 2's re-read.
    const loadFarmFn = vi.fn().mockResolvedValue(manifest);

    // Track how many times the handler mock is called.
    let handlerCallCount = 0;

    const handlerMock = vi.fn((_ctx: Context, _m: FarmManifest, _d: typeof sharedDeps, _log: LogFn) => {
      handlerCallCount++;
      if (handlerCallCount === 1) {
        // Tap 1: return a promise that will reject later.
        return tap1HandlerPromise;
      }
      // Tap 2: succeed (answerCbQuery is called by the handler path).
      return Promise.resolve();
    });

    type LogFn = (...args: unknown[]) => void;

    const { ctx: ctx1, answerCbQuery: acq1 } = makeCtx('afk:f:p:my-slug');
    const { ctx: ctx2, answerCbQuery: acq2 } = makeCtx('afk:f:p:my-slug');

    // We need to inject the handler directly. Since withActionLock is internal,
    // we exercise it via the 'p' action path. But we can gate checkGhReady so
    // handleOpenPr can stand in for a handler that rejects.
    let rejectGhReady!: (err: Error) => void;
    const ghReadyTap1 = new Promise<never>((_resolve, reject) => {
      rejectGhReady = reject;
    });

    let ghReadyCallCount = 0;
    const checkGhReadyFn = vi.fn(() => {
      ghReadyCallCount++;
      if (ghReadyCallCount === 1) {
        return ghReadyTap1; // will reject
      }
      return Promise.resolve({ ok: false, hint: 'tap-2-ok' });
    });

    const sharedDeps = {
      loadFarm: loadFarmFn,
      checkGhReady: checkGhReadyFn,
      resolveWinnerBranch: vi.fn(),
      createPr: vi.fn(),
      recordPrCreated: vi.fn(),
    };

    // Fire both concurrently.
    const p1 = handleFarmCallback(ctx1, sharedDeps);
    const p2 = handleFarmCallback(ctx2, sharedDeps);

    // Reject tap 1's in-flight work.
    rejectGhReady(new Error('tap-1 boom'));

    // Wait for both to settle (handleFarmCallback never throws externally).
    await Promise.all([p1, p2]);

    // Tap 2's answerCbQuery must NOT be 'Internal error' — tap 2 must have
    // continued past the lock and reached its own handler path.
    const tap2Calls = acq2.mock.calls.map((c) => c[0]);
    expect(tap2Calls).not.toContain('Internal error');
    // Tap 2 must have fired at least one answerCbQuery (its progress ack or
    // the gh-not-ready hint reply path).
    expect(acq2).toHaveBeenCalled();
  });

  /**
   * Test 3: Triple-tap — taps 2 and 3 both join the in-flight lock promise.
   * This tests the Issue 2 fix: the map stores the raw promise (not the
   * .finally()-chained promise), so tap 3 arriving while tap 1 is in-flight
   * still finds a non-undefined entry in actionLocks. All three taps complete
   * without unhandled rejections.
   *
   * Note: the current lock design serializes taps that arrive WHILE tap 1 is
   * in-flight. After tap 1 settles, taps 2 and 3 both resume concurrently —
   * mutual exclusion beyond the first lock is a future enhancement (would
   * require promise-chaining or a queue). The invariant tested here is weaker:
   * "no tap is dropped or causes an unhandled rejection in a triple-tap race".
   */
  it('triple-tap: all three taps complete without unhandled rejections', async () => {
    const manifest = makeManifest();

    // Gate: hold tap 1 in-flight while taps 2 and 3 also arrive.
    let resolveTap1!: () => void;
    const tap1Gate = new Promise<void>((resolve) => { resolveTap1 = resolve; });

    let checkGhCallCount = 0;
    const checkGhReadyFn = vi.fn(() => {
      checkGhCallCount++;
      if (checkGhCallCount === 1) {
        // Tap 1's handler: parked until we release it.
        return tap1Gate.then(() => ({ ok: false as const, hint: 'done' }));
      }
      // Taps 2 and 3: resolve immediately.
      return Promise.resolve({ ok: false as const, hint: 'done' });
    });

    const loadFarmFn = vi.fn().mockResolvedValue(manifest);

    const { ctx: ctx1, answerCbQuery: acq1 } = makeCtx('afk:f:p:my-slug');
    const { ctx: ctx2, answerCbQuery: acq2 } = makeCtx('afk:f:p:my-slug');
    const { ctx: ctx3, answerCbQuery: acq3 } = makeCtx('afk:f:p:my-slug');

    const sharedDeps = {
      loadFarm: loadFarmFn,
      checkGhReady: checkGhReadyFn,
      resolveWinnerBranch: vi.fn(),
      createPr: vi.fn(),
      recordPrCreated: vi.fn(),
    };

    // Fire all three concurrently.
    const p1 = handleFarmCallback(ctx1, sharedDeps);
    const p2 = handleFarmCallback(ctx2, sharedDeps);
    const p3 = handleFarmCallback(ctx3, sharedDeps);

    // Yield to microtask queue so taps 2 and 3 register on the lock.
    await new Promise((r) => setTimeout(r, 0));

    // Release tap 1's gate.
    resolveTap1();

    // All three must settle without throwing (handleFarmCallback never throws).
    await expect(Promise.all([p1, p2, p3])).resolves.not.toThrow();

    // All three must have fired at least a progress ack.
    expect(acq1).toHaveBeenCalledWith('Opening PR…');
    expect(acq2).toHaveBeenCalledWith('Opening PR…');
    expect(acq3).toHaveBeenCalledWith('Opening PR…');
  });
});
