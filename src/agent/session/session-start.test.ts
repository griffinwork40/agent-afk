/**
 * Tests for the git-head snapshot written into session-meta.json at top-level
 * session start, and for the `readSessionStart` consumer API.
 *
 * Covers:
 *   - git cwd: full 40-hex SHA recorded, branch set
 *   - non-git cwd: branch and headSha are null, capturedAt present
 *   - detached HEAD: branch null, headSha set
 *   - subagent session (parentSessionId set): nothing written to sidecar
 *   - readSessionStart round-trip: returns SessionStart or null correctly
 *
 * Uses a temp AFK_HOME so no real ~/.afk/state is touched.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

// Set AFK_HOME before any module that reads paths resolves.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-session-start-test-'));
process.env['AFK_HOME'] = tmpHome;

import { captureGitHead, readSessionStart, writeSessionMeta } from './session-meta.js';
import { LedgerLifecycle, type LedgerEnsureContext } from './ledger-lifecycle.js';
import { getSessionMetaPath } from '../../paths.journal.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;
function freshId(): string {
  return `ss-test-${Date.now()}-${seq++}`;
}

/** Make a top-level LedgerEnsureContext. */
function topCtx(
  sessionId: string,
  cwd: string,
  over: Partial<LedgerEnsureContext> = {},
): LedgerEnsureContext {
  return {
    depth: undefined,
    parentSessionId: undefined,
    sessionId,
    fallbackModel: 'test-model',
    tracePath: undefined,
    getMetadata: () => ({ cwd }),
    ...over,
  };
}

