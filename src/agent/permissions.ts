/**
 * Permission hook helpers for tool execution.
 *
 * Provides a lightweight, declarative way to build a `canUseTool` callback
 * compatible with the Agent SDK's `CanUseTool` signature.
 *
 * @module agent/permissions
 */

import type { CanUseTool, PermissionResult } from './types/sdk-types.js';

/**
 * Declarative permission mode for a tool.
 * `'ask'` delegates to `onAsk`; falls back to `'allow'` if no handler is set.
 */
export type ToolPermissionMode = 'allow' | 'deny' | 'ask';

/**
 * Permission rule for a specific tool name.
 */
export interface ToolPermission {
  /**
   * Tool name — MUST be the AFK **runtime** name (snake_case): `bash`,
   * `read_file`, `edit_file`, `write_file`, `grep`, `glob`, `web_scrape`, … —
   * NOT the Claude Code PascalCase alias (`Bash`, `Read`, `Edit`). Rule keys
   * are matched verbatim against the runtime tool name the dispatcher passes;
   * a key that doesn't match falls through to `defaultMode`. With
   * `defaultMode: 'allow'` a mismatched key therefore FAILS OPEN — the tool you
   * meant to deny is silently permitted. (MCP tools use their wire name,
   * `mcp__<server>__<tool>`.)
   */
  tool: string;
  /** Behavior when the tool is requested. */
  mode: ToolPermissionMode;
  /** Optional reason shown/recorded for deny decisions. */
  reason?: string;
}

export interface ToolPermissionRules {
  /** Default behavior when no per-tool rule matches. Defaults to `ask`. */
  defaultMode?: ToolPermissionMode;
  /** Per-tool overrides by tool name. */
  tools?: Record<string, ToolPermissionMode | { mode: ToolPermissionMode; reason?: string }>;
  /** Optional list form (merged after `tools`). */
  list?: ToolPermission[];
}

export interface CanUseToolContext {
  /** Tool name being requested. */
  toolName: string;
  /** Raw tool input payload from the SDK. */
  input: Record<string, unknown>;
}

export interface PermissionDecision {
  /** Final behavior. */
  behavior: 'allow' | 'deny';
  /** Reason attached to deny decisions. */
  reason?: string;
}

function normalizeRules(rules: ToolPermissionRules): {
  defaultMode: ToolPermissionMode;
  byTool: Map<string, { mode: ToolPermissionMode; reason?: string }>;
} {
  const byTool = new Map<string, { mode: ToolPermissionMode; reason?: string }>();
  const defaultMode = rules.defaultMode ?? 'ask';

  if (rules.tools) {
    for (const [tool, value] of Object.entries(rules.tools)) {
      if (typeof value === 'string') byTool.set(tool, { mode: value });
      else byTool.set(tool, { mode: value.mode, reason: value.reason });
    }
  }

  if (rules.list) {
    for (const rule of rules.list) {
      byTool.set(rule.tool, { mode: rule.mode, reason: rule.reason });
    }
  }

  return { defaultMode, byTool };
}

function toPermissionResult(decision: PermissionDecision): PermissionResult {
  if (decision.behavior === 'allow') return { behavior: 'allow' };
  return { behavior: 'deny', message: decision.reason ?? 'Tool denied by permission rules' };
}

/**
 * Build a `canUseTool` hook from simple allow/deny/ask rules.
 *
 * The returned function is safe to pass directly as `AgentConfig.canUseTool`.
 *
 * ⚠️ Rule keys MUST be AFK **runtime** tool names (snake_case) — see
 * {@link ToolPermission.tool}. A key that doesn't match the runtime name falls
 * through to `defaultMode`, so a PascalCase key like `Bash` combined with
 * `defaultMode: 'allow'` FAILS OPEN (the tool you meant to deny still runs).
 *
 * ```ts
 * const hook = createCanUseToolHook({
 *   rules: {
 *     defaultMode: 'allow',
 *     tools: { bash: 'deny', edit_file: 'deny' }, // runtime names, not Bash/Edit
 *   },
 * });
 * const session = new AgentSession({ model: 'sonnet', canUseTool: hook });
 * ```
 */
export function createCanUseToolHook(options: {
  rules: ToolPermissionRules;
  /**
   * Called when a tool resolves to `ask`. If omitted, `ask` falls through as `allow`.
   */
  onAsk?: (ctx: CanUseToolContext) => Promise<PermissionDecision>;
  /**
   * Called for observability on every decision.
   */
  onDecision?: (ctx: CanUseToolContext, decision: PermissionDecision) => void;
}): CanUseTool {
  const { defaultMode, byTool } = normalizeRules(options.rules);

  return async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    const ctx: CanUseToolContext = { toolName, input };
    const matched = byTool.get(toolName);
    const mode = matched?.mode ?? defaultMode;
    const reason = matched?.reason;

    let decision: PermissionDecision;

    if (mode === 'ask' && options.onAsk) {
      decision = await options.onAsk(ctx);
    } else if (mode === 'deny') {
      decision = { behavior: 'deny', reason };
    } else {
      // 'allow' or unhandled 'ask' — permit
      decision = { behavior: 'allow' };
    }

    options.onDecision?.(ctx, decision);
    return toPermissionResult(decision);
  };
}
