/**
 * Per-tool result display formatters.
 *
 * Tools whose handler returns single-line JSON (memory tools, future
 * structured-result tools) register a formatter here so the interactive
 * tool-lane renderer can show a short human-readable line instead of
 * slicing the raw JSON. Consulted from
 * `src/agent/session/stream-consumer.ts:buildToolOutputEvent` UPSTREAM of
 * `truncateContent`, so formatters receive un-truncated content and
 * their output bypasses the 80-char truncation cap.
 *
 * Layering rationale: the renderer (`formatOutcome`) should not know
 * tool-specific JSON shapes. The handler should not know that a renderer
 * exists. The registry is the single place those concerns meet: tool
 * authors colocate the formatter near the handler; renderers consume
 * `chunk.display` as opaque text. Stays out of the cross-provider wire
 * contract (`ProviderEvent`) — the only renderer-affecting field added
 * to that contract is `toolName?`, which is generally useful (hooks,
 * metrics, logging).
 *
 * @module agent/tools/render-registry
 */

import {
  formatMemorySearchDisplay,
  formatMemoryUpdateDisplay,
  formatProcedureWriteDisplay,
} from '../memory/memory-tool-renderers.js';
import { formatBashDisplay } from './renderers/bash-renderer.js';
import { sanitizeForDisplay } from '../../utils/terminal-sanitize.js';

/**
 * Formatter contract: pure function from a handler's raw `content` string
 * to a short display line, or `null` for "no recognized shape — fall
 * through to the existing preview path." Must not throw; runtime
 * `renderToolResult` swallows exceptions defensively, but a clean
 * formatter returns `null` for unhandled cases instead of relying on
 * exception catching.
 */
export type ToolRenderFormatter = (rawContent: string) => string | null;

/**
 * Tool-name → formatter registry. Static for now; flip to a mutable Map
 * + `registerToolRenderer()` if multiple registration sources appear
 * (e.g. user-installed plugins contributing their own formatters).
 */
export const toolRenderers: ReadonlyMap<string, ToolRenderFormatter> =
  new Map<string, ToolRenderFormatter>([
    ['memory_search', formatMemorySearchDisplay],
    ['memory_update', formatMemoryUpdateDisplay],
    ['procedure_write', formatProcedureWriteDisplay],
    // `bash` returns plain text most of the time — the formatter fails open
    // (returns null) for non-JSON output and the existing `lineCount` /
    // preview path renders it. Only single-line JSON output (e.g. `gh pr
    // view --json`) triggers the structured summary.
    ['bash', formatBashDisplay],
    ['Bash', formatBashDisplay],
  ]);

/**
 * Look up and apply the registered formatter for a tool. Fails open:
 * unknown tool → `null`, formatter returns `null` → `null`, formatter
 * throws → `null`. Caller falls through to the existing preview path on
 * `null`. Sanitizes the result via the shared `sanitizeForDisplay`
 * (src/utils/terminal-sanitize.ts) before returning so renderer-side string
 * interpolation cannot smuggle terminal control sequences through.
 */
export function renderToolResult(
  toolName: string | undefined,
  rawContent: string,
): string | null {
  if (!toolName) return null;
  const formatter = toolRenderers.get(toolName);
  if (!formatter) return null;
  try {
    const out = formatter(rawContent);
    if (out === null) return null;
    const cleaned = sanitizeForDisplay(out);
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}
