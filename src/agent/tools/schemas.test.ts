import { describe, expect, it } from 'vitest';
import {
  builtinToolSchemas,
  BUILTIN_TOOL_NAMES,
  agentTool,
  composeTool,
  skillTool,
} from './schemas.js';
import { INVARIANT_CORE_COUNT, sortMcpSchemas } from './schemas.order.js';
import { LOCKED_TOOLS, toolGroups } from './operator-denied.js';
import { CHILD_ALLOWED_TOOLS, COMPOSE_LEAF_STRIPPED_TOOLS } from './nesting.js';
import { clipboardWriteTool, clipboardReadTool } from './schemas.interaction-tools.js';
import { sendToSessionTool } from './schemas.peer.js';
import { createScheduleTool, updateScheduleTool } from './schemas.schedule.js';
import { TASK_MAX_ATTEMPTS_LIMIT, TASK_RETRY_DELAY_MAX_MS, TASK_RETRY_DELAY_MIN_MS } from '../daemon/task-retry.js';
import { cancelBackgroundJobTool, sendMessageToAgentTool, getBackgroundJobHealthTool } from './schemas.orchestration.js';
import { filterBackgroundToolDefs } from './process-job-tools.js';
import type { AnthropicToolDef } from './types.js';

describe('builtinToolSchemas', () => {
  it('contains exactly 45 tools', () => {
    // 23 invariant core + 22 optional tail = 45
    expect(builtinToolSchemas).toHaveLength(45);
  });

  it('exports the expected tool names', () => {
    // ORDERING INVARIANT (#4198): invariant core tools occupy indices 0..22;
    // optional/disableable/surface-filtered/registry-filtered tools occupy
    // indices 23..44. Changing this order breaks prefix-cache reuse across
    // tool-config variants. Indices 0..5 are the LOCKED_TOOLS builtins (never
    // operator-disableable).
    //
    // #4208: cancel_background_job / send_message_to_agent /
    // get_background_job_health moved from core (was 0..25) to optional tail
    // because filterBackgroundToolDefs (process-job-tools.ts) removes them
    // when no background registry is wired — they cannot be invariant.
    expect(BUILTIN_TOOL_NAMES).toEqual([
      // -- Invariant core (0..22) --
      // 0..5: LOCKED_TOOLS builtins
      'read_file',
      'write_file',
      'edit_file',
      'grep',
      'glob',
      'list_directory',
      // 6..22: remaining core (individually disableable, never registry-filtered)
      'bash',
      'view_image',
      'extract_document',
      'wait_for',
      'patch_apply',
      'test_run',
      'get_facet',
      'json_query',
      'model_complete',
      'worktree',
      'config_get',
      'config_set',
      'read_witness',
      'search_witness',
      'remote_agent',
      'web_scrape',
      'web_request',
      // -- Optional tail (23..44) --
      // registry-filtered: absent when no background registry is wired
      'cancel_background_job',
      'send_message_to_agent',
      'get_background_job_health',
      'send_telegram',
      'image_generate',
      'image_edit',
      'create_schedule',
      'update_schedule',
      'list_schedules',
      'get_schedule_history',
      'cancel_schedule',
      'browser_open',
      'browser_observe',
      'browser_act',
      'browser_screenshot',
      'browser_close',
      'clipboard_write',
      'clipboard_read',
      'list_sessions',
      'send_to_session',
      'terminal_font_size',
      'ask_question',
    ]);
  });

  it('INVARIANT_CORE_COUNT matches the actual boundary in builtinToolSchemas', () => {
    // Derive the optional set from live group definitions plus surface-filtered
    // singles and send_telegram (tail by convention). toolGroups() is called
    // inside the test body to avoid import-cycle evaluation at module load time.
    const groups = toolGroups();
    // surface-filtered: dropped on some surfaces (e.g. non-interactive, telegram)
    // registry-filtered: removed by filterBackgroundToolDefs when no background
    //   registry is wired (process-job-tools.ts — see #4208)
    const surfaceFiltered = ['ask_question', 'terminal_font_size', 'clipboard_read', 'clipboard_write'];
    const registryFiltered = ['cancel_background_job', 'send_message_to_agent', 'get_background_job_health'];
    const optionalTools = new Set([
      ...Object.values(groups).flat(),
      ...surfaceFiltered,
      ...registryFiltered,
      'send_telegram',
    ]);
    // Every tool at index < INVARIANT_CORE_COUNT must not be optional.
    for (let i = 0; i < INVARIANT_CORE_COUNT; i++) {
      const name = builtinToolSchemas[i]!.name;
      expect(optionalTools.has(name), `Expected invariant core at index ${i} but found optional tool "${name}"`).toBe(false);
    }
    // Every tool at index >= INVARIANT_CORE_COUNT must be optional.
    for (let i = INVARIANT_CORE_COUNT; i < builtinToolSchemas.length; i++) {
      const name = builtinToolSchemas[i]!.name;
      expect(optionalTools.has(name), `Expected optional tail at index ${i} but found non-optional tool "${name}"`).toBe(true);
    }
  });

  it('first K entries are exactly the LOCKED_TOOLS builtins that appear in builtinToolSchemas', () => {
    // toolGroups() is called here (not at module scope) to avoid import-cycle
    // issues during evaluation. LOCKED_TOOLS includes agent/skill/compose/
    // exit_plan_mode/get_runtime_state which are NOT in builtinToolSchemas, so
    // we intersect with the actual schema names.
    const builtinNames = new Set(builtinToolSchemas.map((t) => t.name));
    const lockedBuiltins = [...LOCKED_TOOLS].filter((n) => builtinNames.has(n));
    const K = lockedBuiltins.length;
    // The first K entries must all be in LOCKED_TOOLS.
    for (let i = 0; i < K; i++) {
      const name = builtinToolSchemas[i]!.name;
      expect(LOCKED_TOOLS.has(name), `Index ${i} ("${name}") is not a LOCKED_TOOLS builtin`).toBe(true);
    }
    // Every LOCKED_TOOLS builtin in builtinToolSchemas must appear in indices 0..K-1.
    const headNames = new Set(builtinToolSchemas.slice(0, K).map((t) => t.name));
    for (const name of lockedBuiltins) {
      expect(headNames.has(name), `LOCKED_TOOLS builtin "${name}" is not in the first ${K} entries`).toBe(true);
    }
  });


  it('every schema has required fields', () => {
    for (const tool of builtinToolSchemas) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe('object');
    }
  });

  it('every schema declares a required array (possibly empty)', () => {
    // Tools with NO universally-required fields:
    //   `web_scrape`        — validity depends on chosen `mode`; the handler
    //                         enforces conditional requirements at call time.
    //   `list_schedules`    — no inputs at all.
    //   `browser_observe`   — all 3 fields are optional knobs.
    //   `browser_screenshot`— `target` and `full_page` are both optional.
    //   `browser_close`     — no inputs at all.
    //   `test_run`          — all 4 fields (file, name, timeout_ms, coverage)
    //                         are optional; required is [].
    //   `model_complete`    — `prompt` is optional when `input_path` is set;
    //                         handler enforces the conditional requirement.
    // All other built-ins have non-empty required arrays.
    const noRequired = new Set([
      'web_scrape',
      'list_schedules',
      'read_witness',
      'browser_observe',
      'browser_screenshot',
      'browser_close',
      'test_run',
      'get_facet',
      'clipboard_read',
      'list_sessions',
      'model_complete',
    ]);
    for (const tool of builtinToolSchemas) {
      expect(tool.input_schema.required).toBeDefined();
      if (noRequired.has(tool.name)) {
        expect(tool.input_schema.required!.length).toBe(0);
      } else {
        expect(tool.input_schema.required!.length).toBeGreaterThan(0);
      }
    }
  });

  it('bash tool has correct params', () => {
    const bash = builtinToolSchemas.find((t) => t.name === 'bash')!;
    expect(bash.input_schema.required).toEqual(['command']);
    expect(bash.input_schema.properties).toHaveProperty('command');
    expect(bash.input_schema.properties).toHaveProperty('timeout_ms');
  });

  it('read_file tool has correct params', () => {
    const read = builtinToolSchemas.find((t) => t.name === 'read_file')!;
    expect(read.input_schema.required).toEqual(['file_path']);
    expect(read.input_schema.properties).toHaveProperty('file_path');
    expect(read.input_schema.properties).toHaveProperty('offset');
    expect(read.input_schema.properties).toHaveProperty('limit');
  });

  it('view_image tool has correct params', () => {
    const tool = builtinToolSchemas.find((t) => t.name === 'view_image')!;
    expect(tool).toBeDefined();
    expect(tool.input_schema.required).toEqual(['file_path']);
    expect(tool.input_schema.properties).toHaveProperty('file_path');
    expect(tool.category).toBe('read');
    expect(tool.concurrencySafe).toBe(true);
  });

  it('write_file tool has correct params', () => {
    const write = builtinToolSchemas.find((t) => t.name === 'write_file')!;
    expect(write.input_schema.required).toEqual(['file_path', 'content']);
  });

  it('edit_file tool has correct params', () => {
    const edit = builtinToolSchemas.find((t) => t.name === 'edit_file')!;
    expect(edit.input_schema.required).toEqual(['file_path', 'old_string', 'new_string']);
    expect(edit.input_schema.properties).toHaveProperty('replace_all');
  });

  it('glob tool has correct params', () => {
    const glob = builtinToolSchemas.find((t) => t.name === 'glob')!;
    expect(glob.input_schema.required).toEqual(['pattern']);
    expect(glob.input_schema.properties).toHaveProperty('path');
  });

  it('grep tool has correct params', () => {
    const grep = builtinToolSchemas.find((t) => t.name === 'grep')!;
    expect(grep.input_schema.required).toEqual(['pattern']);
    expect(grep.input_schema.properties).toHaveProperty('path');
    expect(grep.input_schema.properties).toHaveProperty('include');
  });

  it('list_directory tool has correct params', () => {
    const listDir = builtinToolSchemas.find((t) => t.name === 'list_directory')!;
    expect(listDir.input_schema.required).toEqual(['path']);
  });

  it('all tool names are unique', () => {
    const names = new Set(BUILTIN_TOOL_NAMES);
    expect(names.size).toBe(BUILTIN_TOOL_NAMES.length);
  });
});

