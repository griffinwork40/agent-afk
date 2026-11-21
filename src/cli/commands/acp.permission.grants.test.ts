import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AcpClientPeer, ToolCallStart } from './acp.wire.js';
import { createAcpPermissionGate } from './acp.permission.js';
import { GRANTABLE_TOOLS, grantFits } from './acp.permission.grants.js';
import { permissionOptions, requiresAsk } from './acp.permission.policy.js';
import { builtinToolSchemas } from '../../agent/tools/schemas.js';

const CWD = path.resolve('/workspace/proj');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function setup() {
  const asks: { params: { options: { optionId: string }[] }; resolve(v: unknown): void }[] = [];
  const peer: AcpClientPeer = {
    request: (_m, params) => new Promise((resolve) => { asks.push({ params: params as never, resolve }); }),
    notify: () => Promise.resolve(),
  };
  const gate = createAcpPermissionGate(peer, 'sid', {
    skip: false, cwd: CWD, onCancelled: vi.fn(), emitToolCall: vi.fn(async (_u: ToolCallStart) => {}),
  });
  return { gate, asks };
}
const opts = (id: string) => ({ signal: new AbortController().signal, toolUseID: id });

// Contract: every argument of an auto-allowed tool must be either scanned as a
// location or known not to be one. A schema that grows a new argument fails
// here, so a new path argument cannot be silently auto-allowed.
const NOT_LOCATIONS: Record<string, readonly string[]> = {
  read_file: ['offset', 'limit'], view_image: [], extract_document: [],
  json_query: ['query', 'max_results', 'max_bytes'], list_directory: [],
  grep: ['pattern', 'include'], glob: ['pattern'], git_read: ['subcommand', 'args', 'pattern', 'max_bytes'],
  config_get: ['target', 'key', 'all'], get_runtime_state: ['view'], get_facet: ['session', 'fields'],
  read_witness: ['session', 'kinds', 'where', 'tool_name', 'errors_only', 'limit'],
  search_witness: ['query', 'sessions', 'kinds', 'since', 'tool_name', 'where', 'include_current_session'],
  read_journal: ['session', 'tool_use_id', 'kinds', 'limit'], artifact_get: ['id'],
  artifact_list: ['session_id', 'subagent_id', 'tool_name', 'media_type', 'since', 'until', 'limit'],
  artifact_read: ['id', 'offset', 'limit'], get_background_job_health: ['jobId'], list_sessions: [],
  list_schedules: ['name', 'enabled'], get_schedule_history: ['taskId', 'limit'],
};
const SCANNED = ['file_path', 'path', 'paths'];

describe('auto-allowed tool arguments', () => {
  it('every argument of every auto-allowed built-in tool is classified', () => {
    for (const [name, known] of Object.entries(NOT_LOCATIONS)) {
      const schema = builtinToolSchemas.find((t) => t.name === name);
      if (schema === undefined) continue;
      const keys = Object.keys((schema.input_schema as { properties?: Record<string, unknown> }).properties ?? {});
      for (const k of keys) expect([...SCANNED, ...known], `${name}.${k}`).toContain(k);
    }
  });
});

describe('D18 grant list', () => {
  it('is exactly the file-editing tools', () => {
    expect([...GRANTABLE_TOOLS]).toEqual(['write_file', 'edit_file', 'patch_apply']);
  });

  it('every listed entry covers exactly the arguments of the real schema', () => {
    for (const name of GRANTABLE_TOOLS) {
      const schema = builtinToolSchemas.find((t) => t.name === name);
      expect(schema, name).toBeDefined();
      const keys = Object.keys((schema!.input_schema as { properties: Record<string, unknown> }).properties);
      const all = Object.fromEntries(keys.map((k) => [k, name === 'patch_apply' && k === 'changes' ? [{ path: 'a' }] : k === 'file_path' ? 'a' : 'x']));
      expect(grantFits(name, all, CWD), name).toBe(true);
      expect(grantFits(name, { ...all, surprise: 1 }, CWD), `${name} unknown key`).toBe(false);
    }
  });

  it('fails closed on outside, unresolvable or unknown-shaped locations', () => {
    expect(grantFits('write_file', { file_path: 'a.txt', content: '' }, CWD)).toBe(true);
    for (const v of ['../x', '/etc/passwd', '~/x', 'a\u0000b', '', 3, null]) {
      expect(grantFits('write_file', { file_path: v, content: '' }, CWD), String(v)).toBe(false);
    }
    expect(grantFits('patch_apply', { changes: [{ path: 'a' }, { path: '../b' }] }, CWD)).toBe(false);
    expect(grantFits('patch_apply', { changes: [{ path: 'a', target: '/etc/x' }] }, CWD)).toBe(false);
    expect(grantFits('patch_apply', { changes: 'a' }, CWD)).toBe(false);
    expect(grantFits('write_file', { file_path: 'a' }, undefined)).toBe(false);
    expect(grantFits('write_file', { file_path: 'a' }, 'relative')).toBe(false);
    expect(grantFits('write_file', { file_path: 'a' }, CWD, 'relative/child')).toBe(false);
    expect(grantFits('write_file', { file_path: 'a' }, CWD, path.resolve('/elsewhere'))).toBe(false);
  });

  it('no other tool can be offered, or obtain, a remembered grant', async () => {
    const names = [...new Set([...builtinToolSchemas.map((t) => t.name),
      'agent', 'skill', 'compose', 'remote_agent', 'code_symbols', 'memory_update', 'mcp__srv__write_file', 'bash',
      'procedure_write', 'workspace_publish', 'workspace_subscribe', 'state_put', 'state_cas', 'state_delete',
      'exit_plan_mode', 'emit_progress', 'lsp_rename', 'brand_new_tool'])];
    for (const name of names.filter((n) => !GRANTABLE_TOOLS.includes(n))) {
      expect(permissionOptions(name).map((o) => o.optionId), name).not.toContain('allow_always');
      // Tools that are always auto-allowed inside never reach a grant decision.
      if (!requiresAsk(name, {}, CWD)) continue;
      const { gate, asks } = setup();
      const first = gate.canUseTool(name, {}, opts('a'));
      await flush();
      expect(asks.length, name).toBe(1);
      asks[0]!.resolve({ outcome: { outcome: 'selected', optionId: 'allow_always' } });
      expect(await first, name).toMatchObject({ behavior: 'deny', message: 'Permission denied: unknown_option' });
      expect(gate.wouldAsk!(name, {}), name).toBe(true);
    }
  });

  it('a granted tool called with an unknown argument is asked again and not offered always', async () => {
    const { gate, asks } = setup();
    const first = gate.canUseTool('write_file', { file_path: 'a.txt', content: '' }, opts('a'));
    await flush();
    asks[0]!.resolve({ outcome: { outcome: 'selected', optionId: 'allow_always' } });
    expect(await first).toEqual({ behavior: 'allow' });
    expect(await gate.canUseTool('write_file', { file_path: 'b.txt', content: '' }, opts('b'))).toEqual({ behavior: 'allow' });
    const odd = gate.canUseTool('write_file', { file_path: 'b.txt', content: '', mode: 'append' }, opts('c'));
    await flush();
    expect(asks.length).toBe(2);
    expect(asks[1]!.params.options.map((o) => o.optionId)).toEqual(['allow_once', 'reject_once']);
    asks[1]!.resolve({ outcome: { outcome: 'selected', optionId: 'reject_once' } });
    expect((await odd).behavior).toBe('deny');
  });
});
