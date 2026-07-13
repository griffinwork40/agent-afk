/**
 * Denial circuit breaker: fail-fast for forked sub-agents spinning on
 * path-approval READ denials.
 *
 * A forked child cannot prompt to approve an out-of-scope path, so the
 * path-approval `PreToolUse` hook auto-denies the read (returns
 * `decision: 'block'`). A child granted too narrow a read scope — or one
 * genuinely reaching out-of-scope paths — then keeps issuing new (distinct)
 * reads, each denied, making no progress until its 20-minute wall-clock budget
 * expires (`SUBAGENT_DEFAULT_TIMEOUT_MS`). The consecutive-byte-identical
 * repeat breaker ({@link import('./repeat-circuit-breaker.js')}) does NOT catch
 * this: the reads target *different* paths, so they never fingerprint-collide.
 *
 * This breaker closes that gap. The stateful counter (per-dispatcher, so
 * per-forked-query) lives on `SessionToolDispatcher`; the pure predicates +
 * threshold + message builder live here. When a fork accumulates
 * {@link DENIAL_CIRCUIT_BREAKER_THRESHOLD} consecutive read denials with no
 * intervening successful tool call, the dispatcher tags the result
 * `failureClass: 'denial-breaker'`; the provider tool-use loop surfaces that as
 * a LOUD `error` event (→ `DenialCircuitBreakerError` via the shared subagent
 * handle), never a silent partial-success.
 *
 * Scope guards (see {@link READ_PATH_TOOLS} + the dispatcher's `parentSessionId`
 * check): counts READ tools only — write-denial confinement (worktree
 * isolation, `afk farm`) is untouched — and only for forked children, so
 * interactive sessions (which CAN approve a prompt) never trip.
 *
 * @module agent/tools/denial-circuit-breaker
 */

import type { ToolCall } from '../providers/anthropic-direct/types.js';
import type { ToolFailureClass } from '../trace/types.js';

/**
 * Consecutive path-approval read denials (with no intervening successful tool
 * call) after which a forked sub-agent is aborted fast. Fixed constant, mirror
 * of `REPEAT_CIRCUIT_BREAKER_THRESHOLD`. The issue (#546) suggested 5–10; 5
 * catches the observed 40-denial worst case ~8× sooner while the
 * reset-on-success rule (see the dispatcher) keeps a fork that probes a couple
 * of out-of-scope paths and then makes progress from ever tripping.
 */
export const DENIAL_CIRCUIT_BREAKER_THRESHOLD = 5;

/**
 * The `failureClass` stamped on the tool result that trips this breaker. The
 * provider loops key on this exact value to convert the result into a loud
 * `error` event. A member of {@link ToolFailureClass} (see `trace/types.ts`).
 */
export const DENIAL_BREAKER_FAILURE_CLASS: ToolFailureClass = 'denial-breaker';

/**
 * Typed file tools that READ a path. Mirrors path-approval-hook.ts's
 * `TYPED_FILE_TOOLS` minus `WRITE_TOOLS` (the source of truth for the
 * read/write split). Duplicated here rather than imported to avoid coupling the
 * dispatcher to the hook module for a set of core tool names that is extremely
 * stable; if path-approval adds a read tool, add it here too. Counting only
 * these tools is what preserves the write-confinement invariant: a confined
 * worker legitimately denied a WRITE still fails via its own path, not this
 * breaker.
 */
export const READ_PATH_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_directory',
  'glob',
  'grep',
]);

/**
 * Best-effort human-readable path for a denied read call, for the abort
 * message. Mirrors path-approval-hook.ts's `extractCandidatePath`:
 * `read_file` uses `file_path`; `list_directory`/`glob`/`grep` use `path`
 * (optional for glob/grep). Falls back to a tool-name marker when no path
 * argument is present.
 */
export function extractDeniedReadPath(call: ToolCall): string {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const raw =
    call.name === 'read_file' ? input['file_path'] : input['path'];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return `<${call.name} with no explicit path>`;
}

/**
 * Build the loud, actionable abort message. Names the accumulated denied paths
 * and the grant remedy so the parent can re-dispatch with a corrected read
 * scope, and explicitly calls out deliberate confinement (`afk farm`) as a
 * possible — and expected — cause so a confined worker still fails loud + fast
 * with the right framing rather than hanging.
 */
export function buildDenialBreakerMessage(
  deniedPaths: readonly string[],
  count: number,
): string {
  const pathList =
    deniedPaths.length > 0 ? deniedPaths.map((p) => `  - ${p}`).join('\n') : '  (no path captured)';
  return (
    `Denial circuit breaker: this forked sub-agent hit ${count} consecutive ` +
    `path-approval read denials with no successful tool call in between, and ` +
    `was aborted to avoid burning its wall-clock budget. A fork cannot approve ` +
    `its own reads. Denied paths:\n${pathList}\n\n` +
    `Remedy: these paths are outside the fork's granted read roots. Re-dispatch ` +
    `with the needed paths inside the child's cwd/worktree, or pass explicit ` +
    `readRoots granting them. If this worker is deliberately confined (e.g. an ` +
    `\`afk farm\` branch worker), this failure is expected — the paths are ` +
    `outside its assigned scope; widen the scope or narrow the task.`
  );
}
