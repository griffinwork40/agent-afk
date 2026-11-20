/**
 * ACP permission policy table (profile section 6). Security classification by
 * REAL tool name only; never by a client-supplied kind or a display title.
 *
 * @module cli/commands/acp.permission.policy
 */
import path from 'node:path';
import type { JsonValue, PermissionOption, ToolCallStart, ToolKind } from './acp.wire.js';
import { toolKind, toolLocations, toolTitle } from './acp.tool-kind.js';
import { boundedRawInput, boundStartDisplay } from './acp.translate.bounds.js';
import { escapeInvisible } from './acp.tool-title.js';
import { outsidePaths } from './acp.permission.paths.js';
import { delegationSuffix } from './acp.permission.labels.js';
import { isGrantable } from './acp.permission.grants.js';

/** Known read/search tools auto-allowed with approvals on (profile section 5/6 tables). */
const AUTO_ALLOW = new Set<string>([
  'read_file', 'view_image', 'extract_document', 'json_query', 'list_directory',
  'grep', 'glob', 'memory_search', 'search_witness', 'workspace_query', 'state_query',
  'config_get', 'get_runtime_state', 'get_facet', 'read_witness', 'read_journal', 'git_read',
  'state_get', 'artifact_get', 'artifact_list', 'artifact_read', 'get_background_job_health',
  'list_sessions', 'list_schedules', 'get_schedule_history',
]);
export const DELEGATION = new Set<string>(['agent', 'skill', 'compose', 'remote_agent']);
export { DELEGATION_SUFFIX, REMOTE_SUFFIX } from './acp.permission.labels.js';
const VALID_KINDS = new Set<ToolKind>(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']);

/**
 * Targets of this call outside the session cwd (D10). Any failure is reported
 * as an unresolvable outside target, so the call is asked, never auto-allowed.
 */
export function outsideTargets(
  toolName: string, input: Record<string, unknown>, cwd: string | undefined, callerCwd?: string,
): string[] {
  try { return outsidePaths(toolName, input, cwd, callerCwd); } catch { return ['(unresolvable path)']; }
}

/**
 * True when the call must be asked. Unknown, missing and MCP names always ask;
 * an auto-allowed read/search tool asks when any target leaves `cwd` (D10).
 * Without a usable `cwd` every path argument counts as outside (fail closed).
 */
export function requiresAsk(toolName: string, input: Record<string, unknown>, cwd?: string, callerCwd?: string): boolean {
  if (typeof toolName !== 'string' || toolName.length === 0) return true;
  const readOnly = AUTO_ALLOW.has(toolName)
    // Explicit read-only exception: exactly action "list", nothing else.
    || (toolName === 'worktree' && input['action'] === 'list' && Object.keys(input).every((k) => k === 'action'));
  if (!readOnly) return true;
  return outsideTargets(toolName, input, cwd, callerCwd).length > 0;
}

/**
 * Options in profile order. allow_always is offered only for a tool on the
 * grant list (D18), and never for a call that targets a path outside the cwd
 * or is otherwise not covered by that list entry (D11; the caller passes true).
 */
export function permissionOptions(toolName: string, outside = false): PermissionOption[] {
  const options: PermissionOption[] = [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }];
  if (isGrantable(toolName) && toolName !== 'bash' && !DELEGATION.has(toolName) && !outside) {
    options.push({ optionId: 'allow_always', name: `Always allow ${toolName} in this session`, kind: 'allow_always' });
  }
  options.push({ optionId: 'reject_once', name: 'Reject', kind: 'reject_once' });
  return options;
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

/** JSON-clean copy of the input under the translator's raw-input budget, or undefined. */
function rawInputOf(input: Record<string, unknown>): JsonValue | undefined {
  return safe(() => {
    const text = JSON.stringify(input);
    return text === undefined ? undefined : boundedRawInput(JSON.parse(text) as JsonValue);
  }, undefined);
}

/**
 * Display start for a call. Display helpers are A2's; any failure falls back to
 * the safe generic shape. The delegation suffix is enforced here regardless.
 */
export function buildPendingStart(
  toolCallId: string, toolName: string, input: Record<string, unknown>, cwd = '', prefix = '', callerCwd?: string,
): ToolCallStart {
  const shownCwd = callerCwd ?? cwd;
  const named = toolName.length > 0;
  let title = named ? safe(() => toolTitle(toolName, input, shownCwd), toolName) : 'Tool call';
  if (typeof title !== 'string' || title.length === 0) title = named ? toolName : 'Tool call';
  const kind = named ? safe(() => toolKind(toolName), 'other' as ToolKind) : 'other';
  // Without a session cwd, relative paths resolve to nothing and are omitted.
  const shown = named ? safe(() => toolLocations(toolName, input, shownCwd), []) : [];
  const locations = Array.isArray(shown) ? [...shown] : [];
  // D10: every outside target is shown as an absolute location, even under names the display table ignores.
  const outside = outsideTargets(toolName, input, cwd, callerCwd);
  for (const p of outside) {
    if (path.isAbsolute(p) && !locations.some((l) => l.path === p)) locations.push({ path: p });
  }
  const suffix = delegationSuffix(toolName);
  if (suffix !== '' && title.endsWith(suffix)) title = title.slice(0, -suffix.length);
  if (outside.length > 0 && !outside.some((p) => title.includes(p))) title = `${title} ${outside[0]}`;
  const rawInput = rawInputOf(input);
  // Same display bounds as a stream start (acp.translate), then the suffix is enforced regardless.
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
  // Escape the prefix AFTER boundStartDisplay: the prefix may carry model-
  // supplied text (e.g. id_prefix from an agent call) that was not seen by the
  // inner escape pass.  boundStartDisplay is idempotent, so the outer choke
  // point in boundStartDisplay already covers the title body; this call covers
  // the appended prefix only.
  if (prefix !== '') start.title = `${escapeInvisible(prefix)} ${start.title}`;
  return start;
}
