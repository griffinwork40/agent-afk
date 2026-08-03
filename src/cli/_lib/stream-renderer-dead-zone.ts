/**
 * Dead-zone checker for the progress-banner slot: the window where an
 * active-but-silent subagent child produced no banner update at all.
 *
 * Extracted from stream-renderer-lifecycle.ts (which sits at the 350-line
 * ceiling) so this concern owns its own file. Sibling of `checkPauseAnnotations`
 * by design — two functions on the same 80ms tick, each owning one concern.
 *
 * @module cli/_lib/stream-renderer-dead-zone
 */

import { isDebugEnabled } from '../../utils/debug.js';
import { ORCHESTRATOR_SOURCE_KEY } from './stream-renderer-source.js';
import { CHILD_QUIET_MS } from './child-activity-select.js';
import type { LifecycleContext } from './stream-renderer-lifecycle.js';

// Invariant: this check rides the EXISTING 80ms pause-tick interval owned by
// StreamRenderer — it must never schedule a timer of its own. A clock that
// repaints a variable-height overlay block independently of real events is a
// failure class this codebase has already paid for twice (the H2 fix throttled
// per-parent overlay rebuilds to >=1500ms because ~50-80Hz repaints produced
// N-fold ghost rows). live-progress-no-timer.test.ts enforces this structurally
// for this module.
//
// Problem being solved: the progress banner only recomposes when something
// marks the OverlayComposer dirty, and a genuinely-silent child emits no events
// to drive that recompose. So between roughly 1.5s (the H2 overlay throttle)
// and 30s — the tool-lane pause threshold (PAUSE_THRESHOLD_MS), past which the
// `· waiting Xs` annotation arms — the banner's silence clause never appeared.
// This checker covers the 8s-and-later part of that window: the clause is
// gated on CHILD_QUIET_MS (8s), so ~1.5s-8s remains without new feedback by
// design, since a child silent under 8s is not yet worth flagging.
//
// Why the flush is LATCHED rather than fired every tick: flush() recomposes all
// five overlay slots (markDirty sets one shared dirty flag, so there is no
// per-slot short-circuit), and the composed banner carries the child's elapsed
// durationMs rounded to whole seconds — so the final string is NOT byte-stable
// across a second boundary and setOverlay's identical-string dedup cannot be
// relied on to make repeat flushes free. Flushing on every tick while a child
// stayed quiet therefore meant ~12.5 full recomposes/sec indefinitely plus a
// real repaint about once a second. The per-source latch below collapses that
// to exactly one flush per quiet transition, which is all the static
// `no output (waiting)` clause actually needs.

/**
 * Marks the `progress-banner` slot dirty the moment a running child crosses
 * into silence past `CHILD_QUIET_MS`, so the static `no output (waiting)`
 * clause appears during the dead zone.
 *
 * Latched per source: fires once on the transition into silence, re-arms when
 * the child speaks again. Returns true iff a source newly transitioned (and the
 * overlay was therefore flushed).
 */
export function checkProgressBannerStaleness(ctx: LifecycleContext): boolean {
  const composer = ctx.overlayComposer;
  if (ctx.disposed || !ctx.isTTY || !composer) return false;
  const now = Date.now();
  let transitioned = false;
  // Sweep every source before flushing. An early return would leave siblings'
  // latches stale, so a child that resumed would never re-announce a later
  // silence.
  for (const [sourceId, source] of ctx.sources) {
    if (sourceId === ORCHESTRATOR_SOURCE_KEY) continue;
    if (source.done || source.errored) continue;
    const silentMs = Math.max(0, now - source.lastEventAt);
    if (silentMs < CHILD_QUIET_MS) {
      // Child spoke again — re-arm so a later silence re-announces.
      source.quietBannerAnnounced = false;
      continue;
    }
    if (source.quietBannerAnnounced) continue;
    source.quietBannerAnnounced = true;
    transitioned = true;
    if (isDebugEnabled()) {
      process.stderr.write(
        `[stream-renderer] progress_banner_quiet ${JSON.stringify({ sourceId, silentMs })}\n`,
      );
    }
  }
  if (transitioned) {
    composer.markDirty('progress-banner');
    composer.flush();
  }
  return transitioned;
}
