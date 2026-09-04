/**
 * Size-cap for foreground subagent results returned to the parent.
 *
 * When a subagent's final message exceeds a configurable byte threshold
 * (AFK_SUBAGENT_RESULT_CAP_BYTES, default 32KB), the full text is spilled
 * to a sidecar file and the parent receives a head+tail slice with an
 * explicit file pointer it can `read_file` to retrieve the rest.
 *
 * Clones the proven spillNodeOutput pattern from compose-executor.ts.
 * Best-effort: spill failures are swallowed and the parent still receives
 * the truncated view (without a file pointer).
 *
 * @module agent/tools/subagent/foreground-promotion.result-cap
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getSessionsDir } from '../../../paths.js';
import { headAndTail } from '../handlers/_output-cap.js';
import { env } from '../../../config/env.js';

/**
 * Default cap: 32KB. Large enough that well-behaved subagents (which already
 * follow the SUBAGENT_HANDOFF_CONTRACT and keep replies compact) never trip
 * it; small enough to catch pathological dumps that blow up parent context.
 */
const DEFAULT_CAP_BYTES = 32_768;

/**
 * Parse the env-tunable cap. Returns undefined when the cap is disabled (0)
 * or the env var is absent/unparseable (falls back to default).
 */
function resolveCapBytes(): number | undefined {
  const raw = env.AFK_SUBAGENT_RESULT_CAP_BYTES;
  if (raw === undefined || raw === '') return DEFAULT_CAP_BYTES;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return DEFAULT_CAP_BYTES;
  if (parsed === 0) return undefined; // disabled
  return parsed;
}

/**
 * Write the full pre-truncation subagent output to disk so the parent can
 * retrieve it via `read_file`. Best-effort: failures are swallowed and the
 * caller continues without a spill path.
 *
 * Layout: `<sessions>/<sessionId>/subagent-handoffs/<subagentId>.txt`
 */
function spillSubagentOutput(
  sessionId: string,
  subagentId: string,
  raw: string,
): string | undefined {
  try {
    // Defense-in-depth: strip path separators so a crafted id cannot escape
    // the sessions directory. In practice both values are safe (sessionId is a
    // randomUUID, subagentId is regex-sanitized), but basename() is zero-cost.
    const dir = join(getSessionsDir(), basename(sessionId), 'subagent-handoffs');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${basename(subagentId)}.txt`);
    writeFileSync(path, raw, 'utf8');
    return path;
  } catch {
    return undefined;
  }
}

export interface ResultCapOutcome {
  /** The (possibly capped) content to use in the ToolResult. */
  content: string;
  /** True when the content was truncated and a sidecar was written. */
  capped: boolean;
}

/**
 * Cap a foreground subagent's result content if it exceeds the configured
 * threshold. When capped, spills the full output to a sidecar file and
 * returns a head+tail slice with a pointer to the full text.
 *
 * Returns the content unchanged when:
 * - The cap is disabled (AFK_SUBAGENT_RESULT_CAP_BYTES=0)
 * - The content fits within the threshold
 *
 * When sessionId is unavailable the spill is skipped but the content is still
 * truncated to the cap (with a no-spill-pointer fallback message).
 */
export function capSubagentResult(
  content: string,
  sessionId: string | undefined,
  subagentId: string,
): ResultCapOutcome {
  const capBytes = resolveCapBytes();
  if (capBytes === undefined) {
    return { content, capped: false };
  }

  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength <= capBytes) {
    return { content, capped: false };
  }

  // Spill the full output before truncating (only when sessionId is known).
  const spillPath = sessionId !== undefined
    ? spillSubagentOutput(sessionId, subagentId, content)
    : undefined;

  // Build the pointer string FIRST so we can subtract its byte cost from the
  // slice budget, keeping headAndTail(…) + pointer within the total cap.
  const pointer = spillPath !== undefined
    ? `\n\n[Subagent output was ${byteLength} bytes — full result at ${spillPath}. Use read_file to retrieve it.]`
    : `\n\n[Subagent output was ${byteLength} bytes — truncated to ${capBytes} bytes. Full output could not be written to disk.]`;
  const pointerBytes = Buffer.byteLength(pointer, 'utf8');
  // Floor at 50% of cap so a very long pointer can never consume the entire budget.
  const sliceBudget = Math.max(capBytes - pointerBytes, Math.floor(capBytes * 0.5));

  const sliced = headAndTail(content, sliceBudget);

  return { content: sliced + pointer, capped: true };
}
