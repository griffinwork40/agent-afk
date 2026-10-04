/**
 * Work-derived spinner verbs.
 *
 * The vocabulary owner is cli/tool-category.ts: delegating to its
 * `humanVerbForTool` keeps the spinner and tool lane from disagreeing about
 * the same tool. Only the trailing ellipsis is removed here, since the spinner
 * appends its own punctuation.
 *
 * With no tool in flight this returns `undefined`, allowing the spinner to
 * rotate noir/goblin flavour words while the model thinks or streams.
 *
 * @module cli/input/work-derived-verb
 */

import { categorizeTool, CATEGORY_HUMAN_VERB, humanVerbForTool } from '../tool-category.js';

/**
 * The verb for a tool name, or `undefined` when there is no tool to describe.
 *
 * Contract: an empty / whitespace-only name yields `undefined` rather than
 * `'Working'`, so a caller that has not yet observed a tool_use is treated as
 * idle (flavour pool) instead of being labelled with a false activity claim.
 */
export function verbForToolName(toolName: string | undefined): string | undefined {
  if (!toolName || !toolName.trim()) return undefined;
  return humanVerbForTool(toolName).replace(/…$/, '');
}

/**
 * Tracks which tools are in flight so the spinner can name one of them.
 *
 * Invariant: a parallel wave has many concurrent tool calls, so completion of
 * ONE must not blank the verb while siblings still run. Membership is keyed by
 * `toolUseId` and {@link current} reports the most recently STARTED entry that
 * has not yet completed — the freshest true statement about the session.
 *
 * Bounded by construction: entries are added on start and removed on result, and
 * {@link reset} clears the map between turns so an abandoned id cannot pin a
 * stale verb forever.
 */
export class InFlightToolTracker {
  /** Insertion-ordered: JS Map iteration order gives "most recent" for free. */
  private readonly inFlight = new Map<string, string>();

  /** Record a tool as started. */
  start(toolUseId: string, toolName: string): void {
    // Delete-then-set so a repeated id moves to the end of the iteration order
    // rather than keeping its original (now stale) position.
    this.inFlight.delete(toolUseId);
    this.inFlight.set(toolUseId, toolName);
  }

  /** Record a tool as finished. Unknown ids are ignored. */
  finish(toolUseId: string): void {
    this.inFlight.delete(toolUseId);
  }

  /** The most recently started still-running tool name, or `undefined` if idle. */
  current(): string | undefined {
    let last: string | undefined;
    for (const name of this.inFlight.values()) last = name;
    return last;
  }

  /**
   * The most representative in-progress verb for the current wave, or
   * `undefined` when idle.
   *
   * Selection rules (applied in priority order):
   * 1. **Idle** — no tools in flight → `undefined` (spinner falls back to its
   *    flavour pool).
   * 2. **Unanimous verb** — every in-flight tool resolves to the same verb
   *    (e.g. three `read_file` calls all say "Reading") → show that verb.
   * 3. **Unanimous category** — verbs differ but all tools share the same
   *    category (e.g. `bash` and `test_run` both in `shell`) → show the
   *    category's human label (e.g. "Running").
   * 4. **Mixed categories** — tools span different categories (e.g. `agent`
   *    and `wait_for`) → show "Working" so the spinner is honest without
   *    privileging whichever tool started last.
   *
   * The trailing `…` from `CATEGORY_HUMAN_VERB` is stripped here (not in
   * `verbForToolName`) so the spinner's own punctuation appends cleanly.
   */
  currentVerb(): string | undefined {
    if (this.inFlight.size === 0) return undefined;

    // Collect unique verbs and categories across all in-flight tools.
    let firstVerb: string | undefined;
    let firstCategory: string | undefined;
    let unanimousVerb = true;
    let unanimousCategory = true;

    for (const toolName of this.inFlight.values()) {
      const verb = humanVerbForTool(toolName).replace(/…$/, '');
      const cat = categorizeTool(toolName);

      if (firstVerb === undefined) {
        firstVerb = verb;
        firstCategory = cat;
      } else {
        if (verb !== firstVerb) unanimousVerb = false;
        if (cat !== firstCategory) unanimousCategory = false;
      }
    }

    // Rule 2: all tools agree on the same verb.
    if (unanimousVerb) return firstVerb;

    // Rule 3: verbs differ but all tools share the same category.
    if (unanimousCategory && firstCategory !== undefined) {
      return CATEGORY_HUMAN_VERB[firstCategory as keyof typeof CATEGORY_HUMAN_VERB].replace(/…$/, '');
    }

    // Rule 4: mixed categories — use a neutral fallback.
    return 'Working';
  }

  /** Drop all tracking — call between turns so state never leaks. */
  reset(): void {
    this.inFlight.clear();
  }
}

/** The slice of the compositor this adapter needs. Structural, so mocks satisfy it. */
export interface ActiveToolNameSink {
  setActiveToolName?(toolName: string | undefined): void;
}

/** Minimal event shape — avoids importing the full OutputEvent union here. */
interface MaybeToolEvent {
  type: string;
  chunk?: { type: string; toolUseId?: string; toolName?: string };
}

/**
 * Mirror one stream event into `tracker` and push the resulting tool name to
 * `sink`. Returns true when a tool transition was observed (useful in tests).
 *
 * A free function rather than a StreamRenderer method so the renderer — already
 * far past the 350-line ceiling — gains a call site instead of new logic, and so
 * this is unit-testable without constructing a renderer.
 *
 * `setActiveToolName` is invoked optionally on purpose: several suites build
 * partial compositor mocks, and this signal is purely cosmetic, so a reduced
 * surface must degrade to "no work-derived verb" rather than throw inside the
 * event path.
 */
export function noteToolEvent(
  event: MaybeToolEvent,
  tracker: InFlightToolTracker,
  sink: ActiveToolNameSink | null | undefined,
): boolean {
  if (event.type !== 'chunk' || !event.chunk) return false;
  const chunk = event.chunk;
  if (!chunk.toolUseId) return false;
  if (chunk.type === 'tool_use_detail') {
    tracker.start(chunk.toolUseId, chunk.toolName ?? '');
  } else if (chunk.type === 'tool_result') {
    tracker.finish(chunk.toolUseId);
  } else {
    return false;
  }
  sink?.setActiveToolName?.(tracker.currentVerb());
  return true;
}
