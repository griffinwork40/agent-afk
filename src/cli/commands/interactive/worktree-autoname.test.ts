/**
 * Tests for the worktree autoname pipeline.
 *
 * Covers:
 *   - sanitizeSlug regex + salvage path
 *   - generateSlugFromPrompt happy + timeout + abort + empty-message paths
 *   - runFirstTurnAutoname end-to-end with a stubbed DeferredWorktree + session
 *
 * The haiku call is always stubbed via `slugGenerator`; no real SDK is
 * exercised here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sanitizeSlug,
  generateSlugFromPrompt,
  pinProcessCwd,
  runFirstTurnAutoname,
  type SkipReason,
} from './worktree-autoname.js';
import type { WorktreeHandle, DeferredWorktree } from './worktree.js';

describe('sanitizeSlug', () => {
  it('accepts a well-formed kebab slug', () => {
    expect(sanitizeSlug('fix-cleanup-race')).toBe('fix-cleanup-race');
    expect(sanitizeSlug('add-telegram-allowlist')).toBe('add-telegram-allowlist');
    expect(sanitizeSlug('two-words')).toBe('two-words');
  });

  it('lowercases capitals', () => {
    expect(sanitizeSlug('Fix-Cleanup-Race')).toBe('fix-cleanup-race');
  });

  it('rejects single-word output (must be 2-4 hyphenated words)', () => {
    expect(sanitizeSlug('refactor')).toBeNull();
  });

  it('rejects slugs longer than 30 chars after salvage', () => {
    // 31 chars, well-formed kebab — salvage truncates at hyphen boundary
    const long = 'aaaa-bbbb-cccc-dddd-eeee-fffff';
    const result = sanitizeSlug(long);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(30);
  });

  it('salvages noisy output by collapsing non-alphanumeric runs', () => {
    expect(sanitizeSlug('Fix the cleanup race!')).toBe('fix-the-cleanup-race');
  });

  it('salvages with leading/trailing punctuation', () => {
    expect(sanitizeSlug('  --fix-cleanup-race--  ')).toBe('fix-cleanup-race');
  });

  it('returns null for an empty string', () => {
    expect(sanitizeSlug('')).toBeNull();
    expect(sanitizeSlug('   ')).toBeNull();
  });

  it('returns null for pure punctuation', () => {
    expect(sanitizeSlug('!!!---!!!')).toBeNull();
  });

  it('returns null when salvage produces a single-word result', () => {
    expect(sanitizeSlug('?????refactor?????')).toBeNull();
  });

  it('truncates at hyphen boundary when overlong', () => {
    // 12 4-letter words → far over 30 chars; should truncate cleanly
    const long = 'abcd-efgh-ijkl-mnop-qrst-uvwx-yzab-cdef';
    const result = sanitizeSlug(long);
    // Must be a valid slug ≤30 chars
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(30);
    expect(result).toMatch(/^[a-z0-9]+(-[a-z0-9]+){1,3}$/);
  });
});

describe('generateSlugFromPrompt', () => {
  let tmpRoot: string;
  let afkRoot: string;
  let worktreePath: string;

  beforeEach(() => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'afk-autoname-test-')));
    afkRoot = join(tmpRoot, '.afk-worktrees');
    worktreePath = join(afkRoot, 'afk-20260517-aaaaaa');
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns the model-emitted slug verbatim when it satisfies the regex', async () => {
    const result = await generateSlugFromPrompt('fix the cleanup race in worktree.ts', {
      token: 'sk-ant-test',
      worktreePath,
      slugGenerator: async () => 'fix-cleanup-race',
    });
    expect(result).toBe('fix-cleanup-race');
  });

  it('sanitizes loosely-formatted model output', async () => {
    const result = await generateSlugFromPrompt('fix the cleanup race', {
      token: 'sk-ant-test',
      worktreePath,
      slugGenerator: async () => 'Fix Cleanup Race!',
    });
    expect(result).toBe('fix-cleanup-race');
  });

  it('returns null for empty messages without invoking the generator', async () => {
    const generator = vi.fn();
    const result = await generateSlugFromPrompt('   ', {
      token: 'sk-ant-test',
      worktreePath,
      slugGenerator: generator,
    });
    expect(result).toBeNull();
    expect(generator).not.toHaveBeenCalled();
  });

  it('returns null for slash-command messages without invoking the generator', async () => {
    const generator = vi.fn();
    const result = await generateSlugFromPrompt('/help', {
      token: 'sk-ant-test',
      worktreePath,
      slugGenerator: generator,
    });
    expect(result).toBeNull();
    expect(generator).not.toHaveBeenCalled();
  });

  it('returns null when the generator throws (network error fallback)', async () => {
    const result = await generateSlugFromPrompt('fix the cleanup race', {
      token: 'sk-ant-test',
      worktreePath,
      slugGenerator: async () => {
        throw new Error('network down');
      },
    });
    expect(result).toBeNull();
  });

  it('returns null when the generator yields unsalvageable output', async () => {
    const result = await generateSlugFromPrompt('fix this', {
      token: 'sk-ant-test',
      worktreePath,
      slugGenerator: async () => '!!!@@@###',
    });
    expect(result).toBeNull();
  });

  it('appends a 4-char hex suffix when the directory already exists', async () => {
    // Create the colliding dir
    await fs.mkdir(join(afkRoot, 'fix-cleanup-race'), { recursive: true });
    const result = await generateSlugFromPrompt('fix the cleanup race', {
      token: 'sk-ant-test',
      worktreePath,
      slugGenerator: async () => 'fix-cleanup-race',
    });
    expect(result).toMatch(/^fix-cleanup-race-[0-9a-f]{4}$/);
  });

  it('honors a timeout — slow generator yields null', async () => {
    const result = await generateSlugFromPrompt('slow thing', {
      token: 'sk-ant-test',
      worktreePath,
      timeoutMs: 50,
      slugGenerator: async (_msg, signal) => {
        // Resolve after 200ms unless aborted. Race the abort signal.
        return new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => resolve('fix-cleanup-race'), 200);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      },
    });
    expect(result).toBeNull();
  });

  it('honors caller abort signal', async () => {
    const controller = new AbortController();
    const promise = generateSlugFromPrompt('cancel me', {
      token: 'sk-ant-test',
      worktreePath,
      signal: controller.signal,
      slugGenerator: async (_msg, signal) => {
        return new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => resolve('fix-cleanup-race'), 5_000);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      },
    });
    controller.abort();
    const result = await promise;
    expect(result).toBeNull();
  });

  // Skip-reason callback machinery — covers the diagnostic signal that
  // lets the UI render a dim line when the autoname pipeline no-ops.
  describe('onSkip callback', () => {
    it('fires with "empty-message" for whitespace input', async () => {
      const onSkip = vi.fn();
      const result = await generateSlugFromPrompt('   ', {
        token: 'sk-ant-test',
        worktreePath,
        slugGenerator: async () => 'fix-cleanup-race',
        onSkip,
      });
      expect(result).toBeNull();
      expect(onSkip).toHaveBeenCalledTimes(1);
      expect(onSkip).toHaveBeenCalledWith('empty-message');
    });

    it('fires with "slash-command" for slash-prefixed input', async () => {
      const onSkip = vi.fn();
      const result = await generateSlugFromPrompt('/help me', {
        token: 'sk-ant-test',
        worktreePath,
        slugGenerator: async () => 'fix-cleanup-race',
        onSkip,
      });
      expect(result).toBeNull();
      expect(onSkip).toHaveBeenCalledWith('slash-command');
    });

    it('fires with "slug-generator-error" + error message when generator throws', async () => {
      const onSkip = vi.fn();
      const result = await generateSlugFromPrompt('fix the bug', {
        token: 'sk-ant-test',
        worktreePath,
        slugGenerator: async () => {
          throw new Error('401 invalid bearer token');
        },
        onSkip,
      });
      expect(result).toBeNull();
      expect(onSkip).toHaveBeenCalledTimes(1);
      expect(onSkip).toHaveBeenCalledWith('slug-generator-error', '401 invalid bearer token');
    });

    it('fires with "slug-generator-error" and a bounded detail (≤200 chars)', async () => {
      const onSkip = vi.fn();
      const longMessage = 'x'.repeat(500);
      await generateSlugFromPrompt('fix something', {
        token: 'sk-ant-test',
        worktreePath,
        slugGenerator: async () => {
          throw new Error(longMessage);
        },
        onSkip,
      });
      expect(onSkip).toHaveBeenCalledTimes(1);
      const [reason, detail] = onSkip.mock.calls[0] as [SkipReason, string];
      expect(reason).toBe('slug-generator-error');
      expect(detail.length).toBeLessThanOrEqual(200);
    });

    it('fires with "invalid-slug-output" + raw output when sanitize rejects', async () => {
      const onSkip = vi.fn();
      const result = await generateSlugFromPrompt('fix this', {
        token: 'sk-ant-test',
        worktreePath,
        slugGenerator: async () => '!!!@@@###',
        onSkip,
      });
      expect(result).toBeNull();
      expect(onSkip).toHaveBeenCalledTimes(1);
      expect(onSkip).toHaveBeenCalledWith('invalid-slug-output', '!!!@@@###');
    });

    it('does NOT fire on the happy path', async () => {
      const onSkip = vi.fn();
      const result = await generateSlugFromPrompt('fix the cleanup race', {
        token: 'sk-ant-test',
        worktreePath,
        slugGenerator: async () => 'fix-cleanup-race',
        onSkip,
      });
      expect(result).toBe('fix-cleanup-race');
      expect(onSkip).not.toHaveBeenCalled();
    });
  });
});

describe('runFirstTurnAutoname (born-named creation)', () => {
  let tmpRoot: string;
  let afkRoot: string;

  beforeEach(() => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'afk-autoname-pipeline-')));
    afkRoot = join(tmpRoot, '.afk-worktrees');
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Build a mock DeferredWorktree whose `create()` synthesizes a handle from
   * the requested branch name, mirroring createWorktreeAt's dir = branch with
   * '/'->'-' rule. Optionally fail the named and/or timestamp create, and/or
   * actually mkdir the dir on disk so a subsequent process.chdir succeeds.
   */
  function makeDeferred(opts?: {
    failOn?: 'named' | 'timestamp' | 'both';
    mkdirReal?: boolean;
    timestampBranch?: string;
  }): DeferredWorktree & { create: ReturnType<typeof vi.fn> } {
    let created: WorktreeHandle | undefined;
    const create = vi.fn(async (flagValue: string | true): Promise<WorktreeHandle> => {
      const isTimestamp = flagValue === true;
      if (opts?.failOn === 'both') throw new Error('git worktree add failed: disk full');
      if (isTimestamp && opts?.failOn === 'timestamp') throw new Error('git worktree add failed: disk full');
      if (!isTimestamp && opts?.failOn === 'named') throw new Error("Worktree path 'x' already exists");
      const branch = isTimestamp ? (opts?.timestampBranch ?? 'afk/20260517-bbbbbb') : flagValue;
      const dir = branch.replaceAll('/', '-');
      let path = join(afkRoot, dir);
      if (opts?.mkdirReal) {
        await fs.mkdir(path, { recursive: true });
        path = realpathSync(path);
      }
      created = { path, branch, cleanup: async () => undefined };
      return created;
    });
    return { repoRoot: tmpRoot, handle: () => created, create } as DeferredWorktree & {
      create: ReturnType<typeof vi.fn>;
    };
  }

  it('created -> creates the worktree with the slug name and points session cwd at it', async () => {
    const deferred = makeDeferred();
    const setCwd = vi.fn();
    const session = { setCwd } as unknown as Parameters<typeof runFirstTurnAutoname>[0]['session'];

    const outcome = await runFirstTurnAutoname({
      deferred,
      message: 'fix the cleanup race',
      token: 'sk-ant-test',
      session: session ?? null,
      slugGenerator: async () => 'fix-cleanup-race',
    });

    expect(outcome.status).toBe('created');
    if (outcome.status === 'created') {
      expect(outcome.slug).toBe('fix-cleanup-race');
      expect(outcome.branch).toBe('afk/fix-cleanup-race');
      expect(outcome.path).toBe(join(afkRoot, 'afk-fix-cleanup-race'));
    }
    // create() invoked once, with the composed (prefixed) branch name.
    expect(deferred.create).toHaveBeenCalledTimes(1);
    expect(deferred.create).toHaveBeenCalledWith('afk/fix-cleanup-race');
    expect(setCwd).toHaveBeenCalledWith(join(afkRoot, 'afk-fix-cleanup-race'));
  });

  it('created-fallback -> timestamp worktree when slug generation is skipped (slash-command)', async () => {
    const deferred = makeDeferred();
    const setCwd = vi.fn();
    const session = { setCwd } as unknown as Parameters<typeof runFirstTurnAutoname>[0]['session'];

    const outcome = await runFirstTurnAutoname({
      deferred,
      message: '/help', // slash -> slug null -> timestamp fallback
      token: 'sk-ant-test',
      session: session ?? null,
      slugGenerator: async () => 'fix-cleanup-race',
    });

    expect(outcome.status).toBe('created-fallback');
    if (outcome.status === 'created-fallback') {
      expect(outcome.reason).toBe('slash-command');
      expect(outcome.detail).toBeUndefined();
      expect(outcome.branch).toBe('afk/20260517-bbbbbb');
    }
    // Named create is never attempted (slug was null); only the timestamp create.
    expect(deferred.create).toHaveBeenCalledTimes(1);
    expect(deferred.create).toHaveBeenCalledWith(true);
    expect(setCwd).toHaveBeenCalledWith(join(afkRoot, 'afk-20260517-bbbbbb'));
  });

  it('created-fallback -> surfaces reason + detail (slug-generator-error)', async () => {
    const deferred = makeDeferred();
    const outcome = await runFirstTurnAutoname({
      deferred,
      message: 'fix this bug',
      token: 'sk-ant-test',
      session: null,
      slugGenerator: async () => {
        throw new Error('401 unauthorized');
      },
    });
    expect(outcome.status).toBe('created-fallback');
    if (outcome.status === 'created-fallback') {
      expect(outcome.reason).toBe('slug-generator-error');
      expect(outcome.detail).toBe('401 unauthorized');
    }
    expect(deferred.create).toHaveBeenCalledWith(true);
  });

  it('created-fallback -> surfaces reason + detail (invalid-slug-output)', async () => {
    const deferred = makeDeferred();
    const outcome = await runFirstTurnAutoname({
      deferred,
      message: 'fix this',
      token: 'sk-ant-test',
      session: null,
      slugGenerator: async () => '???!!! garbage ???',
    });
    expect(outcome.status).toBe('created-fallback');
    if (outcome.status === 'created-fallback') {
      expect(outcome.reason).toBe('invalid-slug-output');
      expect(outcome.detail).toBe('???!!! garbage ???');
    }
  });

  it('created-fallback -> falls back to timestamp when the named create fails (create-failed)', async () => {
    const deferred = makeDeferred({ failOn: 'named' });
    const setCwd = vi.fn();
    const session = { setCwd } as unknown as Parameters<typeof runFirstTurnAutoname>[0]['session'];

    const outcome = await runFirstTurnAutoname({
      deferred,
      message: 'fix the cleanup race',
      token: 'sk-ant-test',
      session: session ?? null,
      slugGenerator: async () => 'fix-cleanup-race',
    });

    expect(outcome.status).toBe('created-fallback');
    if (outcome.status === 'created-fallback') {
      expect(outcome.reason).toBe('create-failed');
      expect(outcome.detail).toContain('already exists');
      expect(outcome.branch).toBe('afk/20260517-bbbbbb');
    }
    // Named create attempted first, then the timestamp fallback.
    expect(deferred.create).toHaveBeenCalledTimes(2);
    expect(deferred.create).toHaveBeenNthCalledWith(1, 'afk/fix-cleanup-race');
    expect(deferred.create).toHaveBeenNthCalledWith(2, true);
    expect(setCwd).toHaveBeenCalledWith(join(afkRoot, 'afk-20260517-bbbbbb'));
  });

  it('failed -> both named and timestamp create fail; no setCwd, status failed', async () => {
    const deferred = makeDeferred({ failOn: 'both' });
    const setCwd = vi.fn();
    const session = { setCwd } as unknown as Parameters<typeof runFirstTurnAutoname>[0]['session'];

    const outcome = await runFirstTurnAutoname({
      deferred,
      message: 'fix the cleanup race',
      token: 'sk-ant-test',
      session: session ?? null,
      slugGenerator: async () => 'fix-cleanup-race',
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).toContain('disk full');
    }
    expect(setCwd).not.toHaveBeenCalled();
  });

  it('passes branchPrefix override through to the composed branch name', async () => {
    const deferred = makeDeferred({ timestampBranch: 'scratch/20260517-bbbbbb' });
    await runFirstTurnAutoname({
      deferred,
      message: 'fix the cleanup race',
      token: 'sk-ant-test',
      session: null,
      branchPrefix: 'scratch/',
      slugGenerator: async () => 'fix-cleanup-race',
    });
    expect(deferred.create).toHaveBeenCalledWith('scratch/fix-cleanup-race');
  });

  it('works with session=null (no setCwd attempted)', async () => {
    const deferred = makeDeferred();
    const outcome = await runFirstTurnAutoname({
      deferred,
      message: 'fix the cleanup race',
      token: 'sk-ant-test',
      session: null,
      slugGenerator: async () => 'fix-cleanup-race',
    });
    expect(outcome.status).toBe('created');
    if (outcome.status === 'created') {
      expect(outcome.path).toBe(join(afkRoot, 'afk-fix-cleanup-race'));
    }
  });

  it('created -> pins process.cwd() to the new worktree (spawn-fallback fix)', async () => {
    // The worktree is created (not moved); pinning process.cwd() into it keeps
    // any child_process.spawn that falls back to process.cwd() anchored in the
    // worktree rather than the launch cwd (the parent repo).
    const orig = process.cwd();
    const deferred = makeDeferred({ mkdirReal: true });
    try {
      const outcome = await runFirstTurnAutoname({
        deferred,
        message: 'fix the cleanup race',
        token: 'sk-ant-test',
        session: null,
        slugGenerator: async () => 'fix-cleanup-race',
      });
      expect(outcome.status).toBe('created');
      expect(process.cwd()).toBe(realpathSync(join(afkRoot, 'afk-fix-cleanup-race')));
    } finally {
      process.chdir(orig);
    }
  });

  it('failed -> leaves process.cwd() untouched when no worktree could be created', async () => {
    const orig = process.cwd();
    const deferred = makeDeferred({ failOn: 'both' });
    try {
      const outcome = await runFirstTurnAutoname({
        deferred,
        message: 'fix the cleanup race',
        token: 'sk-ant-test',
        session: null,
        slugGenerator: async () => 'fix-cleanup-race',
      });
      expect(outcome.status).toBe('failed');
      expect(process.cwd()).toBe(orig);
    } finally {
      process.chdir(orig);
    }
  });
});

describe('pinProcessCwd', () => {
  it('updates process.cwd() when the target exists', async () => {
    const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'afk-pincwd-')));
    const orig = process.cwd();
    try {
      pinProcessCwd(tmpRoot);
      expect(process.cwd()).toBe(tmpRoot);
    } finally {
      process.chdir(orig);
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('swallows errors when the target does not exist (best-effort contract)', () => {
    const orig = process.cwd();
    // No throw — guarantees the caller does not need a try/catch.
    expect(() => pinProcessCwd('/nonexistent/path/that/should/never/exist')).not.toThrow();
    // process.cwd() unchanged because chdir failed.
    expect(process.cwd()).toBe(orig);
  });
});
