/**
 * Score skill — deterministic branch scoring for `afk farm`.
 *
 * Runs each worktree's test suite + compile check, captures LoC delta vs base,
 * writes a per-branch `score.json`. The farm runner uses these scores to rank
 * branches in its summary; Day 4 will write through to memory + Telegram.
 *
 * ## v1 scope (Stage 0)
 *
 * Purely deterministic — no LLM calls. Signals captured:
 *   - tests_ok    : exit code of detected test command (pnpm test → npm test → none)
 *   - lint_ok     : exit code of `tsc --noEmit` (cheap, catches "broke the project")
 *   - loc_delta   : `git diff --shortstat baseSha..HEAD` (additions - deletions)
 *   - duration_ms : wall time of the test run
 *
 * Pass/fail counts are degenerate in v1 — we report exit-code only, so
 *   `{ pass: 1, fail: 0 }` means tests passed and `{ pass: 0, fail: 1 }` means
 *   they failed. Parsing per-runner output for accurate counts is v2.
 *
 * ## Storage
 *
 * Scores live at `<farmDir>/scores/branch-<n>.json` (sibling of the worktrees,
 * not inside them — avoids polluting branch git status and survives
 * worktree-prune).
 *
 * ## Why a skill (not just an agent module)
 *
 * The slot is reserved for Stage 1+ where a model is asked to judge diff
 * quality. v1 is plain functions; the directory shape keeps the door open.
 *
 * @module skills/score
 */

import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';

export const SCORE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_TIMEOUT_MS = 120_000;

export interface BranchScore {
  schemaVersion: typeof SCORE_SCHEMA_VERSION;
  /** 1 if tests passed (exit 0), 0 otherwise. v2 will parse actual counts. */
  pass: number;
  /** 1 if tests failed (non-zero exit), 0 otherwise. Mutually exclusive with pass unless skipped. */
  fail: number;
  /** Lines added minus lines removed across all files since baseSha. */
  loc_delta: number;
  /** `tsc --noEmit` exit 0 → true; non-zero → false; not run / crashed → null. */
  lint_ok: boolean | null;
  /** Wall time of the test run in ms (0 if no test command was found). */
  duration_ms: number;
  /** Populated on timeout, crash, or missing test command. Absent on clean runs. */
  error?: string;
  /** What we actually ran (e.g. "pnpm test"). Absent if no test command was found. */
  testCmd?: string;
  /** Absolute worktree path scored. */
  branchPath: string;
  /** Commit SHA used as the diff base. */
  baseSha: string;
  /** ISO timestamp when scoring finished. */
  scoredAt: string;
}

export interface ScoreBranchOptions {
  branchPath: string;
  baseSha: string;
  /** Override auto-detection. */
  testCmd?: string;
  /** Default 120_000 (2 min). */
  timeoutMs?: number;
  // ---- Injection seams (testing only) ----
  _spawn?: typeof spawn;
  _readPackageJson?: (path: string) => Promise<unknown>;
  _now?: () => number;
  _nowIso?: () => string;
}