/** Read raw sidecar JSON (null if absent). */
function readSidecar(sessionId: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(getSessionMetaPath(sessionId), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Wait for the async fire-and-forget sidecar write to land. */
async function waitForSidecar(sessionId: string, ms = 500): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (readSidecar(sessionId) !== null) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ---------------------------------------------------------------------------
// Git repo fixture
// ---------------------------------------------------------------------------

let gitRepo: string;
let nonGitDir: string;
let detachedRepo: string;

beforeAll(() => {
  // Non-git cwd.
  nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-ss-nongit-'));

  // Normal git repo with one commit.
  gitRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-ss-git-'));
  execSync('git init -b main', { cwd: gitRepo });
  execSync('git config user.email "test@afk"', { cwd: gitRepo });
  execSync('git config user.name "AFK Test"', { cwd: gitRepo });
  fs.writeFileSync(path.join(gitRepo, 'f.txt'), 'hello');
  execSync('git add .', { cwd: gitRepo });
  execSync('git commit -m "init"', { cwd: gitRepo });

  // Detached HEAD repo: same base, then detach.
  detachedRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-ss-detached-'));
  execSync('git init -b main', { cwd: detachedRepo });
  execSync('git config user.email "test@afk"', { cwd: detachedRepo });
  execSync('git config user.name "AFK Test"', { cwd: detachedRepo });
  fs.writeFileSync(path.join(detachedRepo, 'g.txt'), 'world');
  execSync('git add .', { cwd: detachedRepo });
  execSync('git commit -m "init"', { cwd: detachedRepo });
  // Detach HEAD at the current commit.
  const sha = execSync('git rev-parse HEAD', { cwd: detachedRepo }).toString().trim();
  execSync(`git checkout --detach ${sha}`, { cwd: detachedRepo });
});

afterAll(() => {
  for (const d of [tmpHome, nonGitDir, gitRepo, detachedRepo]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// captureGitHead unit tests
// ---------------------------------------------------------------------------

describe('captureGitHead', () => {
  it('git cwd: returns full 40-hex SHA and branch name', () => {
    const snap = captureGitHead(gitRepo);
    expect(snap.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(snap.branch).toBe('main');
    expect(typeof snap.capturedAt).toBe('number');
    expect(snap.capturedAt).toBeGreaterThan(0);
  });

  it('non-git cwd: branch and headSha are null, capturedAt present', () => {
    const snap = captureGitHead(nonGitDir);
    expect(snap.headSha).toBeNull();
    expect(snap.branch).toBeNull();
    expect(typeof snap.capturedAt).toBe('number');
    expect(snap.capturedAt).toBeGreaterThan(0);
  });

  it('detached HEAD: branch is null, headSha is full 40-hex', () => {
    const snap = captureGitHead(detachedRepo);
    expect(snap.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(snap.branch).toBeNull();
    expect(typeof snap.capturedAt).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// readSessionStart round-trip
// ---------------------------------------------------------------------------

describe('readSessionStart', () => {
  it('returns null when no sidecar exists', () => {
    expect(readSessionStart('no-such-session-99')).toBeNull();
  });

  it('returns null when sidecar has no gitHead field (old sidecar)', async () => {
    const id = freshId();
    await writeSessionMeta({ v: 1, sessionId: id, model: 'x' });
    // gitHead absent => null
    expect(readSessionStart(id)).toBeNull();
  });

  it('returns null when gitHead is explicitly null (non-git cwd)', async () => {
    const id = freshId();
    await writeSessionMeta({ v: 1, sessionId: id, model: 'x', gitHead: null });
    expect(readSessionStart(id)).toBeNull();
  });

  it('round-trips a SessionStart written via writeSessionMeta', async () => {
    const id = freshId();
    const gitHead = { branch: 'main', headSha: 'a'.repeat(40), capturedAt: 12345 };
    await writeSessionMeta({ v: 1, sessionId: id, model: 'x', gitHead });
    const result = readSessionStart(id);
    expect(result).not.toBeNull();
    expect(result!.branch).toBe('main');
    expect(result!.headSha).toBe('a'.repeat(40));
    expect(result!.capturedAt).toBe(12345);
  });
});

// ---------------------------------------------------------------------------
// LedgerLifecycle integration: gitHead written for top-level, not subagent
// ---------------------------------------------------------------------------

describe('LedgerLifecycle.ensure gitHead', () => {
  it('top-level session: sidecar contains gitHead with full SHA', async () => {
    const id = freshId();
    const lc = new LedgerLifecycle();
    lc.initialize({ cwd: gitRepo });
    lc.ensure(topCtx(id, gitRepo));
    await waitForSidecar(id);

    const sidecar = readSidecar(id);
    expect(sidecar).not.toBeNull();
    const gh = sidecar!['gitHead'] as Record<string, unknown> | undefined;
    expect(gh).toBeDefined();
    expect(typeof gh!['headSha']).toBe('string');
    expect((gh!['headSha'] as string)).toMatch(/^[0-9a-f]{40}$/);
    expect(gh!['branch']).toBe('main');

    await lc.seal('done');
  });

  it('top-level session, non-git cwd: gitHead has null SHA and null branch', async () => {
    const id = freshId();
    const lc = new LedgerLifecycle();
    lc.initialize({ cwd: nonGitDir });
    lc.ensure(topCtx(id, nonGitDir));
    await waitForSidecar(id);

    const sidecar = readSidecar(id);
    expect(sidecar).not.toBeNull();
    const gh = sidecar!['gitHead'] as Record<string, unknown> | undefined;
    expect(gh).toBeDefined();
    expect(gh!['headSha']).toBeNull();
    expect(gh!['branch']).toBeNull();

    await lc.seal('done');
  });

  it('subagent session (parentSessionId set): sidecar not written at all', async () => {
    const id = freshId();
    const lc = new LedgerLifecycle();
    lc.initialize({ cwd: gitRepo, parentSessionId: 'parent-abc' });
    lc.ensure(topCtx(id, gitRepo, { parentSessionId: 'parent-abc' }));
    // Give the async path time to run if it mistakenly fired.
    await new Promise((r) => setTimeout(r, 100));
    expect(readSidecar(id)).toBeNull();
  });

  it('subagent session (depth set): sidecar not written at all', async () => {
    const id = freshId();
    const lc = new LedgerLifecycle();
    lc.initialize({ cwd: gitRepo, depth: 1 });
    lc.ensure(topCtx(id, gitRepo, { depth: 1 }));
    await new Promise((r) => setTimeout(r, 100));
    expect(readSidecar(id)).toBeNull();
  });
});
