import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { toolKind, toolLocations, toolTitle } from './acp.tool-kind.js';
import { checked } from './__test-utils__/acp-schema.js';
import type { ToolKind } from './acp.wire.js';

const groups: [ToolKind, string[]][] = [
  ['read', ['read_file', 'view_image', 'extract_document', 'json_query', 'list_directory', 'config_get', 'get_runtime_state', 'get_facet', 'read_witness', 'read_journal', 'git_read', 'state_get', 'artifact_get', 'artifact_list', 'artifact_read', 'get_background_job_health', 'list_sessions', 'list_schedules', 'get_schedule_history']],
  ['edit', ['write_file', 'edit_file', 'patch_apply']],
  ['search', ['grep', 'glob', 'memory_search', 'search_witness', 'workspace_query', 'state_query']],
  ['execute', ['bash', 'test_run']], ['fetch', ['web_scrape', 'web_request']],
  ['think', ['agent', 'skill', 'compose', 'remote_agent', 'model_complete']],
  ['switch_mode', ['exit_plan_mode']],
  ['other', ['code_symbols', 'worktree', 'browser_open', 'browser_observe', 'browser_act', 'browser_screenshot', 'browser_close', 'memory_update', 'procedure_write', 'workspace_publish', 'workspace_subscribe', 'state_put', 'state_cas', 'state_delete', 'config_set', 'terminal_font_size', 'create_schedule', 'update_schedule', 'cancel_schedule', 'cancel_background_job', 'send_message_to_agent', 'send_to_session', 'send_telegram', 'image_generate', 'image_edit', 'artifact_publish', 'wait_for', 'ask_question', 'clipboard_read', 'clipboard_write', 'mcp__fs__read_file', '', 'new_tool']],
];
const cwd = path.resolve('workspace');
describe('ACP tool display classification', () => {
  for (const [kind, names] of groups) {
    for (const name of names) it(`${name || '(missing)'} maps to ${kind}`, () => {
      expect(toolKind(name)).toBe(kind);
      checked([{ sessionUpdate: 'tool_call', toolCallId: 't', title: toolTitle(name), kind: toolKind(name), locations: toolLocations(name, {}, cwd) }]);
    });
  }
  it('uses path suffixes only for designated file tools', () => {
    for (const name of ['read_file', 'view_image', 'extract_document', 'write_file', 'edit_file']) {
      expect(toolTitle(name, { file_path: 'a.txt' })).toBe(`${name} a.txt`);
    }
    expect(toolTitle('json_query', { path: 'a.json' })).toBe('json_query a.json');
    expect(toolTitle('list_directory', { path: 'src' })).toBe('list_directory src');
    expect(toolTitle('grep', { path: 'src' })).toBe('grep');
    expect(toolTitle('read_file', { file_path: 5 })).toBe('read_file');
    expect(toolTitle('')).toBe('Tool call');
  });
  it('warns on delegation but not on model_complete', () => {
    for (const name of ['agent', 'skill', 'compose', 'remote_agent']) expect(toolTitle(name)).toBe(`${name} (subagent will act without further prompts)`);
    expect(toolTitle('model_complete')).toBe('model_complete');
  });
  it('resolves relative locations and accepts only positive safe integral offsets', () => {
    expect(toolLocations('read_file', { file_path: 'a.txt', offset: 2 }, cwd)).toEqual([{ path: path.join(cwd, 'a.txt'), line: 2 }]);
    for (const offset of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '2']) {
      expect(toolLocations('read_file', { file_path: 'a.txt', offset }, cwd)).toEqual([{ path: path.join(cwd, 'a.txt') }]);
    }
    for (const name of ['json_query', 'list_directory', 'grep', 'glob']) expect(toolLocations(name, { path: 'src' }, cwd)).toEqual([{ path: path.join(cwd, 'src') }]);
    expect(toolLocations('code_symbols', { file_path: 'a.ts' }, cwd)).toEqual([{ path: path.join(cwd, 'a.ts') }]);
  });
  it('keeps multi-file input order, omits invalid paths and never invents locations', () => {
    expect(toolLocations('patch_apply', { changes: [{ path: 'b' }, { path: '' }, { path: 'a' }, { path: 1 }] }, cwd)).toEqual([{ path: path.join(cwd, 'b') }, { path: path.join(cwd, 'a') }]);
    for (const input of [null, [], 'a', { file_path: '' }, { file_path: 'bad\u0000path' }]) expect(toolLocations('read_file', input, cwd)).toEqual([]);
    expect(toolLocations('bash', { file_path: 'a' }, cwd)).toEqual([]);
    expect(toolLocations('read_file', { file_path: 'a' }, 'relative')).toEqual([]);
  });
});
