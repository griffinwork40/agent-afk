import { describe, expect, it } from 'vitest';
import { builtinToolSchemas, BUILTIN_TOOL_NAMES, agentTool } from './schemas.js';

describe('builtinToolSchemas', () => {
  it('contains exactly 23 tools', () => {
    expect(builtinToolSchemas).toHaveLength(23);
  });

  it('exports the expected tool names', () => {
    expect(BUILTIN_TOOL_NAMES).toEqual([
      'bash',
      'read_file',
      'write_file',
      'edit_file',
      'glob',
      'grep',
      'list_directory',
      'send_telegram',
      'web_scrape',
      'create_schedule',
      'list_schedules',
      'get_schedule_history',
      'cancel_schedule',
      'worktree',
      'terminal_font_size',
      'config_get',
      'config_set',
      'ask_question',
      'browser_open',
      'browser_observe',
      'browser_act',
      'browser_screenshot',
      'browser_close',
    ]);
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
    // All other built-ins have non-empty required arrays.
    const noRequired = new Set([
      'web_scrape',
      'list_schedules',
      'browser_observe',
      'browser_screenshot',
      'browser_close',
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
