/**
 * ACP permission policy table (profile section 6). Security classification by
 * REAL tool name only; never by a client-supplied kind or a display title.
 *
 * @module cli/commands/acp.permission.policy
 */
import type { JsonValue, PermissionOption, ToolCallStart, ToolKind } from './acp.wire.js';
import { toolKind, toolLocations, toolTitle } from './acp.tool-kind.js';

/** Known read/search tools auto-allowed with approvals on (profile section 5/6 tables). */
const AUTO_ALLOW = new Set<string>([
  'read_file', 'view_image', 'extract_document', 'json_query', 'list_directory',
  'grep', 'glob', 'memory_search', 'search_witness', 'workspace_query', 'state_query',
  'config_get', 'get_runtime_state', 'get_facet', 'read_witness', 'read_journal', 'git_read',
  'state_get', 'artifact_get', 'artifact_list', 'artifact_read', 'get_background_job_health',
  'list_sessions', 'list_schedules', 'get_schedule_history',
]);
const DELEGATION = new Set<string>(['agent', 'skill', 'compose', 'remote_agent']);
export const DELEGATION_SUFFIX = ' (subagent will act without further prompts)';
const VALID_KINDS = new Set<ToolKind>(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']);

/** True when the call must be asked. Unknown, missing and MCP names always ask. */
export function requiresAsk(toolName: string, input: Record<string, unknown>): boolean {
  if (typeof toolName !== 'string' || toolName.length === 0) return true;
  if (AUTO_ALLOW.has(toolName)) return false;
  // Explicit read-only exception: exactly action "list", nothing else.
  if (toolName === 'worktree' && input['action'] === 'list') return false;
  return true;
}

/** Options in profile order; allow_always is never offered for bash or a missing name. */
export function permissionOptions(toolName: string): PermissionOption[] {
  const options: PermissionOption[] = [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }];
  if (toolName.length > 0 && toolName !== 'bash') {
    options.push({ optionId: 'allow_always', name: `Always allow ${toolName} in this session`, kind: 'allow_always' });
  }
  options.push({ optionId: 'reject_once', name: 'Reject', kind: 'reject_once' });
  return options;
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

/** Raw input above this many UTF-8 bytes is omitted so frames fit the 1 MiB line cap (profile section 5). */
export const MAX_RAW_INPUT_BYTES = 256 * 1024;

/** JSON-clean copy of the input, or undefined when it cannot be serialized or is oversize. */
function rawInputOf(input: Record<string, unknown>): JsonValue | undefined {
  return safe(() => {
    const text = JSON.stringify(input);
    if (text === undefined || Buffer.byteLength(text, 'utf8') > MAX_RAW_INPUT_BYTES) return undefined;
    return JSON.parse(text) as JsonValue;
  }, undefined);
}

/**
 * Display start for a call. Display helpers are A2's; any failure falls back to
 * the safe generic shape. The delegation suffix is enforced here regardless.
 */
export function buildPendingStart(toolCallId: string, toolName: string, input: Record<string, unknown>): ToolCallStart {
  const named = toolName.length > 0;
  let title = named ? safe(() => toolTitle(toolName, input), toolName) : 'Tool call';
  if (typeof title !== 'string' || title.length === 0) title = named ? toolName : 'Tool call';
  if (DELEGATION.has(toolName) && !title.endsWith(DELEGATION_SUFFIX)) title += DELEGATION_SUFFIX;
  const kind = named ? safe(() => toolKind(toolName), 'other' as ToolKind) : 'other';
  // No session cwd is available here: relative paths resolve to nothing and are omitted.
  const locations = named ? safe(() => toolLocations(toolName, input, ''), []) : [];
  const rawInput = rawInputOf(input);
  return {
    sessionUpdate: 'tool_call',
    toolCallId,
    title,
    ...(named ? { name: toolName } : {}),
    kind: VALID_KINDS.has(kind) ? kind : 'other',
    status: 'pending',
    ...(rawInput !== undefined ? { rawInput } : {}),
    content: [],
    locations: Array.isArray(locations) ? locations : [],
  };
}
