/**
 * Inline-button callback dispatcher for farm digest messages.
 *
 * Wire format: see `src/telegram/farm-callback-data.ts`. This module owns
 * only what happens AFTER a parsed callback lands — the four action paths
 * (Open PR, Full diff, Respawn from winner, Discard all) and their
 * idempotency / memory-write semantics.
 *
 * Design contract:
 *
 *   - Allowlist guarding is the bot's middleware job. By the time we get
 *     here, `ctx.chat?.id` is in `AFK_TELEGRAM_ALLOWED_CHAT_IDS`. We still
 *     defensively re-check `ctx.chat?.id` before any state mutation — a
 *     missing chat id is a "shouldn't-happen" signal, not a security
 *     boundary, but it's also free to verify.
 *   - Every handler MUST call `ctx.answerCbQuery(...)` exactly once. Telegram
 *     shows a spinner on the button until that lands; failing to answer
 *     leaves the user staring at it.
 *   - Idempotency: `x` (Discard all) reads `manifest.human_decision` first.
 *     If already set to `'rejected'`, we ack with "Already discarded" and
 *     skip both the manifest write and the memory write. The PR / Respawn
 *     stubs do not yet mutate state — they ack and bail, so re-clicking is
 *     safe by construction.
 *   - All git invocations go through `execFile` (no shell). Branch names and
 *     paths come from the manifest, never from the callback payload.
 *
 * @module telegram/handlers/farm-callbacks
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import type { Context } from 'telegraf';

import {
  buildFarmSlug,
  loadFarm,
  recordHumanDecision,
  recordPrCreated,
  recordRespawn,
  type FarmManifest,
} from '../../agent/worktree.js';
import {
  checkGhReady,
  createPr,
  GhError,
  type CreatePrOpts,
  type ExecFn,
  type GhReadiness,
} from '../../agent/gh.js';
import { writeFarmDecisionFact } from '../../skills/score/memory-write.js';
import { resolveWinnerBranch } from '../../skills/score/winner.js';
import { parseFarmCallback, type FarmCallbackAction } from '../farm-callback-data.js';

const execFileAsync = promisify(execFile);

type LogFn = (...args: unknown[]) => void;

// ---------------------------------------------------------------------------
// M1: Per-slug in-process lock to prevent double-tap races on Open PR / Respawn
//
// Shape: Map<lockKey, Promise<void>>
//   lockKey = `${action}:${taskSlug}`   e.g. "p:my-slug-abc123"
//
// On first tap: create a Promise that drives the full handler, store it.
// On concurrent second tap: join the in-flight promise, then re-read the
//   manifest via loadFarm so the second tap sees the state the first tap wrote.
// On completion / error: delete the key so the next real press starts fresh.
// ---------------------------------------------------------------------------

const actionLocks = new Map<string, Promise<void>>();

export interface FarmCallbackDeps {
  /** Inject in tests; defaults to the real manifest loader. */
  loadFarm?: typeof loadFarm;
  /** Inject in tests; defaults to the real manifest writer. */
  recordHumanDecision?: typeof recordHumanDecision;
  /** Inject in tests; defaults to the real memory-fact writer. */
  writeFarmDecisionFact?: typeof writeFarmDecisionFact;
  /**
   * Inject in tests; defaults to the real winner resolver that reads
   * `<farmDir>/scores/branch-<n>.json`. Keeping this injectable lets tests
   * pin the winner without touching disk.
   */
  resolveWinnerBranch?: typeof resolveWinnerBranch;
  /**
   * Inject in tests so we don't shell out to git. Receives the same args
   * `execFile` would; returns `{ stdout, stderr }`.
   */
  execGit?: (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  log?: LogFn;
  /** Inject to record respawn in the manifest. Defaults to the real recordRespawn. */
  recordRespawn?: typeof recordRespawn;
  /** Inject to spawn a child farm process. Defaults to defaultSpawnFarm. */
  spawnFarm?: (args: string[]) => void;
  /** Inject in tests to pin the current timestamp. */
  _now?: () => Date;
  /** Inject in tests to pin the random slug suffix. */
  _randomSuffix?: () => string;
  /** Inject in tests; defaults to the real gh readiness checker. */
  checkGhReady?: (opts?: Parameters<typeof checkGhReady>[0]) => Promise<GhReadiness>;
  /** Inject in tests; defaults to the real gh PR creator. */
  createPr?: (opts: CreatePrOpts, execFn?: ExecFn) => Promise<string>;
  /** Inject in tests; defaults to the real PR manifest recorder. */
  recordPrCreated?: typeof recordPrCreated;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Handle a `callback_query` whose `data` is shaped `afk:f:<action>:<slug>`.
 *
 * Returns silently after answering the callback. Never throws — Telegram
 * will retry callbacks for hours otherwise, and a thrown handler leaves the
 * user with a stuck spinner.
 */
export async function handleFarmCallback(
  ctx: Context,
  deps: FarmCallbackDeps = {},
): Promise<void> {
  const log = deps.log ?? (() => {});
  const callbackData = extractCallbackData(ctx);
  const parsed = parseFarmCallback(callbackData);

  if (!parsed) {
    // Unknown / malformed payload. Ack so the button releases its spinner,
    // but do nothing else.
    await safeAnswer(ctx, 'Unknown action', log);
    return;
  }

  if (ctx.chat?.id === undefined) {
    // Should be unreachable given the allowlist middleware ran first, but
    // never mutate state without a chat id pinned down.
    await safeAnswer(ctx, 'No chat context', log);
    return;
  }

  const loader = deps.loadFarm ?? loadFarm;
  let manifest: FarmManifest | null;
  try {
    manifest = await loader(parsed.taskSlug);
  } catch (err) {
    log('[farm-callback] loadFarm failed:', err);
    await safeAnswer(ctx, 'Farm load failed', log);
    return;
  }

  if (!manifest) {
    await safeAnswer(ctx, 'Farm not found (already GC’d?)', log);
    return;
  }

  try {
    await dispatch(parsed.action, ctx, manifest, deps, log);
  } catch (err) {
    log('[farm-callback] dispatch error:', err);
    await safeAnswer(ctx, 'Internal error', log);
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function extractCallbackData(ctx: Context): string | undefined {
  // Telegraf's typings on `ctx.callbackQuery.data` are split across union
  // members; pull it out defensively.
  const cb = ctx.callbackQuery as { data?: string } | undefined;
  return cb?.data;
}

async function safeAnswer(ctx: Context, text: string, log: LogFn): Promise<void> {
  try {
    await ctx.answerCbQuery(text);
  } catch (err) {
    log('[farm-callback] answerCbQuery failed:', err);
  }
}

async function dispatch(
  action: FarmCallbackAction,
  ctx: Context,
  manifest: FarmManifest,
  deps: FarmCallbackDeps,
  log: LogFn,
): Promise<void> {
  switch (action) {
    case 'x':
      return handleDiscard(ctx, manifest, deps, log);
    case 'd':
      return handleDiff(ctx, manifest, deps, log);
    case 'p':
      return withActionLock(`p:${manifest.taskSlug}`, ctx, manifest, deps, log, handleOpenPr);
    case 'r':
      return withActionLock(`r:${manifest.taskSlug}`, ctx, manifest, deps, log, handleRespawn);
  }
}

/**
 * M1: Acquire a per-slug lock before running a stateful handler (Open PR /
 * Respawn). Prevents double-tap races where two concurrent button presses
 * both read the manifest before either has finished writing to it.
 *
 * Flow:
 *   1. If a lock for `key` already exists: await the in-flight call, then
 *      re-read the manifest inside the lock so the guard sees persisted state.
 *      The second tap will then hit the idempotency guard in the handler and
 *      ack with "PR already open" / "Already respawned".
 *   2. If no lock exists: create the promise, store it, run the handler, then
 *      remove the lock in `finally` so the next genuine press starts fresh.
 */
async function withActionLock(
  key: string,
  ctx: Context,
  manifest: FarmManifest,
  deps: FarmCallbackDeps,
  log: LogFn,
  handler: (
    ctx: Context,
    manifest: FarmManifest,
    deps: FarmCallbackDeps,
    log: LogFn,
  ) => Promise<void>,
): Promise<void> {
  const existing = actionLocks.get(key);
  if (existing) {
    // Second tap: wait for in-flight call to settle, then re-read manifest
    // so idempotency guard inside the handler sees the persisted state.
    log(`[farm-callback] ${key} — second tap, awaiting in-flight lock`);
    try {
      await existing;
    } catch {
      // Tap 1 surfaced its own error to its caller; tap 2 must continue independently.
    }
    const loader = deps.loadFarm ?? loadFarm;
    let freshManifest: FarmManifest | null;
    try {
      freshManifest = await loader(manifest.taskSlug);
    } catch {
      await safeAnswer(ctx, 'Farm load failed', log);
      return;
    }
    if (!freshManifest) {
      await safeAnswer(ctx, 'Farm not found', log);
      return;
    }
    return handler(ctx, freshManifest, deps, log);
  }

  const raw = handler(ctx, manifest, deps, log);
  actionLocks.set(key, raw);
  // Detach the cleanup so the key clears only after settlement; waiters that
  // resumed before settlement still saw a non-undefined entry.
  raw.finally(() => {
    actionLocks.delete(key);
  });
  return raw;
}

// ---------------------------------------------------------------------------
// Open PR
// ---------------------------------------------------------------------------

async function handleOpenPr(
  ctx: Context,
  manifest: FarmManifest,
  deps: FarmCallbackDeps,
  log: LogFn,
): Promise<void> {
  // Idempotency: if a PR URL is already recorded, ack with it and return.
  if (manifest.prUrl) {
    await safeAnswer(ctx, `PR already open: ${manifest.prUrl}`, log);
    return;
  }

  // C2: Send progress ack BEFORE any awaitable network call so we beat
  // Telegram's ~3 s callback deadline even when gh is slow.
  await safeAnswer(ctx, 'Opening PR…', log);

  // Pre-flight: check gh is installed and authenticated.
  const ghReadyChecker = deps.checkGhReady ?? checkGhReady;
  let readiness: GhReadiness;
  try {
    readiness = await ghReadyChecker();
  } catch (err) {
    log('[farm-callback] checkGhReady threw:', err);
    // Progress ack ('Opening PR…') already fired — use ctx.reply for this error.
    try { await ctx.reply('gh readiness check failed — see daemon logs'); } catch { /* ignored */ }
    return;
  }

  if (!readiness.ok) {
    // Progress ack already fired — use ctx.reply for this error.
    try { await ctx.reply(readiness.hint); } catch { /* ignored */ }
    return;
  }

  // Resolve the winner branch (same logic as respawn / diff).
  const winnerResolver = deps.resolveWinnerBranch ?? resolveWinnerBranch;
  let winnerResult: Awaited<ReturnType<typeof resolveWinnerBranch>>;
  try {
    winnerResult = await winnerResolver(manifest);
  } catch (err) {
    log('[farm-callback] resolveWinnerBranch failed:', err);
    // Progress ack already fired — use ctx.reply for this error.
    try { await ctx.reply('Winner lookup failed'); } catch { /* ignored */ }
    return;
  }

  const head = winnerResult.branch.branch;
  const base = manifest.baseBranch ?? 'main';
  const title = `Auto PR: ${manifest.taskName}`;
  const body = `Auto-generated by afk farm ${manifest.taskSlug} | winner: ${head} | created: ${new Date().toISOString()}`;

  const prCreator = deps.createPr ?? createPr;
  let prUrl: string;
  try {
    prUrl = await prCreator({ base, head, title, body });
  } catch (err) {
    if (err instanceof GhError) {
      // P2: include timeout kind in the exhaustive map
      const messages: Record<GhError['kind'], string> = {
        'not-found': 'gh CLI not found — install with: brew install gh',
        'already-exists': 'PR already exists for this branch',
        'unauthed': 'gh is not authenticated — run: gh auth login',
        'network': 'Network error — check gh connectivity',
        'timeout': 'gh timed out — check connectivity',
        'unknown': 'gh pr create failed — see daemon logs',
      };
      // Progress ack already fired — use ctx.reply for this error.
      try { await ctx.reply(messages[err.kind]); } catch { /* ignored */ }
      return;
    }
    log('[farm-callback] createPr failed:', err);
    // Progress ack already fired — use ctx.reply for this error.
    try { await ctx.reply('gh pr create failed — see daemon logs'); } catch { /* ignored */ }
    return;
  }

  // Record the PR in the manifest (best-effort: PR is already open).
  const recorder = deps.recordPrCreated ?? recordPrCreated;
  try {
    await recorder(manifest.taskSlug, prUrl);
  } catch (err) {
    log('[farm-callback] recordPrCreated failed:', err);
    // PR is open — manifest is a log, not a gate. Continue to ack.
  }

  // The progress ack ('Opening PR…') already answered the callback; use
  // ctx.reply for the terminal success so both messages reach the user.
  try {
    await ctx.reply(`PR opened ✓\n🔗 ${prUrl}`);
  } catch (err) {
    log('[farm-callback] reply failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Respawn from winner
// ---------------------------------------------------------------------------

// Child slug derivation: delegated to `buildFarmSlug` in worktree.ts so the
// slug we write into `respawnedAs` on the parent manifest is byte-identical
// to the `taskSlug` the child `afk farm` subprocess will write on creation.
// Previously this handler replicated the formula inline and silently diverged
// from `createFarm` (different segment order, different suffix padding,
// different trailing-dash strip). Centralising prevents that drift class.

/**
 * Fire-and-forget: spawn `afk farm ...` detached so it outlives the Telegram
 * bot process.
 *
 * M2: Before unref-ing, attach error/exit listeners so child crashes surface in
 * the daemon log instead of vanishing silently.  Detached + unref semantics are
 * intentionally preserved — we add observability only.
 */
function defaultSpawnFarm(args: string[], log: LogFn = () => {}): void {
  log('[farm] spawning child afk process', { args });
  const child = spawn('afk', args, { detached: true, stdio: 'ignore' });
  child.on('error', (err) => {
    log('[farm] child spawn error', { args, err: err.message });
  });
  child.on('exit', (code, signal) => {
    if (code !== 0) {
      log('[farm] child exited with non-zero code', { args, code, signal });
    }
  });
  child.unref();
}

async function handleRespawn(
  ctx: Context,
  manifest: FarmManifest,
  deps: FarmCallbackDeps,
  log: LogFn,
): Promise<void> {
  // Idempotency: if already respawned, ack with existing child slug.
  if (manifest.respawnedAs) {
    await safeAnswer(ctx, `Already respawned as ${manifest.respawnedAs}`, log);
    return;
  }

  // C3: Guard against empty branch list — spawn with --branches 0 would
  // silently exit without creating any worktrees.
  if (manifest.branches.length === 0) {
    await safeAnswer(ctx, 'No branches remain — cannot respawn', log);
    return;
  }

  // C2: Send progress ack BEFORE any awaitable resolution work so we beat
  // Telegram's ~3 s callback deadline.
  await safeAnswer(ctx, 'Respawning…', log);

  // Resolve the winner branch.
  const winnerResolver = deps.resolveWinnerBranch ?? resolveWinnerBranch;
  let winnerResult: Awaited<ReturnType<typeof resolveWinnerBranch>>;
  try {
    winnerResult = await winnerResolver(manifest);
  } catch (err) {
    log('[farm-callback] resolveWinnerBranch failed:', err);
    // Progress ack ('Respawning…') already fired — use ctx.reply for this error.
    try { await ctx.reply('Winner lookup failed'); } catch { /* ignored */ }
    return;
  }

  const winnerBranch = winnerResult.branch;

  // Compute the child slug (deterministic in tests via _now/_randomSuffix).
  // Uses the canonical `buildFarmSlug` so the slug we pass via --task-slug is
  // byte-identical to what createFarm would have generated unprompted.
  const childSlug = buildFarmSlug(manifest.taskName, {
    now: deps._now,
    randomSuffix: deps._randomSuffix,
  });

  // P5: Log spawn parameters before calling spawner so a crash during spawn
  // leaves a breadcrumb in the daemon log.
  const branchCount = manifest.branches.length;
  log('[farm] spawning child', {
    childSlug,
    baseRef: winnerBranch.branch,
    branches: branchCount,
  });

  // Spawn the child farm.
  const spawner = deps.spawnFarm ?? ((args: string[]) => defaultSpawnFarm(args, log));
  try {
    spawner([
      'farm',
      manifest.taskName,
      '--branches', String(branchCount),
      '--base-ref', winnerBranch.branch,
      '--task-slug', childSlug,
    ]);
  } catch (err) {
    log('[farm-callback] spawnFarm failed:', err);
    // Progress ack already fired — use ctx.reply for this error.
    try { await ctx.reply('Respawn failed'); } catch { /* ignored */ }
    return;
  }

  // Record the respawn in the manifest (best-effort: spawn already fired).
  const recorder = deps.recordRespawn ?? recordRespawn;
  try {
    await recorder(manifest.taskSlug, childSlug);
  } catch (err) {
    log('[farm-callback] recordRespawn failed:', err);
    // Spawn already fired; manifest is a log, not a gate. Continue to ack.
  }

  // The progress ack ('Respawning…') already answered the callback; use
  // ctx.reply for the terminal success so both messages reach the user.
  try {
    await ctx.reply(
      `Respawning as \`${childSlug}\` from ${winnerBranch.branch} ✓\n🔄 Farm \`${manifest.taskSlug}\` respawned.\nChild slug: \`${childSlug}\`\nWinner branch: \`${winnerBranch.branch}\``,
    );
  } catch (err) {
    log('[farm-callback] reply failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Discard all (the only mutating action shipped in this slice)
// ---------------------------------------------------------------------------

async function handleDiscard(
  ctx: Context,
  manifest: FarmManifest,
  deps: FarmCallbackDeps,
  log: LogFn,
): Promise<void> {
  // Idempotency: read manifest state BEFORE any write. If the human already
  // discarded, just ack and return — no double-fact, no manifest churn.
  if (manifest.human_decision === 'rejected') {
    await safeAnswer(ctx, 'Already discarded', log);
    return;
  }

  // If the human approved or edited-then-merged earlier, the discard button
  // shouldn't overwrite that — surface the existing decision instead.
  if (manifest.human_decision !== undefined) {
    await safeAnswer(ctx, `Already resolved (${manifest.human_decision})`, log);
    return;
  }

  const recorder = deps.recordHumanDecision ?? recordHumanDecision;
  let updated: FarmManifest;
  try {
    updated = await recorder(manifest.taskSlug, 'rejected');
  } catch (err) {
    log('[farm-callback] recordHumanDecision failed:', err);
    await safeAnswer(ctx, 'Manifest write failed', log);
    return;
  }

  // Memory write is best-effort — the manifest is the source of truth.
  // We still report skip reasons in logs so a broken memory store is visible
  // without breaking the user-facing flow.
  const memWriter = deps.writeFarmDecisionFact ?? writeFarmDecisionFact;
  try {
    const result = memWriter({
      taskSlug: updated.taskSlug,
      decision: 'rejected',
      decidedAt: updated.decidedAt ?? new Date().toISOString(),
      via: 'telegram',
    });
    if ('skipped' in result) {
      log('[farm-callback] memory write skipped:', result.reason);
    }
  } catch (err) {
    log('[farm-callback] memory write threw:', err);
  }

  await safeAnswer(ctx, 'Discarded ✓', log);
  // A reply (not just the ack) leaves a durable record in the chat that the
  // user pressed the button. The ack alone is a transient toast.
  try {
    await ctx.reply(`❌ Farm \`${updated.taskSlug}\` discarded.`);
  } catch (err) {
    log('[farm-callback] reply failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Full diff (read-only, no state mutation)
// ---------------------------------------------------------------------------

async function handleDiff(
  ctx: Context,
  manifest: FarmManifest,
  deps: FarmCallbackDeps,
  log: LogFn,
): Promise<void> {
  if (manifest.branches.length === 0) {
    await safeAnswer(ctx, 'No branches to diff', log);
    return;
  }

  // Resolve the winning branch from on-disk score files using the SAME
  // ranking the digest used. Falling back to `manifest.branches[0]` here
  // would silently disagree with the "#1 winner" line the user just read
  // when the winner is not branch-1.
  const resolver = deps.resolveWinnerBranch ?? resolveWinnerBranch;
  let resolution: Awaited<ReturnType<typeof resolveWinnerBranch>>;
  try {
    resolution = await resolver(manifest);
  } catch (err) {
    log('[farm-callback] winner resolution failed:', err);
    await safeAnswer(ctx, 'Winner lookup failed', log);
    return;
  }

  const target = resolution.branch;
  const git = deps.execGit ?? defaultExecGit;
  await safeAnswer(ctx, 'Computing diff…', log);

  // Label tells the user why this branch was chosen — important when
  // resolution.source !== 'winner' (no tests passed, or scoring disabled).
  const sourceLabel =
    resolution.source === 'winner'
      ? '← winner'
      : resolution.source === 'top-scored'
        ? '← top-scored (no clean test pass)'
        : '← fallback (no scores)';

  try {
    const [logOut, statOut] = await Promise.all([
      git(target.path, ['log', '--oneline', `${manifest.baseRef}..HEAD`]),
      git(target.path, ['diff', '--stat', manifest.baseRef, 'HEAD']),
    ]);

    const body =
      `📊 Diff for ${target.branch} ${sourceLabel}\n` +
      `base: ${manifest.baseRef.slice(0, 7)}\n` +
      `\nCommits:\n${logOut.stdout.trim() || '(none)'}\n` +
      `\nStat:\n${statOut.stdout.trim() || '(no changes)'}`;

    // Telegram messages cap at 4096 chars; truncate defensively. The push
    // path already truncates outbound messages too, but `ctx.reply` doesn't.
    await ctx.reply(body.slice(0, 4000));
  } catch (err) {
    log('[farm-callback] diff failed:', err);
    try {
      await ctx.reply('Diff failed — see daemon logs.');
    } catch {
      // ignored
    }
  }
}

async function defaultExecGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}
