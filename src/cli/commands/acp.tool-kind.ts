import type { ToolCallLocation, ToolKind } from './acp.wire.js';
import { inputRecord, resolveDisplayPath, validPath } from './acp.translate.paths.js';

const readTools = new Set([
  'read_file', 'view_image', 'extract_document', 'json_query', 'list_directory',
  'config_get', 'get_runtime_state', 'get_facet', 'read_witness', 'read_journal',
  'git_read', 'state_get', 'artifact_get', 'artifact_list', 'artifact_read',
  'get_background_job_health', 'list_sessions', 'list_schedules', 'get_schedule_history',
]);
const searchTools = new Set(['grep', 'glob', 'memory_search', 'search_witness', 'workspace_query', 'state_query']);
const editTools = new Set(['write_file', 'edit_file', 'patch_apply']);
const thinkTools = new Set(['agent', 'skill', 'compose', 'remote_agent', 'model_complete']);
const delegationTools = new Set(['agent', 'skill', 'compose', 'remote_agent']);
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

export function toolTitle(toolName: string, input?: unknown): string {
  if (!toolName) return 'Tool call';
  if (delegationTools.has(toolName)) return `${toolName} (subagent will act without further prompts)`;
  const record = inputRecord(input);
  const suffix = filePathTools.has(toolName) ? record['file_path']
    : toolName === 'json_query' || toolName === 'list_directory' ? record['path'] : undefined;
  return validPath(suffix) ? `${toolName} ${suffix}` : toolName;
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
  if (resolved === undefined) return [];
  const offset = record['offset'];
  const line = filePathTools.has(toolName) && typeof offset === 'number' && Number.isSafeInteger(offset) && offset > 0
    ? offset : undefined;
  return [{ path: resolved, ...(line !== undefined ? { line } : {}) }];
}
