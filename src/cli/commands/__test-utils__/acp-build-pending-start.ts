/**
 * Local test helper: constructs a pending ToolCallStart for acp.tool-title.*.test.ts
 * files. This was originally duplicated from the deleted acp.permission.policy.ts;
 * it now lives here as the canonical test-only implementation.
 * If production code ever needs the same logic, extract it to a shared module.
 */
import path from 'node:path';
import type { ToolCallStart, ToolKind } from '../acp.wire.js';
import { toolKind, toolLocations, toolTitle } from '../acp.tool-kind.js';
import { boundedRawInput, boundStartDisplay } from '../acp.translate.bounds.js';
import { escapeInvisible } from '../acp.tool-title.js';
import { outsidePaths } from '../acp.tool-display.js';
import { delegationSuffix } from '../acp.tool-display.js';
import type { JsonValue } from '../acp.wire.js';

const VALID_KINDS = new Set<ToolKind>([
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other',
]);

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

function rawInputOf(input: Record<string, unknown>): JsonValue | undefined {
  return safe(() => {
    const text = JSON.stringify(input);
    return text === undefined ? undefined : boundedRawInput(JSON.parse(text) as JsonValue);
  }, undefined);
}

function outsideTargets(toolName: string, input: Record<string, unknown>, cwd: string | undefined, callerCwd?: string): string[] {
  try { return outsidePaths(toolName, input, cwd, callerCwd); } catch { return ['(unresolvable path)']; }
}

export function buildPendingStart(
  toolCallId: string, toolName: string, input: Record<string, unknown>, cwd = '', prefix = '', callerCwd?: string,
): ToolCallStart {
  const shownCwd = callerCwd ?? cwd;
  const named = toolName.length > 0;
  let title = named ? safe(() => toolTitle(toolName, input, shownCwd), toolName) : 'Tool call';
  if (typeof title !== 'string' || title.length === 0) title = named ? toolName : 'Tool call';
  const kind = named ? safe(() => toolKind(toolName), 'other' as ToolKind) : 'other';
  const shown = named ? safe(() => toolLocations(toolName, input, shownCwd), []) : [];
  const locations = Array.isArray(shown) ? [...shown] : [];
  const outside = outsideTargets(toolName, input, cwd, callerCwd);
  for (const p of outside) {
    if (path.isAbsolute(p) && !locations.some((l) => l.path === p)) locations.push({ path: p });
  }
  const suffix = delegationSuffix(toolName);
  if (suffix !== '' && title.endsWith(suffix)) title = title.slice(0, -suffix.length);
  if (outside.length > 0 && !outside.some((p) => title.includes(p))) title = `${title} ${outside[0]}`;
  const rawInput = rawInputOf(input);
  const start = boundStartDisplay({
    sessionUpdate: 'tool_call',
    toolCallId,
    title,
    ...(named ? { name: toolName } : {}),
    kind: VALID_KINDS.has(kind) ? kind : 'other',
    status: 'pending',
    ...(rawInput !== undefined ? { rawInput } : {}),
    content: [],
    locations,
  });
  if (suffix !== '' && !start.title.endsWith(suffix)) start.title += suffix;
  if (prefix !== '') start.title = `${escapeInvisible(prefix)} ${start.title}`;
  return start;
}
