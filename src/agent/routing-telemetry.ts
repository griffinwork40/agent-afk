/**
 * Routing-decision telemetry for subagent dispatches.
 *
 * Appends to `$AFK_HOME/agent-framework/routing-decisions.jsonl` so
 * cross-session aggregation can show which subagent types get dispatched,
 * from what parent, when. Best-effort — telemetry failures never propagate.
 */

import { env } from '../config/env.js';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { getAgentFrameworkDir } from '../paths.js';

function getRoutingTelemetryPath(): string {
  return join(getAgentFrameworkDir(), 'routing-decisions.jsonl');
}

/**
 * Routing-decision entry shape. Only `event` is required; other fields are
 * event-dependent (per audit §G). Keeping the type loose lets new events
 * (subagent.completed, subagent.failed, delegation.skipped, etc.) share the
 * same JSONL surface without forcing every emitter through a discriminated
 * union — the schema is enforced at write time, not by the type system.
 *
 * Privacy: do not add fields here for prompts, responses, file contents,
 * tool inputs/outputs, stack traces, or credentials. See audit §G.4.
 */
export interface RoutingDecisionEntry {
  event: string;
  /** Subagent id when the event is about a specific child. */
  subagent_id?: string | undefined;
  id_prefix?: string | undefined;
  parent_session_id?: string | undefined;
  /** Parent subagent id when the event is emitted from a refusal site. */
  parent_subagent_id?: string | undefined;
  /** Outcome status for completed/failed events. */
  status?: string | undefined;
  /** Wall-clock duration of the child run in milliseconds. */
  duration_ms?: number | undefined;
  /** Size of the returned assistant content, in characters. */
  content_chars?: number | undefined;
  /** Short error message — no stack traces, no user content. */
  error_message?: string | undefined;
  /** Short schema-validation error message when present. */
  schema_error?: string | undefined;
  /** Size of any partial output captured before failure, in characters. */
  partial_output_chars?: number | undefined;
  /** Nesting depth at the emission site. */
  depth?: number | undefined;
  /** Skip / refusal reason. */
  reason?: string | undefined;
  /** Requested skill / agent name at a refusal site. */
  requested_name?: string | undefined;
  /** Model name when relevant (dispatched events). */
  model?: string | undefined;
  /**
   * Skill dispatch mode for `skill.*` events: "inline" | "fork" | "load".
   * Operational metadata only (no user content) — lets usage queries
   * distinguish in-context `load` dispatches from forked ones.
   */
  mode?: string | undefined;
  /** Maximum turns when relevant (dispatched events). */
  max_turns?: number | undefined;
  /** Number of DAG nodes in a compose call. */
  node_count?: number | undefined;
  /** Number of DAG edges in a compose call. */
  edge_count?: number | undefined;
  /** Count of succeeded nodes in a compose result. */
  succeeded?: number | undefined;
  /** Count of failed nodes in a compose result. */
  failed?: number | undefined;
  /** Count of skipped nodes in a compose result. */
  skipped?: number | undefined;
  /** Number of tool calls made during execution. */
  tool_call_count?: number | undefined;
  /** Whether extended thinking was present in the execution. */
  thinking_present?: boolean | undefined;
  /** JSON-encoded string array of unique tool names invoked (privacy: names only, no inputs). */
  tool_names?: string | undefined;
  /**
   * Tool name for tool-level events (e.g. `tool.overflow_kill`).
   * Privacy: short identifier only (e.g. "grep", "bash") — not the tool input.
   */
  tool?: string | undefined;
  /**
   * Byte count for tool-level overflow events. Operational metric only;
   * deliberately no `pattern` / `path` / `command` fields here — those are
   * tool inputs and stay out of telemetry per audit §G.4.
   */
  total_bytes?: number | undefined;
  /** Source stream when the event is stream-scoped: "stdout" | "stderr". */
  stream?: string | undefined;
}

/**
 * Append a routing-decision entry. Best-effort: mkdir + append with
 * POSIX O_APPEND atomicity (entries are well under PIPE_BUF). Swallows
 * errors so telemetry never breaks dispatch.
 */
export async function appendRoutingDecision(
  entry: RoutingDecisionEntry,
): Promise<void> {
  // No-op under vitest — fixture dispatches would pollute the real stream.
  if (env.VITEST || env.NODE_ENV === 'test') {
    return;
  }
  try {
    const telemetryPath = getRoutingTelemetryPath();
    await mkdir(dirname(telemetryPath), { recursive: true });

    const ts = new Date().toISOString().split('.')[0] + 'Z';
    // Drop undefined fields so JSONL stays compact and consumers don't have
    // to special-case the difference between "absent" and "explicit null".
    const cleaned: Record<string, unknown> = { ts, surface: 'afk' };
    for (const [k, v] of Object.entries(entry)) {
      if (v !== undefined) cleaned[k] = v;
    }
    const line = JSON.stringify(cleaned) + '\n';

    await writeFile(telemetryPath, line, { flag: 'a' });
  } catch {
    // Telemetry failure must never surface as a dispatch error.
  }
}
