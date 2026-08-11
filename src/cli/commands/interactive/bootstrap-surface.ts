import { resolve } from 'node:path';
import { StatusLine } from '../../status-line.js';
import { GitStatusSampler } from '../../git-status-sampler.js';
import { createConsoleWriter } from '../../slash/writer.js';
import { createSessionStats } from '../../slash/session-stats.js';
import type { SessionStats } from '../../slash/types.js';
import type { PermissionMode } from '../../../agent/types/sdk-types.js';
import type { CompletionWriter } from './shared.js';
import { reseedStatsFromStored } from './shared.js';
import { createReplRenderer } from './repl-renderer.js';
import { TrustedSkillLedger } from '../../trusted-skill-ledger.js';
import type { CliConfig } from '../../config.js';
import type { CliOptions } from './shared.js';
import type { ResolvedResumeTarget } from '../../resume-session.js';
import { createDefaultTraceWriter } from '../../../agent/trace/factory.js';
import { palette } from '../../palette.js';
import { boundLineToTerminal } from '../../render/bounded-line.js';

/**
 * Seed session stats + permission/thinking-UI mode, print the `trace:` and
 * `↪ resuming in` startup lines, and construct the status line, REPL
 * renderer, console writer, trusted-skill ledger, and git-status sampler.
 *
 * Console output order is fixed: `mcp:` (bootstrap-mcp.ts) → `trace:` →
 * `↪ resuming in` — preserved by calling this phase strictly after MCP
 * connect in `bootstrap.ts`.
 *
 * NOTE: `contextSampler` stays in `bootstrap.ts` — it needs `session`, which
 * is only built after this phase returns.
 */