describe('cancelBackgroundJobTool', () => {
  it('requires both jobId and reason and documents the provenance boundary', () => {
    expect(cancelBackgroundJobTool.input_schema.required).toEqual(['jobId', 'reason']);
    expect(cancelBackgroundJobTool.description).toMatch(/Ctrl\+B/);
    expect(cancelBackgroundJobTool.description).toMatch(/\/bgsub:cancel/);
  });
});

describe('clipboard tool schemas', () => {
  it('clipboard_write has category "write" so plan-mode gate blocks it', () => {
    expect(clipboardWriteTool.category).toBe('write');
  });

  it('clipboard_read has category "other"', () => {
    expect(clipboardReadTool.category).toBe('other');
  });
});

describe('agentTool', () => {
  it('has name "agent"', () => {
    expect(agentTool.name).toBe('agent');
  });

  it('requires prompt parameter', () => {
    expect(agentTool.input_schema.required).toEqual(['prompt']);
  });

  it('has optional model, max_turns, max_tool_use_iterations, and id_prefix parameters', () => {
    expect(agentTool.input_schema.properties).toHaveProperty('prompt');
    expect(agentTool.input_schema.properties).toHaveProperty('model');
    expect(agentTool.input_schema.properties).toHaveProperty('max_turns');
    expect(agentTool.input_schema.properties).toHaveProperty('max_tool_use_iterations');
    expect(agentTool.input_schema.properties).toHaveProperty('id_prefix');
  });

  it('is NOT included in builtinToolSchemas', () => {
    expect(builtinToolSchemas.find((t) => t.name === 'agent')).toBeUndefined();
  });

  it('is NOT included in BUILTIN_TOOL_NAMES', () => {
    expect(BUILTIN_TOOL_NAMES).not.toContain('agent');
  });
});

