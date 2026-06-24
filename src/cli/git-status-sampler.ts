/**
 * Cached, sampled view of the session's git branch + open PR for the status
 * line.
 *
 * The status line repaints every turn (and on every mid-turn token event);
 * shelling out to `git` / `gh` on every repaint would be both chatty and slow
 * (a `gh pr view` is a network round-trip). This sampler:
 *
 *   - caches the current branch and the open-PR number so repaints are O(1)
 *     cache reads (`getBranch()` / `getPr()`);
 *   - resolves the branch via a fast local `git symbolic-ref` that callers may
 *     `await` (≈ a few ms) — `refresh()` resolves once the branch is updated;
 *   - resolves the PR via `gh pr view` in a DETACHED background task that never
 *     blocks `refresh()`, the turn loop, or a repaint. The PR appears on a
 *     later repaint once the network call settles;
 *   - throttles the network call: the PR is only re-fetched when the branch
 *     changes or the cached value is older than `prTtlMs`, so a branch with no
 *     PR is not re-queried every turn;
 *   - degrades gracefully: a detached HEAD, a non-git directory, a missing
 *     `gh`, or any failure leaves the field empty rather than throwing.
 *
 * The sampler is session-scoped; the REPL constructs one per session.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveCurrentBranchPr } from '../agent/gh.js';

const execFileAsync = promisify(execFile);

/**
 * Exec shape used for both the local `git` call and the injected `gh` call.
 * `cwd` is mandatory so the branch/PR reflect the SESSION's working directory
 * (which, under `--worktree`, differs from `process.cwd()`). Matches the slice
 * of `promisify(execFile)` we use.
 */
export type GitStatusExecFn = (
  file: string,
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string }>;

export interface GitStatusSamplerOptions {
  /** Session working directory the git/gh calls run in. */
  cwd: string;
  /** Injectable exec for tests. Defaults to a timeout-bounded `execFile`. */
  exec?: GitStatusExecFn;
  /**
   * Minimum ms between PR network fetches for the SAME branch. A branch change
   * always forces an immediate re-fetch regardless of this. Default 60_000.
   */
  prTtlMs?: number;
  /**
   * Minimum ms between branch re-checks via `git symbolic-ref`. The
   * `branchInFlight` dedup prevents concurrent spawns; this guards against
   * serial per-turn subprocess overhead on slow filesystems (network mounts,
   * Docker volumes). Default 0 (no guard — always re-sample). Production sets
   * this to 1_000 ms in bootstrap so turns never fork git more than once per
   * second.
   */
  branchTtlMs?: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Per-call exec timeout in ms (bounds a hung `gh` when offline). Default 10_000. */
  timeoutMs?: number;
  /**
   * Fired after the displayed branch or PR actually CHANGES (not on every
   * refresh). The REPL wires this to a status-line repaint so the branch
   * appears as soon as the (fast, local) git call resolves and the PR lands
   * when its (slow, network) lookup settles — without waiting for the next
   * turn. A throwing callback is swallowed so a UI error never breaks sampling.
   */
  onUpdate?: () => void;
}

/** Default exec: timeout-bounded, no shell, runs in the supplied cwd. */
function defaultExec(timeoutMs: number): GitStatusExecFn {
  return (file, args, cwd) =>
    execFileAsync(file, args, {
      cwd,
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      // Branch names / PR numbers are tiny; cap output defensively.
      maxBuffer: 64 * 1024,
    }).then((r) => ({ stdout: r.stdout, stderr: r.stderr }));
}

export class GitStatusSampler {
  private readonly cwd: string;
  private readonly exec: GitStatusExecFn;
  private readonly prTtlMs: number;
  private readonly branchTtlMs: number;
  private readonly now: () => number;
  private onUpdate: (() => void) | undefined;

  private branch: string | undefined;
  private pr: number | undefined;
  /** Branch the cached `pr` value (number OR "no PR") was last fetched for. */
  private prBranch: string | undefined;
  /** Timestamp of the last PR fetch attempt (success or "no PR"). */
  private prFetchedAt = 0;
  /** Timestamp of the last branch check (via `git symbolic-ref`). */
  private branchFetchedAt = 0;

  private branchInFlight: Promise<void> | null = null;
  private prInFlight: Promise<void> | null = null;
  private disposed = false;
  /**
   * Incremented by reset() to invalidate in-flight updateBranch /
   * maybeFetchPr tasks. Each task captures this before its first await and
   * checks it after settling — a mismatch means reset() fired mid-flight and
   * the result must be discarded rather than written to shared state.
   */
  private resetToken = 0;

  constructor(opts: GitStatusSamplerOptions) {
    this.cwd = opts.cwd;
    this.exec = opts.exec ?? defaultExec(opts.timeoutMs ?? 10_000);
    this.prTtlMs = opts.prTtlMs ?? 60_000;
    this.branchTtlMs = opts.branchTtlMs ?? 0;
    this.now = opts.now ?? Date.now;
    this.onUpdate = opts.onUpdate;
  }

  /**
   * Register (or replace) the on-change callback after construction. Used by
   * the REPL bootstrap, where the repaint closure is only available after the
   * sampler exists.
   */
  setOnUpdate(cb: (() => void) | undefined): void {
    this.onUpdate = cb;
  }

  /** Latest cached branch, or undefined (detached HEAD / not a git repo / unfetched). */
  getBranch(): string | undefined {
    return this.branch;
  }

