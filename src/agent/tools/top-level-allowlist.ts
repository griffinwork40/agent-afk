import { BUILTIN_TOOL_NAMES } from './schemas.js';
import { MEMORY_TOOL_NAMES } from '../memory/index.js';
import { AWARENESS_TOOL_NAMES } from '../awareness/index.js';
import { EXIT_PLAN_MODE_TOOL_NAME } from './handlers/exit-plan-mode.js';

/**
 * Contract: the canonical tool allowlist for a top-level, human-facing surface
 * (REPL, one-shot `chat`, Telegram) that always wires the full executor set.
 *
 * These surfaces construct their own `AnthropicDirectProvider` (to tag the
 * correct `surface`) instead of routing through `parseProvider`, so each one
 * previously re-spelled this list inline. The instant one copy dropped an
 * always-registered tool name — `get_runtime_state` (awareness) or
 * `exit_plan_mode` — the dispatcher's permission gate rejected that tool with
 * "not in the configured allowlist" even though the model could see and call
 * it. `exit_plan_mode` is registered only while in plan mode, but the allowlist
 * is static (snapshotted at construction), so its name must be present here; it
 * is harmless on surfaces that never enter plan mode (the dispatcher simply
 * never routes to it). `mcpToolWireNames` are unioned in because every
 * MCP-bridged tool must appear on the allowlist or it is rejected as unknown.
 *
 * Single source of truth: a new always-on tool is a one-line change here.
 */
export function topLevelSurfaceAllowedTools(mcpToolWireNames: readonly string[] = []): string[] {
  return [
    ...BUILTIN_TOOL_NAMES,
    ...MEMORY_TOOL_NAMES,
    ...AWARENESS_TOOL_NAMES,
    EXIT_PLAN_MODE_TOOL_NAME,
    'agent',
    'skill',
    'compose',
    ...mcpToolWireNames,
  ];
}