describe('compose and skill tool descriptions', () => {
  it('documents every tool unavailable to compose leaf nodes', () => {
    expect(CHILD_ALLOWED_TOOLS).not.toContain('compose');
    const description = composeTool.description ?? '';
    const unavailableTools = description.match(/cannot call ([^;]+);/)?.[1];
    expect(unavailableTools).toBeDefined();
    for (const name of [...COMPOSE_LEAF_STRIPPED_TOOLS, 'compose']) {
      expect(unavailableTools).toContain(`\`${name}\``);
    }
    expect(composeTool.description).toContain('parallel `agent` calls');
    expect(composeTool.description).toContain('invoke `skill` once');
  });

  it('does not suggest compose nodes for parallel skill invocation', () => {
    expect(skillTool.description).toContain('parallel `agent` calls');
    expect(skillTool.description).not.toContain('via `agent` or `compose`');
  });
});

describe('sendMessageToAgentTool', () => {
  it('requires jobId and message', () => {
    expect(sendMessageToAgentTool.input_schema.required).toEqual(['jobId', 'message']);
  });

  it('description mentions model origin and Ctrl+B, and excludes user-initiated', () => {
    expect(sendMessageToAgentTool.description).toMatch(/model origin/);
    expect(sendMessageToAgentTool.description).toMatch(/Ctrl\+B/);
    expect(sendMessageToAgentTool.description).toMatch(/user-initiated/);
  });

  it('has category "subagent"', () => {
    expect(sendMessageToAgentTool.category).toBe('subagent');
  });

  it('is included in BUILTIN_TOOL_NAMES', () => {
    expect(BUILTIN_TOOL_NAMES).toContain('send_message_to_agent');
  });
});