export function createReplSurface(a: {
  options: CliOptions;
  cliConfig: CliConfig;
  sessionModel: string;
  resumeTarget: ResolvedResumeTarget | undefined;
  effectiveCwd: string | undefined;
  extrasCwd: string | undefined;
  trace: ReturnType<typeof createDefaultTraceWriter>;
}): {
  stats: SessionStats;
  initialPermissionMode: PermissionMode | undefined;
  completionWriter: CompletionWriter;
  statusLine: StatusLine;
  replRenderer: ReturnType<typeof createReplRenderer>;
  writer: ReturnType<typeof createConsoleWriter>;
  trustedSkillLedger: TrustedSkillLedger;
  gitStatusSampler: GitStatusSampler;
} {
  // Create stats before session so the plan-mode gate getter can close over it.
  const stats = createSessionStats(a.sessionModel);
  if (a.resumeTarget?.stored) {
    reseedStatsFromStored(stats, a.resumeTarget.stored, a.resumeTarget.resumeId);
  }
  // Initial permission mode: --dangerously-skip-permissions wins, else the
  // resolved afk.config.json `permissionMode` (loadConfig now always returns one
  // — DEFAULT_CLI_PERMISSION_MODE = bypass for new installs, overridable by the
  // config key). Stamped on stats so the status-line badge + the plan/AFK/bypass
  // gate getters reflect it from turn 1; the session is constructed with the same
  // value via sharedDeps. The `!== undefined` guard is retained defensively.
  const initialPermissionMode = a.options.dangerouslySkipPermissions
    ? ('bypassPermissions' as const)
    : a.cliConfig.permissionMode;
  if (initialPermissionMode !== undefined) {
    stats.permissionMode = initialPermissionMode;
  }
  // Seed thinking-UI mode so `/thinking` has a live value to mutate.
  // `options.thinkingUi` was already resolved by the interactive action handler
  // via `resolveThinkingUi` (--thinking-ui flag > AFK_THINKING_UI env >
  // interactive.thinkingUi config > 'live'), so this seeds the persistent
  // default. `createSessionStats()` pre-seeds 'live' for any path that reaches
  // bootstrap without that resolution (e.g. tests constructing options directly).
  if (a.options.thinkingUi !== undefined) {
    stats.thinkingUi = a.options.thinkingUi;
  }
  // Stamp the effective working directory on stats so the status line can
  // render it. We capture the same cwd the provider will see: `effectiveCwd`
  // (the explicit `--worktree` override when present, else a resumed session's
  // restored cwd — see resolveResumeCwd above), falling back to
  // `process.cwd()`. Captured once at bootstrap — sessions don't `chdir`
  // mid-run, and the status line treats this as a fixed identity field.
  stats.cwd = a.effectiveCwd ?? process.cwd();

  // Trace was opened earlier (before the executor) so the
  // BackgroundAgentRegistry could be constructed with the writer. Surface
  // the path here so the startup banner ordering is preserved.
  if (a.trace) {
    console.log(palette.dim(`  trace: ${a.trace.tracePath}`));
  }
  // Make a restored resume cwd legible: only when the cwd came from the stored
  // session (not an explicit --worktree, which the banner already implies) and
  // differs from where the shell launched. Printed in the same dim-log style
  // as the trace line above, before the compositor is armed.
  if (
    a.extrasCwd === undefined &&
    a.effectiveCwd !== undefined &&
    resolve(a.effectiveCwd) !== resolve(process.cwd())
  ) {
    console.log(palette.dim(`  ↪ resuming in ${a.effectiveCwd}`));
  }

  // Both slots default to `console.log` here; `runReplLoop` mutates them
  // after `armCompositor` resolves (when a borrowed compositor is available)
  // so between-turn slash output commits above the live overlay instead of
  // overlaying onto the input row. See CompletionWriter docs in shared.ts.
  //
  // Invariant: while these slots hold the raw `console.log` default there is
  // no compositor to wrap what they emit, so each line is bounded to the
  // terminal here. Once `runReplLoop` swaps in `compositor.commitAbove`, that
  // sink owns wrapping (and band reflow on resize) and this bound is gone
  // with the closure — the two must never both wrap the same line.
  const completionWriter: CompletionWriter = {
    fn: (line) => console.log(boundLineToTerminal(line)),
    idleFn: (line) => console.log(boundLineToTerminal(line)),
  };
  // Construct StatusLine BEFORE createReplRenderer so the renderer can route
  // its inter-turn raw writes through statusLine.withFullScrollRegion(...) —
  // see repl-renderer.ts for the DECSTBM sub-region scroll-loss contract this
  // wiring is defending against.
  // `tickMs` is resolved caller-side (StatusLine defaults it off, like the
  // compositor's caret blink) so only the REPL gets a recurring timer. 30s is
  // half the quota countdown's minute granularity, which is the finest
  // clock-derived value the row renders.
  const statusLine = new StatusLine({ tickMs: 30_000 });
  const replRenderer = createReplRenderer(process.stdout, { statusLine });

  const trustedSkillLedger = new TrustedSkillLedger();
  // Slash-command writer routes through `completionWriter` so when Stage 3's
  // persistent compositor swaps `completionWriter.fn` to `compositor.commitAbove`
  // between turns (it currently only swaps mid-turn — see turn-handler.ts:124),
  // slash output commits above the live overlay instead of tearing it. No
  // behavior change today: completionWriter.fn === console.log when slash
  // commands run (always between turns under the current arm/disarm cycle).
  const writer = createConsoleWriter(completionWriter);
  // GitStatusSampler resolves the current branch (fast, local) + open PR
  // (network, detached) for the status line. `cwd` is a live accessor over
  // `stats.cwd` rather than a frozen string (issue #877): a deferred
  // `afk -w` worktree re-anchor stamps `ctx.stats.cwd = outcome.path` in
  // interactive.ts AFTER this sampler is constructed, at the same site that
  // calls `session.setCwd()` — reusing that existing signal here means the
  // sampler's NEXT sample (this function's `branchTtlMs` bounds staleness to
  // ~1s) reads the new checkout instead of the launch one, with no separate
  // re-point call needed. Construction is side-effect-free (no process
  // spawn): the initial sample + the on-update repaint wiring are kicked by
  // setupSurface (REPL Phase 1), so bootstrap-only unit tests never shell
  // out to git/gh.
  const gitStatusSampler = new GitStatusSampler({
    cwd: () => stats.cwd ?? process.cwd(),
    // Suppress the per-turn git subprocess if the branch was checked < 1 s
    // ago — human turns are seconds apart so this is imperceptible, and it
    // bounds overhead on slow filesystems (network mounts, Docker volumes).
    // A detected cwd change bypasses this guard (see updateBranch()).
    branchTtlMs: 1_000,
  });

  return {
    stats,
    initialPermissionMode,
    completionWriter,
    statusLine,
    replRenderer,
    writer,
    trustedSkillLedger,
    gitStatusSampler,
  };
}
