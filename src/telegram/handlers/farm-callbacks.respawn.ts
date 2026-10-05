/**
 * Respawn action handler extracted from farm-callbacks.ts.
 *
 * Handles the `r` (Respawn from winner) button on farm digest messages and the
 * `defaultSpawnFarm` utility it depends on.
 * Extracted to keep farm-callbacks.ts under the 350-line ceiling (#832).
 *
 * @module telegram/handlers/farm-callbacks.respawn
 */

import { spawn } from 'node:child_process';
import type { Context } from 'telegraf';
import { buildFarmSlug, recordRespawn, type FarmManifest } from '../../agent/worktree.js';
import { resolveWinnerBranch } from '../../skills/score/winner.js';
import type { FarmCallbackDeps } from './farm-callbacks.js';

type LogFn = (...args: unknown[]) => void;

async function safeAnswer(ctx: Context, text: string, log: LogFn): Promise<void> {
  try {
    await ctx.answerCbQuery(text);
  } catch (err) {
    log('[farm-callback] answerCbQuery failed:', err);
  }
}

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
 * the daemon log instead of vanishing silently. Detached + unref semantics are
 * intentionally preserved -- we add observability only.
 */
export function defaultSpawnFarm(args: string[], log: LogFn = () => {}): void {
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

/**
 * Handle the Respawn (`r`) button.
 *
 * Idempotency: if a respawn has already been recorded in the manifest, acks
 * with the existing child slug and returns -- no second spawn is fired.
 *
 * Contract: safeAnswer is called BEFORE any awaitable resolution work so the
 * callback ack beats Telegram's ~3 s deadline.
 */
export async function handleRespawn(
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

  // C3: Guard against empty branch list -- spawn with --branches 0 would
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
    // Progress ack ('Respawning…') already fired -- use ctx.reply for this error.
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
    // Progress ack already fired -- use ctx.reply for this error.
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
      `Respawning as \`${childSlug}\` from ${winnerBranch.branch}\n🔄 Farm \`${manifest.taskSlug}\` respawned.\nChild slug: \`${childSlug}\`\nWinner branch: \`${winnerBranch.branch}\``,
    );
  } catch (err) {
    log('[farm-callback] reply failed:', err);
  }
}
