import { palette } from '../../palette.js';
import { truncateDisplayWidth } from '../../display.js';
import type { InteractiveCtx } from './shared.js';
import type { FooterSubsystems } from './footer-subsystems.js';

/** Human-facing summaries only; injection buffers drain separately before turns. */
export function drainLoopNotifications(
  ctx: InteractiveCtx,
  shellPassthrough: FooterSubsystems['shellPassthrough'],
  bgResultNotifier: FooterSubsystems['bgResultNotifier'],
): void {
  for (const { job, result } of shellPassthrough.drainNotifications()) {
    const glyph = result.errorReason === undefined ? '✓' : '✗';
    const exitPart = result.errorReason === 'abort'
      ? 'killed'
      : result.errorReason === 'timeout'
        ? 'timed out'
        : result.errorReason === 'signal-killed'
          ? 'killed by signal'
          : `exit ${result.exitCode ?? 0}`;
    const seconds = Math.max(0, Math.round(result.durationMs / 100) / 10);
    ctx.replRenderer.writeLine(
      palette.dim(`  ${glyph} [${job.id}] ${exitPart} · ${seconds}s · `) + job.command,
    );
  }
  for (const { job } of bgResultNotifier.drainNotifications()) {
    const glyph = job.status === 'completed' ? '✓' : job.status === 'failed' ? '✗' : '⊘';
    const seconds = job.endedAt !== undefined
      ? Math.max(0, Math.round((job.endedAt - job.startedAt) / 100) / 10)
      : 0;
    const label = truncateDisplayWidth(job.label, 60);
    ctx.replRenderer.writeLine(
      palette.dim(`  ${glyph} [${job.jobId}] subagent ${job.status} · ${seconds}s · `) + label,
    );
  }
}