  /** Latest cached open-PR number for the current branch, or undefined. */
  getPr(): number | undefined {
    return this.pr;
  }

  /**
   * Refresh the branch (awaited — fast, local) and kick a detached PR fetch
   * (network — never awaited here). Dedupes concurrent branch refreshes.
   *
   * Pass `{ blockOnPr: true }` to also await the in-flight PR fetch — used by
   * tests and the initial paint when the caller wants the PR resolved before
   * reading the cache. The hot path (turn loop) omits it so the network call
   * never delays a turn.
   */
  async refresh(opts: { blockOnPr?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    if (!this.branchInFlight) {
      this.branchInFlight = this.updateBranch().finally(() => {
        this.branchInFlight = null;
      });
    }
    await this.branchInFlight;
    if (opts.blockOnPr && this.prInFlight) await this.prInFlight;
  }

  /**
   * Clear cached values so the next refresh starts cold. Increments the
   * internal generation token so any concurrently-settling updateBranch() or
   * maybeFetchPr() task detects the reset via token mismatch and discards its
   * result rather than writing stale state.
   */
  reset(): void {
    this.resetToken++;
    this.branch = undefined;
    this.pr = undefined;
    this.prBranch = undefined;
    this.prFetchedAt = 0;
    this.branchFetchedAt = 0;
    this.branchInFlight = null;
    this.prInFlight = null;
  }

  /** Stop any future sampling. Safe to call multiple times. */
  dispose(): void {
    this.disposed = true;
  }

  private async updateBranch(): Promise<void> {
    // Skip if the branch was checked within branchTtlMs — guards per-turn
    // subprocess overhead on slow filesystems. Default 0 = always re-sample.
    if (
      this.branchTtlMs > 0 &&
      this.branchFetchedAt > 0 &&
      this.now() - this.branchFetchedAt < this.branchTtlMs
    ) {
      return;
    }
    // Capture the generation token before the first await. If reset() fires
    // while the git call is in flight, the token increments and we discard
    // the result rather than writing stale state.
    const token = this.resetToken;
    this.branchFetchedAt = this.now();
    const newBranch = await this.gitBranch();
    if (this.disposed || this.resetToken !== token) return;
    const branchChanged = newBranch !== this.branch;
    this.branch = newBranch;

    if (newBranch === undefined) {
      // Detached HEAD or non-git dir: no branch ⇒ no PR.
      const hadPr = this.pr !== undefined;
      this.pr = undefined;
      this.prBranch = undefined;
      if (branchChanged || hadPr) this.notify();
      return;
    }

    if (branchChanged) {
      // Drop the previous branch's PR immediately — showing it against the new
      // branch would be wrong. maybeFetchPr resolves the new branch's PR (or
      // confirms none) shortly after. Notify now so the new branch paints.
      this.pr = undefined;
      this.notify();
    }
    // Detached, non-blocking PR fetch — the only path that touches the network.
    void this.maybeFetchPr(newBranch);
  }

  /** Fire the on-change callback; a throwing UI callback must not break sampling. */
  private notify(): void {
    try {
      this.onUpdate?.();
    } catch {
      /* swallow — the sampler is not responsible for UI errors */
    }
  }

  /** `git symbolic-ref --short HEAD` → branch, or undefined on any failure. */
  private async gitBranch(): Promise<string | undefined> {
    try {
      const { stdout } = await this.exec('git', ['symbolic-ref', '--short', 'HEAD'], this.cwd);
      const b = stdout.trim();
      return b.length > 0 ? b : undefined;
    } catch {
      // Detached HEAD (symbolic-ref exits non-zero), not a git repo, or no git.
      return undefined;
    }
  }

  /**
   * Fetch the open PR for `branch` if stale, in a deduped background task.
   * Caches "no PR" (undefined) too, so a PR-less branch is not re-queried on
   * every repaint — only after `prTtlMs` elapses (to catch a PR opened later).
   */
  private maybeFetchPr(branch: string): Promise<void> {
    if (this.prInFlight) return this.prInFlight;
    const stale = this.prBranch !== branch || this.now() - this.prFetchedAt >= this.prTtlMs;
    if (!stale) return Promise.resolve();

    this.prFetchedAt = this.now();
    const task = (async () => {
      // Capture the generation token before the network call. If reset() fires
      // while gh is in flight, the token increments and we discard the result.
      const token = this.resetToken;
      // resolveCurrentBranchPr never throws — returns the number string or null.
      const prStr = await resolveCurrentBranchPr((file, args) => this.exec(file, args, this.cwd));
      if (this.disposed || this.resetToken !== token) return;
      // Discard if the branch changed while the network call was in flight.
      if (this.branch !== branch) return;
      const n = prStr !== null ? Number.parseInt(prStr, 10) : NaN;
      const prevPr = this.pr;
      this.pr = Number.isFinite(n) && n > 0 ? n : undefined;
      this.prBranch = branch;
      if (this.pr !== prevPr) this.notify();
    })().finally(() => {
      this.prInFlight = null;
      // If the branch changed while this fetch was in flight, the branch guard
      // above discarded the stale result. Kick a follow-up lookup for the
      // current branch so its PR resolves on the next settled repaint rather
      // than waiting for the next turn's refresh() call.
      const currentBranch = this.branch;
      if (!this.disposed && currentBranch !== undefined && currentBranch !== branch) {
        void this.maybeFetchPr(currentBranch);
      }
    });
    this.prInFlight = task;
    return task;
  }
}