/** Result row consumed by `rankBranches`. */
export interface RankableBranch {
  index: number;
  score: BranchScore | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score a single worktree. Never throws — failures are encoded in the returned
 * BranchScore.error. Writes `<branchPath>/../scores/branch-<n>.json` is the
 * caller's responsibility (use `writeScore`).
 */
export async function scoreBranch(opts: ScoreBranchOptions): Promise<BranchScore> {
  const {
    branchPath,
    baseSha,
    testCmd: overrideCmd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    _spawn = spawn,
    _readPackageJson = defaultReadPackageJson,
    _now = Date.now,
    _nowIso = () => new Date().toISOString(),
  } = opts;

  // -- 1. Resolve test command --
  const testCmd = overrideCmd ?? (await detectTestCommand(branchPath, _readPackageJson));

  // -- 2. Run tests (if available) --
  let pass = 0;
  let fail = 0;
  let duration_ms = 0;
  let error: string | undefined;

  if (testCmd) {
    const testResult = await runWithTimeout(testCmd, branchPath, timeoutMs, _spawn, _now);
    duration_ms = testResult.durationMs;
    if (testResult.timedOut) {
      fail = 1;
      error = `tests timed out after ${timeoutMs}ms`;
    } else if (testResult.crashed) {
      fail = 1;
      error = `test runner crashed: ${truncate(testResult.stderr, 200)}`;
    } else if (testResult.exitCode === 0) {
      pass = 1;
    } else {
      fail = 1;
    }
  } else {
    error = 'no test command found (no package.json scripts.test)';
  }

  // -- 3. Lint check (tsc --noEmit) --
  // Constraint: tsc is invoked only after tests so a hung test process can't
  // starve us out of the timeout budget for lint. Independent wall-clock.
  const lint_ok = await runLintCheck(branchPath, timeoutMs, _spawn, _now);

  // -- 4. LoC delta --
  const loc_delta = await getLocDelta(branchPath, baseSha, _spawn);

  const score: BranchScore = {
    schemaVersion: SCORE_SCHEMA_VERSION,
    pass,
    fail,
    loc_delta,
    lint_ok,
    duration_ms,
    branchPath,
    baseSha,
    scoredAt: _nowIso(),
  };
  if (error !== undefined) score.error = error;
  if (testCmd !== undefined) score.testCmd = testCmd;
  return score;
}

/**
 * Persist a score to `<farmDir>/scores/branch-<index>.json`. Creates the
 * scores dir on demand. Atomic via write-then-rename is overkill here (single
 * writer per branch).
 */
export async function writeScore(
  farmDir: string,
  index: number,
  score: BranchScore,
): Promise<string> {
  const scoresDir = join(farmDir, 'scores');
  await fs.mkdir(scoresDir, { recursive: true });
  const path = join(scoresDir, `branch-${index}.json`);
  await fs.writeFile(path, JSON.stringify(score, null, 2) + '\n', 'utf8');
  return path;
}

/**
 * Rank branches deterministically. Returns indices in ranked order (best first).
 *
 * Algorithm:
 *   1. Primary: tests_ok desc (pass / (pass + fail), with NaN treated as 0)
 *   2. Tie-break: lint_ok desc (true > false > null)
 *   3. Tie-break: loc_delta asc (fewer lines preferred)
 *   4. Final tie-break: index asc (stable)
 *
 * Branches with null score (never ran) are ranked last, by index asc.
 */
export function rankBranches(branches: RankableBranch[]): number[] {
  const scored = branches.filter((b) => b.score !== null);
  const unscored = branches.filter((b) => b.score === null).map((b) => b.index).sort((a, b) => a - b);

  scored.sort((a, b) => {
    const sa = a.score!;
    const sb = b.score!;
    const ra = testRate(sa);
    const rb = testRate(sb);
    if (ra !== rb) return rb - ra;
    const la = lintRank(sa.lint_ok);
    const lb = lintRank(sb.lint_ok);
    if (la !== lb) return lb - la;
    if (sa.loc_delta !== sb.loc_delta) return sa.loc_delta - sb.loc_delta;
    return a.index - b.index;
  });

  return [...scored.map((b) => b.index), ...unscored];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function defaultReadPackageJson(path: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function detectTestCommand(
  branchPath: string,
  readPkgJson: (path: string) => Promise<unknown>,
): Promise<string | undefined> {
  const pkg = await readPkgJson(join(branchPath, 'package.json'));
  if (!isObject(pkg)) return undefined;
  const scripts = pkg['scripts'];
  if (!isObject(scripts)) return undefined;
  if (typeof scripts['test'] !== 'string') return undefined;
  // Prefer pnpm if a lockfile is present (mirror project convention); else npm.
  const hasPnpm = await fileExists(join(branchPath, 'pnpm-lock.yaml'));
  return hasPnpm ? 'pnpm test' : 'npm test';
}

interface RunResult {
  exitCode: number | null;
  durationMs: number;
  stderr: string;
  timedOut: boolean;
  crashed: boolean;
}

async function runWithTimeout(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  spawnFn: typeof spawn,
  now: () => number,
): Promise<RunResult> {
  const start = now();
  return new Promise<RunResult>((resolve) => {
    let child: ChildProcess;
    try {
      // Constraint: shell:true is required so the cmd string ("pnpm test")
      // is parsed by the shell. We never accept untrusted input for cmd —
      // it comes from package.json or an explicit caller flag.
      child = spawnFn(cmd, {
        cwd,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CI: '1' }, // force non-interactive
      });
    } catch (err) {
      resolve({
        exitCode: null,
        durationMs: now() - start,
        stderr: err instanceof Error ? err.message : String(err),
        timedOut: false,
        crashed: true,
      });
      return;
    }

    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL because some test runners trap SIGTERM and exit slowly.
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
      // Cap stderr buffer to avoid OOM on noisy crashes.
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        durationMs: now() - start,
        stderr: err.message,
        timedOut: false,
        crashed: true,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        durationMs: now() - start,
        stderr,
        timedOut,
        crashed: false,
      });
    });
  });
}

async function runLintCheck(
  cwd: string,
  timeoutMs: number,
  spawnFn: typeof spawn,
  now: () => number,
): Promise<boolean | null> {
  // Only run tsc if a tsconfig.json is present at the branch root. Avoids
  // returning false for non-TS projects.
  if (!(await fileExists(join(cwd, 'tsconfig.json')))) return null;
  const result = await runWithTimeout('npx --no-install tsc --noEmit', cwd, timeoutMs, spawnFn, now);
  if (result.crashed || result.timedOut) return null;
  return result.exitCode === 0;
}

async function getLocDelta(
  cwd: string,
  baseSha: string,
  spawnFn: typeof spawn,
): Promise<number> {
  return new Promise<number>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn('git', ['diff', '--shortstat', `${baseSha}..HEAD`], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(0);
      return;
    }
    let out = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      out += String(chunk);
    });
    child.on('error', () => resolve(0));
    child.on('close', () => {
      // Format: " 3 files changed, 42 insertions(+), 7 deletions(-)"
      const ins = /(\d+) insertions?\(\+\)/.exec(out);
      const del = /(\d+) deletions?\(-\)/.exec(out);
      const added = ins ? Number(ins[1]) : 0;
      const removed = del ? Number(del[1]) : 0;
      resolve(added - removed);
    });
  });
}

function testRate(s: BranchScore): number {
  const total = s.pass + s.fail;
  return total === 0 ? 0 : s.pass / total;
}

function lintRank(v: boolean | null): number {
  if (v === true) return 2;
  if (v === false) return 1;
  return 0;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

// Unused import guard (dirname kept for future score-file-derived helpers).
void dirname;
