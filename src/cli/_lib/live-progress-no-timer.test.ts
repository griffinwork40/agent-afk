/**
 * Structural guard: the live-progress feature adds NO autonomous timer.
 *
 * Invariant being protected (documented at stream-renderer-orchestrator.ts, in
 * `handleOrchestratorEvent`): "at most one setComposedOverlay call per event."
 * The repaint model here is event-driven. A clock-tick that repaints a
 * variable-height overlay block independently of real events is the failure class
 * this codebase has already paid for twice — the H2 fix throttled per-parent
 * overlay rebuilds to >=1500ms because ~50-80Hz repaints produced N-fold ghost
 * rows (see stream-renderer-subagent.ts), and docs/tui-invariants.md names "an
 * 80ms timer fires in the gap and mutates state the next step assumes is
 * quiescent" as the recurrence vector for lifecycle corruption.
 *
 * So the child-activity banner fallback and the work-derived spinner verb are
 * both PULL-based: they are read during repaints/ticks that already happen. This
 * test fails if anyone reintroduces a timer into those modules, which would
 * silently re-open that bug class.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** Modules introduced by the live-progress work — all must be timer-free. */
const TIMER_FREE_MODULES = [
  'src/cli/_lib/child-activity-select.ts',
  'src/cli/input/work-derived-verb.ts',
  // stream-renderer-lifecycle.ts hosts checkPauseAnnotations, and
  // stream-renderer-dead-zone.ts hosts checkProgressBannerStaleness. Both ride
  // the EXISTING 80ms pause tick (stream-renderer.ts:485) — neither may
  // introduce its own setInterval/setTimeout. Guard both so a future refactor
  // cannot silently add one to the dead-zone path.
  'src/cli/_lib/stream-renderer-lifecycle.ts',
  'src/cli/_lib/stream-renderer-dead-zone.ts',
] as const;

function read(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

/** Strip comments so prose ABOUT timers cannot trip the assertions. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('live-progress modules introduce no autonomous timer', () => {
  for (const relPath of TIMER_FREE_MODULES) {
    it(`${relPath} schedules nothing`, () => {
      const code = stripComments(read(relPath));
      // Call-form regexes (not bare-word) so type annotations like
      // `ReturnType<typeof setInterval>` do not false-positive — a real
      // timer call always has parens. Matches the spinner test's approach.
      expect(code).not.toMatch(/\bsetInterval\s*\(/);
      expect(code).not.toMatch(/\bsetTimeout\s*\(/);
      expect(code).not.toMatch(/\bsetImmediate\s*\(/);
      expect(code).not.toMatch(/requestAnimationFrame\s*\(/);
    });
  }

  it('the spinner still owns exactly one interval', () => {
    // The work-derived verb is read inside the EXISTING 80ms tick. If this count
    // grows, a second competing clock was added to the same render path.
    const code = stripComments(read('src/cli/input/spinner.ts'));
    // Call-form only: the file also names `ReturnType<typeof setInterval>` as the
    // handle's type, which is not a second timer.
    const intervals = code.match(/\bsetInterval\s*\(/g) ?? [];
    expect(intervals).toHaveLength(1);
  });

  it('the banner fallback is reached by pull, not by push', () => {
    // deriveChildBanner must be invoked from render paths only. If it ever
    // gains its own scheduling, the guard above catches it; here we assert the
    // two known call sites are the render composers.
    const orchestrator = read('src/cli/_lib/stream-renderer-orchestrator.ts');
    const lifecycle = read('src/cli/_lib/stream-renderer-lifecycle.ts');
    expect(orchestrator).toContain('deriveChildBanner(ctx)');
    expect(lifecycle).toContain('deriveChildBanner(ctx)');
  });

  it('the compositor tool-name setter does not repaint', () => {
    // Painting there would add a second frame write per tool event; the caller
    // already repaints for the same transition.
    const src = read('src/cli/terminal-compositor.ts');
    const start = src.indexOf('setActiveToolName(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('}', start));
    expect(body).not.toMatch(/repaint|flush|markDirty/);
  });
});
