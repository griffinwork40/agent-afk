/**
 * Regression tests for {@link topLevelSurfaceAllowedTools}.
 *
 * Locks the fix for the bug where the human-facing top-level surfaces (REPL,
 * one-shot `chat`, Telegram) each constructed their own `AnthropicDirectProvider`
 * with an inline allowlist that dropped `exit_plan_mode`. `parseProvider`
 * returns undefined for the default Anthropic model (no `--provider` flag), so
 * those surfaces fall back to that hardcoded provider — and with plan mode
 * active the provider registers the `exit_plan_mode` tool and the model calls
 * it, but the STATIC allowlist omitted the name, so the dispatcher's permission
 * gate rejected it with "not in the configured allowlist". This helper is the
 * single source of truth those three surfaces now consume.
 */

import { describe, it, expect } from 'vitest';
import { topLevelSurfaceAllowedTools } from './top-level-allowlist.js';
import { BUILTIN_TOOL_NAMES } from './schemas.js';
import { MEMORY_TOOL_NAMES } from '../memory/index.js';
import { AWARENESS_TOOL_NAMES } from '../awareness/index.js';
import { EXIT_PLAN_MODE_TOOL_NAME } from './handlers/exit-plan-mode.js';

describe('topLevelSurfaceAllowedTools', () => {
  it('includes exit_plan_mode (the always-on, plan-mode-only tool that was missing)', () => {
    expect(topLevelSurfaceAllowedTools()).toContain(EXIT_PLAN_MODE_TOOL_NAME);
    expect(topLevelSurfaceAllowedTools()).toContain('exit_plan_mode');
  });

  it('includes every always-on builtin, memory, and awareness tool name', () => {
    const list = topLevelSurfaceAllowedTools();
    for (const name of BUILTIN_TOOL_NAMES) expect(list).toContain(name);
    for (const name of MEMORY_TOOL_NAMES) expect(list).toContain(name);
    for (const name of AWARENESS_TOOL_NAMES) expect(list).toContain(name);
    expect(list).toContain('get_runtime_state');
  });

  it('includes the full executor set (agent, skill, compose) these surfaces always wire', () => {
    const list = topLevelSurfaceAllowedTools();
    expect(list).toContain('agent');
    expect(list).toContain('skill');
    expect(list).toContain('compose');
  });

  it('unions MCP wire names when supplied, and defaults to none when omitted', () => {
    const withMcp = topLevelSurfaceAllowedTools(['mcp__srv__do', 'mcp__srv__list']);
    expect(withMcp).toContain('mcp__srv__do');
    expect(withMcp).toContain('mcp__srv__list');
    // Omitting the arg must not leak any mcp__ names.
    expect(topLevelSurfaceAllowedTools().some((n) => n.startsWith('mcp__'))).toBe(false);
  });

  it('produces the exact canonical list (locks against accidental drift)', () => {
    expect(topLevelSurfaceAllowedTools()).toEqual([
      ...BUILTIN_TOOL_NAMES,
      ...MEMORY_TOOL_NAMES,
      ...AWARENESS_TOOL_NAMES,
      EXIT_PLAN_MODE_TOOL_NAME,
      'agent',
      'skill',
      'compose',
    ]);
  });
});
