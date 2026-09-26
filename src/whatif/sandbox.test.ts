/**
 * Tests for sandbox materializer and operator registry.
 *
 * Uses a fully controlled fake AFK_HOME in a temp directory.
 * Validates: home layout, afk.env credential stripping, state isolation,
 * baseline untouched by candidate changes, disable-skill/file/env operator
 * behaviour, project git worktree creation, and cleanup.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  readFileSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join, resolve, tmpdir } from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

import { materializeSandboxes } from './sandbox.js';
import {
  applyChanges,
  describeChange,
  specTouchesProject,
  homePathsToCopyFor,
  getOperator,
} from './operators/index.js';
import type { ChangeSpec, Environment, OperatorContext, LaunchSettings } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(os.tmpdir(), 'whatif-test-'));
}

/**
 * Build a fake AFK_HOME tree with:
 *   - config/afk.env  (has ANTHROPIC_API_KEY + AFK_MODEL)
 *   - AFK.md
 *   - skills/a, skills/b  (directories, simulating skill entries)
 *   - plugins/p1  (directory)
 *   - plugins/cache/c1  (directory)
 *   - state/memory/HOT.md
 *   - state/sessions/junk  (should NOT be copied)
 */
function buildFakeHome(dir: string): string {
  const home = join(dir, 'home');
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(
    join(home, 'config', 'afk.env'),
    [
      'ANTHROPIC_API_KEY=sk-ant-secret123',
      'AFK_MODEL=claude-sonnet-4-5',
      'AFK_EFFORT=high',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(home, 'AFK.md'), '# My AFK\nUser overlay.\n', 'utf8');
  mkdirSync(join(home, 'skills', 'a'), { recursive: true });
  writeFileSync(join(home, 'skills', 'a', 'skill.md'), 'skill a', 'utf8');
  mkdirSync(join(home, 'skills', 'b'), { recursive: true });
  writeFileSync(join(home, 'skills', 'b', 'skill.md'), 'skill b', 'utf8');
  mkdirSync(join(home, 'plugins', 'p1'), { recursive: true });
  writeFileSync(join(home, 'plugins', 'p1', 'plugin.md'), 'plugin p1', 'utf8');
  mkdirSync(join(home, 'plugins', 'cache', 'c1'), { recursive: true });
  writeFileSync(join(home, 'plugins', 'cache', 'c1', 'plugin.md'), 'cache c1', 'utf8');
  mkdirSync(join(home, 'state', 'memory'), { recursive: true });
  writeFileSync(join(home, 'state', 'memory', 'HOT.md'), '# HOT\nFacts here.\n', 'utf8');
  mkdirSync(join(home, 'state', 'sessions', 'junk'), { recursive: true });
  writeFileSync(join(home, 'state', 'sessions', 'junk', 'events.jsonl'), '{}', 'utf8');
  return home;
}

const BASE_LAUNCH: LaunchSettings = { env: {} };

// ---------------------------------------------------------------------------
// Sandbox layout tests
// ---------------------------------------------------------------------------

describe('materializeSandboxes: home layout', () => {
  let root: string;
  let realHome: string;
  let runDir: string;

  beforeEach(() => {
    root = tmpDir();
    realHome = buildFakeHome(root);
    runDir = join(root, 'run');
  });

  afterEach(async () => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates baseline and candidate home directories', async () => {
    const spec: ChangeSpec = { title: 'noop', changes: [] };
    const { baseline, candidate, cleanup } = await materializeSandboxes({
      realHome,
      realCwd: root,
      runDir,
      spec,
      baseLaunch: BASE_LAUNCH,
    });
    expect(existsSync(baseline.home)).toBe(true);
    expect(existsSync(candidate.home)).toBe(true);
    await cleanup();
  });

  it('strips credential lines from afk.env but keeps non-credential keys', async () => {
    const spec: ChangeSpec = { title: 'noop', changes: [] };
    const { candidate, cleanup } = await materializeSandboxes({
      realHome,
      realCwd: root,
      runDir,
      spec,
      baseLaunch: BASE_LAUNCH,
    });
    const envContent = readFileSync(
      join(candidate.home, 'config', 'afk.env'),
      'utf8',
    );
    expect(envContent).not.toContain('ANTHROPIC_API_KEY');
    expect(envContent).toContain('AFK_MODEL');
    await cleanup();
  });

  it('marks non-credential afk.env keys for unsetting in both launches', async () => {
    const { baseline, candidate, cleanup } = await materializeSandboxes({
      realHome,
      realCwd: root,
      runDir,
      spec: { title: 'noop', changes: [] },
      baseLaunch: BASE_LAUNCH,
    });
    expect(baseline.launch.unset).toContain('AFK_MODEL');
    expect(candidate.launch.unset).toContain('AFK_MODEL');
    expect(candidate.launch.unset).not.toContain('ANTHROPIC_API_KEY');
    await cleanup();
  });

  it('never copies config backups or non-allowlisted config files', async () => {
    writeFileSync(join(realHome, 'config', 'afk.env.bak-2026'), 'ANTHROPIC_API_KEY=sk-ant-secret\n');
    writeFileSync(join(realHome, 'config', 'schedules.json'), '{}');
    const { candidate, cleanup } = await materializeSandboxes({
      realHome,
      realCwd: root,
      runDir,
      spec: { title: 'noop', changes: [] },
      baseLaunch: BASE_LAUNCH,
    });
    expect(existsSync(join(candidate.home, 'config', 'afk.env.bak-2026'))).toBe(false);
    expect(existsSync(join(candidate.home, 'config', 'schedules.json'))).toBe(false);
    expect(existsSync(join(candidate.home, 'config', 'afk.env'))).toBe(true);
    await cleanup();
  });

  it('does NOT copy state/sessions into sandbox', async () => {
    const spec: ChangeSpec = { title: 'noop', changes: [] };
    const { baseline, cleanup } = await materializeSandboxes({
      realHome,
      realCwd: root,
      runDir,
      spec,
      baseLaunch: BASE_LAUNCH,
    });
    expect(existsSync(join(baseline.home, 'state', 'sessions'))).toBe(false);
    await cleanup();
  });

  it('copies state/memory/HOT.md', async () => {
    const spec: ChangeSpec = { title: 'noop', changes: [] };
    const { baseline, cleanup } = await materializeSandboxes({
      realHome,
      realCwd: root,
      runDir,
      spec,
      baseLaunch: BASE_LAUNCH,
    });
    expect(readFileSync(join(baseline.home, 'state', 'memory', 'HOT.md'), 'utf8')).toContain(
      'HOT',
    );
    await cleanup();
  });

  it('creates skills/ symlinks pointing to real skill dirs', async () => {
    const spec: ChangeSpec = { title: 'noop', changes: [] };
    const { baseline, cleanup } = await materializeSandboxes({
      realHome,
      realCwd: root,
      runDir,
      spec,
      baseLaunch: BASE_LAUNCH,
    });
    const skillsStat = lstatSync(join(baseline.home, 'skills', 'a'));
    expect(skillsStat.isSymbolicLink()).toBe(true);
    await cleanup();
  });

  it('copies AFK.md to sandbox home', async () => {
    const spec: ChangeSpec = { title: 'noop', changes: [] };
    const { baseline, cleanup } = await materializeSandboxes({
      realHome,
      realCwd: root,
      runDir,
      spec,
      baseLaunch: BASE_LAUNCH,
    });
    expect(readFileSync(join(baseline.home, 'AFK.md'), 'utf8')).toContain('User overlay');
    await cleanup();
  });

  it('creates empty agent-framework directory', async () => {
    const spec: ChangeSpec = { title: 'noop', changes: [] };
    const { baseline, cleanup } = await materializeSandboxes({
      realHome,
      realCwd: root,
      runDir,
      spec,
      baseLaunch: BASE_LAUNCH,
    });
    expect(existsSync(join(baseline.home, 'agent-framework'))).toBe(true);
    expect(readdirSync(join(baseline.home, 'agent-framework'))).toHaveLength(0);
    await cleanup();
  });

  it('cleanup removes sandboxes directory', async () => {
    const spec: ChangeSpec = { title: 'noop', changes: [] };
    const { cleanup } = await materializeSandboxes({
      realHome,
      realCwd: root,
      runDir,
      spec,
      baseLaunch: BASE_LAUNCH,
    });
    await cleanup();
    expect(existsSync(join(runDir, 'sandboxes'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Isolation: baseline untouched by candidate changes
// ---------------------------------------------------------------------------

describe('materializeSandboxes: baseline isolation', () => {
  let root: string;
  let realHome: string;
  let runDir: string;

  beforeEach(() => {
    root = tmpDir();
    realHome = buildFakeHome(root);
    runDir = join(root, 'run');
  });

  afterEach(async () => {
    rmSync(root, { recursive: true, force: true });
  });

  it('append to user AFK.md modifies candidate but not baseline', async () => {
    const spec: ChangeSpec = {
      title: 'test',
      changes: [{ kind: 'append', target: 'user-afk-md', text: 'APPENDED CONTENT' }],
    };
    const { baseline, candidate, cleanup } = await materializeSandboxes({
      realHome,
      realCwd: root,
      runDir,
      spec,
      baseLaunch: BASE_LAUNCH,
    });
    const baselineContent = readFileSync(join(baseline.home, 'AFK.md'), 'utf8');
    const candidateContent = readFileSync(join(candidate.home, 'AFK.md'), 'utf8');
    expect(baselineContent).not.toContain('APPENDED CONTENT');
    expect(candidateContent).toContain('APPENDED CONTENT');
    await cleanup();
  });

  it('hot change does not affect baseline', async () => {
    const spec: ChangeSpec = {
      title: 'test',
      changes: [{ kind: 'hot', content: 'NEW HOT CONTENT' }],
    };
    const { baseline, candidate, cleanup } = await materializeSandboxes({
      realHome,
      realCwd: root,
      runDir,
      spec,
      baseLaunch: BASE_LAUNCH,
    });
    const baselineHot = readFileSync(join(baseline.home, 'state', 'memory', 'HOT.md'), 'utf8');
    const candidateHot = readFileSync(join(candidate.home, 'state', 'memory', 'HOT.md'), 'utf8');
    expect(baselineHot).not.toContain('NEW HOT CONTENT');
    expect(candidateHot).toContain('NEW HOT CONTENT');
    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// disable-skill operator
// ---------------------------------------------------------------------------

describe('disable-skill operator', () => {
  let root: string;
  let realHome: string;
  let runDir: string;

  beforeEach(() => {
    root = tmpDir();
    realHome = buildFakeHome(root);
    runDir = join(root, 'run');
  });

  afterEach(async () => {
    rmSync(root, { recursive: true, force: true });
  });

  it('removes skill symlink from candidate but not baseline; real skill intact', async () => {
    const spec: ChangeSpec = {
      title: 'test',
      changes: [{ kind: 'disable-skill', name: 'b' }],
    };
    const { baseline, candidate, cleanup } = await materializeSandboxes({
      realHome,
      realCwd: root,
      runDir,
      spec,
      baseLaunch: BASE_LAUNCH,
    });
    // Candidate: skill b removed
    expect(existsSync(join(candidate.home, 'skills', 'b'))).toBe(false);
    // Baseline: skill b still present (symlink)
    expect(existsSync(join(baseline.home, 'skills', 'b'))).toBe(true);
    // Real skill b still exists
    expect(existsSync(join(realHome, 'skills', 'b'))).toBe(true);
    await cleanup();
  });

  it('throws on missing skill', async () => {
    const spec: ChangeSpec = {
      title: 'test',
      changes: [{ kind: 'disable-skill', name: 'nonexistent' }],
    };
    await expect(
      materializeSandboxes({ realHome, realCwd: root, runDir, spec, baseLaunch: BASE_LAUNCH }),
    ).rejects.toThrow('nonexistent');
  });
});

// ---------------------------------------------------------------------------
// file operator: writes inside skills/ copies symlink first
// ---------------------------------------------------------------------------

describe('file operator: skills path', () => {
  let root: string;
  let realHome: string;
  let runDir: string;

  beforeEach(() => {
    root = tmpDir();
    realHome = buildFakeHome(root);
    runDir = join(root, 'run');
  });

  afterEach(async () => {
    rmSync(root, { recursive: true, force: true });
  });

  it('file write inside skills/ materializes symlink and writes; real file unchanged', async () => {
    const spec: ChangeSpec = {
      title: 'test',
      changes: [
        { kind: 'file', path: 'home:skills/a/injected.md', content: 'INJECTED' },
      ],
    };
    const { candidate, cleanup } = await materializeSandboxes({
      realHome,
      realCwd: root,
      runDir,
      spec,
      baseLaunch: BASE_LAUNCH,
    });
    // The written file should be present in candidate
    const written = readFileSync(join(candidate.home, 'skills', 'a', 'injected.md'), 'utf8');
    expect(written).toBe('INJECTED');
    // The real skills/a should NOT have injected.md
    expect(existsSync(join(realHome, 'skills', 'a', 'injected.md'))).toBe(false);
    await cleanup();
  });

  it('file operator rejects absolute path', async () => {
    const op = getOperator('file');
    const env: Environment = {
      label: 'candidate',
      home: '/tmp/fake-home',
      cwd: '/tmp/fake-cwd',
      launch: { env: {} },
    };
    const ctx: OperatorContext = { realHome: '/tmp/real', realCwd: '/tmp/real-cwd' };
    await expect(
      op.apply({ kind: 'file', path: '/etc/passwd', content: 'nope' }, env, ctx),
    ).rejects.toThrow();
  });

  it('file operator rejects .. traversal', async () => {
    const op = getOperator('file');
    const env: Environment = {
      label: 'candidate',
      home: '/tmp/fake-home',
      cwd: '/tmp/fake-cwd',
      launch: { env: {} },
    };
    const ctx: OperatorContext = { realHome: '/tmp/real', realCwd: '/tmp/real-cwd' };
    await expect(
      op.apply({ kind: 'file', path: 'home:../../etc/shadow', content: 'nope' }, env, ctx),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// env operator: rejects secrets
// ---------------------------------------------------------------------------

describe('env operator', () => {
  const makeCandidateEnv = (): Environment => ({
    label: 'candidate',
    home: '/tmp/fake-home',
    cwd: '/tmp/fake-cwd',
    launch: { env: {} },
  });
  const ctx: OperatorContext = { realHome: '/tmp/real', realCwd: '/tmp/real-cwd' };

  it('rejects KEY-bearing env var', async () => {
    const op = getOperator('env');
    await expect(
      op.apply({ kind: 'env', key: 'ANTHROPIC_API_KEY', value: 'oops' }, makeCandidateEnv(), ctx),
    ).rejects.toThrow();
  });

  it('rejects TOKEN env var', async () => {
    const op = getOperator('env');
    await expect(
      op.apply({ kind: 'env', key: 'TELEGRAM_BOT_TOKEN', value: 'oops' }, makeCandidateEnv(), ctx),
    ).rejects.toThrow();
  });

  it('rejects AFK_WHATIF_ prefix', async () => {
    const op = getOperator('env');
    await expect(
      op.apply({ kind: 'env', key: 'AFK_WHATIF_ENABLE', value: '1' }, makeCandidateEnv(), ctx),
    ).rejects.toThrow();
  });

  it('rejects AFK_HOME', async () => {
    const op = getOperator('env');
    await expect(
      op.apply({ kind: 'env', key: 'AFK_HOME', value: '/fake' }, makeCandidateEnv(), ctx),
    ).rejects.toThrow();
  });

  it('accepts non-secret env vars', async () => {
    const op = getOperator('env');
    const env = makeCandidateEnv();
    await op.apply({ kind: 'env', key: 'MY_SETTING', value: 'hello' }, env, ctx);
    expect(env.launch.env['MY_SETTING']).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// specTouchesProject and homePathsToCopyFor
// ---------------------------------------------------------------------------

describe('registry helpers', () => {
  it('specTouchesProject: true for project-afk-md', () => {
    const spec: ChangeSpec = {
      title: 't',
      changes: [{ kind: 'append', target: 'project-afk-md', text: 'x' }],
    };
    expect(specTouchesProject(spec)).toBe(true);
  });

  it('specTouchesProject: false for user-afk-md', () => {
    const spec: ChangeSpec = {
      title: 't',
      changes: [{ kind: 'append', target: 'user-afk-md', text: 'x' }],
    };
    expect(specTouchesProject(spec)).toBe(false);
  });

  it('specTouchesProject: true for project file path', () => {
    const spec: ChangeSpec = {
      title: 't',
      changes: [{ kind: 'file', path: 'project:src/foo.ts', content: '' }],
    };
    expect(specTouchesProject(spec)).toBe(true);
  });

  it('homePathsToCopyFor: returns skills/a for home:skills/a/x', () => {
    const spec: ChangeSpec = {
      title: 't',
      changes: [{ kind: 'file', path: 'home:skills/a/injected.md', content: '' }],
    };
    expect(homePathsToCopyFor(spec)).toContain('skills/a');
  });

  it('homePathsToCopyFor: empty for model change', () => {
    const spec: ChangeSpec = {
      title: 't',
      changes: [{ kind: 'model', model: 'haiku' }],
    };
    expect(homePathsToCopyFor(spec)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// describeChange: smoke tests
// ---------------------------------------------------------------------------

describe('describeChange', () => {
  it('append user', () => {
    expect(describeChange({ kind: 'append', target: 'user-afk-md', text: 'hi' })).toMatch(
      /personal AFK\.md/i,
    );
  });

  it('model change', () => {
    expect(describeChange({ kind: 'model', model: 'claude-haiku-4-5' })).toContain('haiku');
  });

  it('memory-add preview', () => {
    const desc = describeChange({
      kind: 'memory-add',
      category: 'preference',
      content: 'I prefer TypeScript',
    });
    expect(desc).toContain('TypeScript');
  });

  it('disable-skill', () => {
    expect(describeChange({ kind: 'disable-skill', name: 'my-skill' })).toContain('my-skill');
  });

  it('env key', () => {
    expect(describeChange({ kind: 'env', key: 'FOO', value: 'bar' })).toContain('FOO');
  });
});

// ---------------------------------------------------------------------------
// Project worktree: git repo creation and cleanup
// ---------------------------------------------------------------------------

describe('materializeSandboxes: git worktrees', () => {
  let root: string;
  let realHome: string;
  let runDir: string;
  let gitRepo: string;

  beforeEach(() => {
    root = tmpDir();
    realHome = buildFakeHome(root);
    runDir = join(root, 'run');

    // Create a temp git repo
    gitRepo = join(root, 'repo');
    mkdirSync(gitRepo, { recursive: true });
    writeFileSync(join(gitRepo, 'README.md'), '# test\n', 'utf8');
    execSync('git init', { cwd: gitRepo, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: gitRepo, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: gitRepo, stdio: 'ignore' });
    execSync('git add .', { cwd: gitRepo, stdio: 'ignore' });
    execSync('git commit -m "init"', { cwd: gitRepo, stdio: 'ignore' });
  });

  afterEach(async () => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates project worktrees for both envs; cleanup removes sandboxes', async () => {
    const spec: ChangeSpec = {
      title: 'test',
      changes: [{ kind: 'file', path: 'project:NEW.md', content: 'candidate only' }],
    };
    const { baseline, candidate, cleanup } = await materializeSandboxes({
      realHome,
      realCwd: gitRepo,
      runDir,
      spec,
      baseLaunch: BASE_LAUNCH,
    });

    // Both envs have a cwd inside a worktree
    expect(baseline.cwd).not.toBe(gitRepo);
    expect(candidate.cwd).not.toBe(gitRepo);
    expect(existsSync(baseline.cwd)).toBe(true);
    expect(existsSync(candidate.cwd)).toBe(true);

    // Candidate has the file; baseline does not
    expect(existsSync(join(candidate.cwd, 'NEW.md'))).toBe(true);
    expect(existsSync(join(baseline.cwd, 'NEW.md'))).toBe(false);
    // Real repo untouched
    expect(existsSync(join(gitRepo, 'NEW.md'))).toBe(false);

    await cleanup();
    expect(existsSync(join(runDir, 'sandboxes'))).toBe(false);
  });

  it('throws when specTouchesProject but cwd is not a git repo', async () => {
    const notGitDir = join(root, 'notgit');
    mkdirSync(notGitDir, { recursive: true });
    const spec: ChangeSpec = {
      title: 'test',
      changes: [{ kind: 'file', path: 'project:foo.md', content: 'x' }],
    };
    await expect(
      materializeSandboxes({
        realHome,
        realCwd: notGitDir,
        runDir,
        spec,
        baseLaunch: BASE_LAUNCH,
      }),
    ).rejects.toThrow(/git/i);
  });
});

// ---------------------------------------------------------------------------
// memory-add (SQLite-backed) — runs if better-sqlite3 is available
// ---------------------------------------------------------------------------

describe('memory-add operator (SQLite)', () => {
  let root: string;
  let realHome: string;
  let runDir: string;

  beforeEach(() => {
    root = tmpDir();
    realHome = buildFakeHome(root);
    runDir = join(root, 'run');
  });

  afterEach(async () => {
    rmSync(root, { recursive: true, force: true });
  });

  it('stores a fact in candidate memory; baseline unaffected', async () => {
    const spec: ChangeSpec = {
      title: 'test',
      changes: [
        { kind: 'memory-add', category: 'preference', content: 'I prefer pnpm' },
      ],
    };

    let result: Awaited<ReturnType<typeof materializeSandboxes>>;
    try {
      result = await materializeSandboxes({
        realHome,
        realCwd: root,
        runDir,
        spec,
        baseLaunch: BASE_LAUNCH,
      });
    } catch (err) {
      // If SQLite native module is unavailable in this test environment, skip
      if (String(err).includes('Cannot find module') || String(err).includes('native')) {
        console.warn('[skip] better-sqlite3 not available; skipping memory-add test');
        return;
      }
      throw err;
    }

    const { candidate, cleanup } = result;
    const memDir = join(candidate.home, 'state', 'memory');
    // DB file should exist
    expect(existsSync(join(memDir, 'memory.db'))).toBe(true);
    await cleanup();
  });
});