describe('getBackgroundJobHealthTool', () => {
  it('requires only jobId', () => {
    expect(getBackgroundJobHealthTool.input_schema.required).toEqual(['jobId']);
  });

  it('describes health / activity signals', () => {
    expect(getBackgroundJobHealthTool.description).toMatch(/health/i);
    expect(getBackgroundJobHealthTool.description).toMatch(/activity/i);
  });

  it('has category "subagent"', () => {
    expect(getBackgroundJobHealthTool.category).toBe('subagent');
  });

  it('is marked concurrencySafe', () => {
    expect(getBackgroundJobHealthTool.concurrencySafe).toBe(true);
  });

  it('is included in BUILTIN_TOOL_NAMES', () => {
    expect(BUILTIN_TOOL_NAMES).toContain('get_background_job_health');
  });
});

describe('sendToSessionTool description', () => {
  it('retains the next-turn fallback clause for busy receivers (regression guard for #2950)', () => {
    // #2907 added this clause; #2950 briefly trimmed it away. Keep it pinned.
    expect(sendToSessionTool.description).toMatch(/next turn if no tool round remains/i);
  });

  it('documents the blocked predicates (turnState/blocked fields)', () => {
    expect(sendToSessionTool.description).toMatch(/turnState.*blocked/);
    expect(sendToSessionTool.description).toMatch(/blocked.*true/);
  });

  it('mentions read_witness for deeper per-turn detail', () => {
    expect(sendToSessionTool.description).toMatch(/read_witness/);
  });
});

describe('updateScheduleTool', () => {
  it('cwd field type is an array containing both "string" and "null" so null is schema-valid', () => {
    const props = updateScheduleTool.input_schema.properties as Record<string, { type: unknown }>;
    const cwdType = props['cwd']?.type;
    expect(Array.isArray(cwdType)).toBe(true);
    expect(cwdType).toContain('string');
    expect(cwdType).toContain('null');
  });
});

describe('schedule tool retry fields (#3243)', () => {
  it.each([
    ['create_schedule', createScheduleTool],
    ['update_schedule', updateScheduleTool],
  ])('%s declares bounded integer maxAttempts / retryDelayMs', (_name, tool) => {
    const props = tool.input_schema.properties as Record<string, { type: unknown; minimum?: number; maximum?: number }>;
    expect(props['maxAttempts']).toMatchObject({ type: 'integer', minimum: 1, maximum: TASK_MAX_ATTEMPTS_LIMIT });
    expect(props['retryDelayMs']).toMatchObject({
      type: 'integer',
      minimum: TASK_RETRY_DELAY_MIN_MS,
      maximum: TASK_RETRY_DELAY_MAX_MS,
    });
  });
});

// ---------------------------------------------------------------------------
// Prefix-cache stability tests (#4198)
// ---------------------------------------------------------------------------

describe('prefix-cache stability: invariant core prefix (#4198)', () => {
  /**
   * Build a fake assembled schemas[] the way both providers do, but with a
   * simulated deny list applied (filtering out named optional tools).
   */
  function assembleWithDisabled(disabled: string[]): AnthropicToolDef[] {
    const deniedSet = new Set(disabled);
    return [...builtinToolSchemas].filter((t) => !deniedSet.has(t.name));
  }

  it('two tools.disabled configs removing different optional tools share identical invariant core prefix', () => {
    // Config A: disable send_telegram only
    const schemasA = assembleWithDisabled(['send_telegram']);
    // Config B: disable all image tools only
    const schemasB = assembleWithDisabled(['image_generate', 'image_edit']);

    // Both should have the same first INVARIANT_CORE_COUNT tools in identical order.
    const prefixA = schemasA.slice(0, INVARIANT_CORE_COUNT).map((t) => t.name);
    const prefixB = schemasB.slice(0, INVARIANT_CORE_COUNT).map((t) => t.name);
    expect(prefixA).toEqual(prefixB);

    // And that prefix must equal the invariant core of builtinToolSchemas itself.
    const coreNames = builtinToolSchemas.slice(0, INVARIANT_CORE_COUNT).map((t) => t.name);
    expect(prefixA).toEqual(coreNames);
  });

  it('disabling a whole group still leaves invariant core prefix intact', () => {
    // Simulate disabling the "schedules" and "browser" groups.
    const scheduleTools = ['create_schedule', 'update_schedule', 'list_schedules', 'get_schedule_history', 'cancel_schedule'];
    const browserTools = ['browser_open', 'browser_observe', 'browser_act', 'browser_screenshot', 'browser_close'];
    const schemas = assembleWithDisabled([...scheduleTools, ...browserTools]);

    const prefix = schemas.slice(0, INVARIANT_CORE_COUNT).map((t) => t.name);
    const coreNames = builtinToolSchemas.slice(0, INVARIANT_CORE_COUNT).map((t) => t.name);
    expect(prefix).toEqual(coreNames);
  });
});

