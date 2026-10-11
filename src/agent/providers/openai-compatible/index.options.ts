/**
 * `OpenAICompatibleProviderOptions` — construction-time dependency bundle for
 * {@link OpenAICompatibleProvider}. Split out of `index.ts` (file-size ceiling,
 * #3481).
 *
 * @module agent/providers/openai-compatible/index.options
 */

import type { HookRegistry } from '../../hooks.js';
import type { SubagentExecutor } from '../../tools/subagent-executor.js';
import type { SkillExecutor } from '../../tools/skill-executor.js';
import type { ComposeExecutor } from '../../tools/compose-executor.js';
import type { ToolPermissionConfig } from '../../tools/permissions.js';
import type { CanUseTool } from '../../types/sdk-types.js';
import type { ToolDispatcher } from '../anthropic-direct/tool-dispatcher.js';
import { MemoryStore } from '../../memory/index.js';
import { WorkspaceStore } from '../../workspace/index.js';
import { StateStore } from '../../state/state-store.js';
import type { ChildSessionOptions } from './index.child-session.js';

/**
 * Construction options. The same surface anthropic-direct exposes — modulo
 * Anthropic-specific knobs (client factory, OAuth keychain) — so callers
 * can build either provider with the same dependency bundle.
 */
export interface OpenAICompatibleProviderOptions extends ChildSessionOptions {
  /** Override the default `https://api.openai.com/v1` endpoint. */
  baseURL?: string;
  /**
   * Optional default headers for every client built by this provider
   * (e.g. xAI CLI-proxy identity). Per-query overrides may also be supplied
   * via {@link OpenAICompatibleProvider.setEndpointDefaults}.
   */
  defaultHeaders?: Record<string, string>;
  /** Hook registry — PreToolUse / PostToolUse fire from the dispatcher. */
  hookRegistry?: HookRegistry;
  /** Tool permission gate (allowlist/denylist). */
  permissions?: ToolPermissionConfig;
  /** In-process permission callback, forwarded to the session dispatcher. */
  canUseTool?: CanUseTool;
  subagentExecutor?: SubagentExecutor;
  skillExecutor?: SkillExecutor;
  composeExecutor?: ComposeExecutor;
  /** Shared memory store (avoids dual SQLite handles when CLI builds it once). */
  memoryStore?: MemoryStore;
  workspaceStore?: WorkspaceStore;
  stateStore?: StateStore;
  /** UI surface tag forwarded to memory handlers ('cli' | 'telegram' | etc.). */
  surface?: string;
  /**
   * When true, expose and wire only the read-only `memory_search` tool.
   * Child sessions set this so OpenAI-routed subagents follow the same
   * provider-level memory-write embargo as Anthropic-routed subagents.
   */
  readOnlyMemory?: boolean;
  /**
   * When true, the per-query {@link SessionToolDispatcher} blocks mutating
   * `bash` commands (read-only recon allowed). Parity with
   * `AnthropicDirectProviderOptions.readOnlyBash`. Set by
   * `createChildProviderFactory` / `buildReadOnlyReconProvider` for a
   * read-only skill's forked child. Defaults to false.
   */
  readOnlyBash?: boolean;
  /**
   * Caller-provided dispatcher. When set, the provider does NOT build its
   * own — the caller owns lifecycle. Mirrors anthropic-direct's `externalTools`
   * option used by tests and the nesting fixture.
   */
  tools?: ToolDispatcher;
  /**
   * Optional MCP manager — mirrors `AnthropicDirectProviderOptions.mcpManager`.
   * When provided, every tool exposed by a `connected` MCP server is merged
   * into the provider's tool schema list and the per-query dispatcher's
   * handler map. Hooks fire for MCP tools automatically via the dispatcher.
   */
  mcpManager?: import('../../mcp/index.js').McpManager;
  /**
   * In-process custom tools registered by the library consumer. Mirrors
   * `AnthropicDirectProviderOptions.customTools` for full provider parity.
   * Each entry supplies an `AnthropicToolDef` schema (added to the provider's
   * schema list at construction time) and a `ToolHandler` (registered in the
   * per-query dispatcher's handler map).
   *
   * Precedence: builtins > custom (a custom tool whose name collides with a
   * builtin is silently skipped — see `buildDispatcher`).
   */
  customTools?: import('../../tools/custom-tool.js').CustomToolDef[];
  /** `/fast` controller (top-level REPL sessions); sends service_tier "priority" when eligible. */
  fastModeController?: import('../../fast-mode.js').FastModeController;
}
