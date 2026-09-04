/**
 * Shared live tool-activity callback contract.
 *
 * The dispatcher's concurrency pool reports every membership change — each
 * worker start and each worker settle. Provider generators relay every snapshot
 * so surfaces can clear a parallel badge immediately on the `2 -> 1` transition
 * rather than leaving stale `[×2]` state until the final call settles.
 *
 * @module agent/providers/shared/tool-activity
 */

/**
 * Callback through which an execution layer reports its LIVE tool activity.
 *
 * Contract: invoked on every change to the running set — each worker start and
 * each worker settle — with the ids executing at that instant. `readonly` is
 * load-bearing: the producer may hand over a snapshot it still owns, so a
 * consumer must copy before retaining. An empty array is a valid terminal
 * report meaning "nothing is running any more".
 *
 * Declared here so the dispatcher, both provider generators, and the
 * `ToolDispatcherLike` seam all name one type instead of restating a structural
 * signature that could drift.
 */
export type ToolActivityReporter = (activeIds: readonly string[]) => void;