describe('prefix-cache stability: filterBackgroundToolDefs (#4235)', () => {
  it('invariant core prefix is intact after filterBackgroundToolDefs(false, false)', () => {
    // subagentBackground=false, processJobs=false → all three bg tools removed
    const filtered = filterBackgroundToolDefs([...builtinToolSchemas], false, false);
    const prefix = filtered.slice(0, INVARIANT_CORE_COUNT).map((t) => t.name);
    const coreNames = builtinToolSchemas.slice(0, INVARIANT_CORE_COUNT).map((t) => t.name);
    expect(prefix).toEqual(coreNames);
  });

  it('invariant core prefix is intact after filterBackgroundToolDefs(false, true)', () => {
    // subagentBackground=false, processJobs=true → only send_message_to_agent removed
    const filtered = filterBackgroundToolDefs([...builtinToolSchemas], false, true);
    const prefix = filtered.slice(0, INVARIANT_CORE_COUNT).map((t) => t.name);
    const coreNames = builtinToolSchemas.slice(0, INVARIANT_CORE_COUNT).map((t) => t.name);
    expect(prefix).toEqual(coreNames);
  });

  it('filterBackgroundToolDefs(false, false) removes all three bg tools', () => {
    const filtered = filterBackgroundToolDefs([...builtinToolSchemas], false, false);
    const names = filtered.map((t) => t.name);
    expect(names).not.toContain('cancel_background_job');
    expect(names).not.toContain('send_message_to_agent');
    expect(names).not.toContain('get_background_job_health');
  });

  it('filterBackgroundToolDefs(false, true) removes only send_message_to_agent', () => {
    const filtered = filterBackgroundToolDefs([...builtinToolSchemas], false, true);
    const names = filtered.map((t) => t.name);
    expect(names).not.toContain('send_message_to_agent');
    expect(names).toContain('cancel_background_job');
    expect(names).toContain('get_background_job_health');
  });

  it('filterBackgroundToolDefs(true, false) keeps all three bg tools', () => {
    // subagentBackground=true → early-return path; all three bg tools kept regardless of processJobs
    const filtered = filterBackgroundToolDefs([...builtinToolSchemas], true, false);
    const names = filtered.map((t) => t.name);
    expect(names).toContain('cancel_background_job');
    expect(names).toContain('send_message_to_agent');
    expect(names).toContain('get_background_job_health');
  });

  it('invariant core prefix is intact after filterBackgroundToolDefs(true, false)', () => {
    // subagentBackground=true → early-return path; prefix must still be stable
    const filtered = filterBackgroundToolDefs([...builtinToolSchemas], true, false);
    const prefix = filtered.slice(0, INVARIANT_CORE_COUNT).map((t) => t.name);
    const coreNames = builtinToolSchemas.slice(0, INVARIANT_CORE_COUNT).map((t) => t.name);
    expect(prefix).toEqual(coreNames);
  });
});

describe('prefix-cache stability: MCP sort (#4198)', () => {
  function makeTool(name: string): AnthropicToolDef {
    return { name, description: name, input_schema: { type: 'object', properties: {}, required: [] } };
  }

  it('two getMcpTools() return values in different insertion orders produce identical sorted segment', () => {
    // Simulate two sessions where MCP servers connected in different orders.
    const orderA = [makeTool('mcp__z__tool'), makeTool('mcp__a__tool'), makeTool('mcp__m__tool')];
    const orderB = [makeTool('mcp__m__tool'), makeTool('mcp__z__tool'), makeTool('mcp__a__tool')];

    const sortedA = sortMcpSchemas(orderA).map((t) => t.name);
    const sortedB = sortMcpSchemas(orderB).map((t) => t.name);
    expect(sortedA).toEqual(sortedB);
    expect(sortedA).toEqual(['mcp__a__tool', 'mcp__m__tool', 'mcp__z__tool']);
  });

  it('sortMcpSchemas does not mutate the input array', () => {
    const tools = [makeTool('mcp__z__tool'), makeTool('mcp__a__tool')];
    const originalOrder = tools.map((t) => t.name);
    sortMcpSchemas(tools);
    expect(tools.map((t) => t.name)).toEqual(originalOrder);
  });
});
