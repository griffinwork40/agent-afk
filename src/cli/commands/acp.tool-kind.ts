import type { ToolCallLocation, ToolKind } from './acp.wire.js';
import { inputRecord, resolveDisplayPath, validPath } from './acp.translate.paths.js';
import { delegationSuffix, outsidePaths, sensitiveMarkers } from './acp.tool-display.js';
import path from 'node:path';
import { oneLine, toolDetail } from './acp.tool-title.js';

const readTools = new Set([
  'read_file', 'view_image', 'extract_document', 'json_query', 'list_directory',
  'config_get', 'get_runtime_state', 'get_facet', 'read_witness', 'read_journal',
  'git_read', 'state_get', 'artifact_get', 'artifact_list', 'artifact_read',
  'get_background_job_health', 'list_sessions', 'list_schedules', 'get_schedule_history',
]);
const searchTools = new Set(['grep', 'glob', 'memory_search', 'search_witness', 'workspace_query', 'state_query']);
const editTools = new Set(['write_file', 'edit_file', 'patch_apply']);
const thinkTools = new Set(['agent', 'skill', 'compose', 'remote_agent', 'model_complete']);
const filePathTools = new Set(['read_file', 'view_image', 'extract_document', 'write_file', 'edit_file']);
const pathTools = new Set(['json_query', 'list_directory', 'grep', 'glob']);

/** Display classification only. The permission policy must also inspect the name. */
export function toolKind(toolName: string): ToolKind {
  if (readTools.has(toolName)) return 'read';
  if (searchTools.has(toolName)) return 'search';
  if (editTools.has(toolName)) return 'edit';
  if (thinkTools.has(toolName)) return 'think';
  if (toolName === 'bash' || toolName === 'test_run') return 'execute';
  if (toolName === 'web_scrape' || toolName === 'web_request') return 'fetch';
  if (toolName === 'exit_plan_mode') return 'switch_mode';
  return 'other';
}

/**
 * Card title: the tool name, what the call does (bounded, one line; see
 * acp.tool-title), the delegation suffix, any outside-cwd target (D10) and a
 * sensitive-target marker. With a session `cwd`, relative paths are shown resolved.
 */
export function toolTitle(toolName: string, input?: unknown, cwd?: string): string {
  if (!toolName) return 'Tool call';
  const record = inputRecord(input);
  const suffix = filePathTools.has(toolName) ? record['file_path']
    : toolName === 'json_query' || toolName === 'list_directory' ? record['path'] : undefined;
  const shown = validPath(suffix) ? cwd !== undefined ? resolveDisplayPath(suffix, cwd) ?? suffix : suffix : undefined;
  const detail = shown !== undefined ? oneLine(shown) : toolDetail(toolName, record, cwd);
  let title = detail !== '' ? `${toolName} ${detail}` : toolName;
  // D10: a target outside the session directory is always visible, under any argument name.
  const outside = outsideDisplay(toolName, record, cwd);
  if (outside.length > 0 && !outside.some((p) => title.includes(p))) title = `${title} ${outside[0]}`;
  const markers = sensitiveMarkers(toolName, record, cwd !== undefined && path.isAbsolute(cwd) ? cwd : undefined);
  if (markers.length > 0) title = `${title} ${markers.join(' ')}`;
  return `${title}${delegationSuffix(toolName)}`;
}

/** Absolute outside-cwd targets for display; empty without an absolute session cwd. */
function outsideDisplay(toolName: string, record: Record<string, unknown>, cwd: string | undefined): string[] {
  if (cwd === undefined || !validPath(cwd) || !path.isAbsolute(cwd)) return [];
  try { return outsidePaths(toolName, record, cwd).filter((p) => path.isAbsolute(p)); } catch { return []; }
}

export function toolLocations(toolName: string, input: unknown, cwd: string): ToolCallLocation[] {
  const record = inputRecord(input);
  if (toolName === 'patch_apply') {
    const changes = record['changes'];
    if (!Array.isArray(changes)) return [];
    return changes.flatMap((change: unknown) => {
      const resolved = resolveDisplayPath(inputRecord(change)['path'], cwd);
      return resolved === undefined ? [] : [{ path: resolved }];
    });
  }
  const value = filePathTools.has(toolName) || toolName === 'code_symbols' ? record['file_path']
    : pathTools.has(toolName) ? record['path'] : undefined;
  const resolved = resolveDisplayPath(value, cwd);
  const offset = record['offset'];
  const line = filePathTools.has(toolName) && typeof offset === 'number' && Number.isSafeInteger(offset) && offset > 0
    ? offset : undefined;
  const shown: ToolCallLocation[] = resolved === undefined ? [] : [{ path: resolved, ...(line !== undefined ? { line } : {}) }];
  for (const p of outsideDisplay(toolName, record, cwd)) if (!shown.some((l) => l.path === p)) shown.push({ path: p });
  return shown;
}
