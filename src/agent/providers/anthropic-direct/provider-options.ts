/**
 * Construction options and the client-factory seam for
 * {@link AnthropicDirectProvider}.
 *
 * Extracted from `index.ts` (#824) as a leaf module: it owns the provider's
 * declarative construction surface plus the module-scope test hook, and
 * imports nothing from its siblings.
 *
 * Contract: the client factory has TWO layers with a fixed precedence —
 * a per-instance `AnthropicDirectProviderOptions.clientFactory` wins over the
 * module-scope hook installed by {@link __setAnthropicClientFactory}, and the
 * real `Anthropic` constructor is used when neither is set. `query()` and
 * `complete()` both resolve it as `this.providerFactory ?? getClientFactory()`,
 * so a test that installs the module hook cannot silently override a caller
 * that injected its own client.
 *
 * The module-scope factory is deliberately module state rather than a
 * constructor argument: integration tests install it once and construct
 * providers indirectly (through `resolveProvider`), where they have no handle
 * on the construction call.
 *
 * @module agent/providers/anthropic-direct/provider-options
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { CanUseTool } from '../../types/sdk-types.js';
import type { HookRegistry } from '../../hooks.js';
import type { MemoryStore } from '../../memory/index.js';
import type { SubagentExecutor } from '../../tools/subagent-executor.js';
import type { SkillExecutor } from '../../tools/skill-executor.js';
import type { ComposeExecutor } from '../../tools/compose-executor.js';
import type { ToolPermissionConfig } from '../../tools/permissions.js';
import type { ToolDispatcher } from './tool-dispatcher.js';
import type { FastModeController } from '../../fast-mode.js';

/** Test/factory hook: lets tests inject a stub Anthropic client.
 *
 * `baseURL` is the SDK's camelCase option name (forwarded by
 * `buildClientOptions` when the local-server path is active).
 */
export type AnthropicClientFactory = (
  opts: ({ authToken: string } | { apiKey: string }) & { baseURL?: string; fetch?: typeof fetch },
) => Anthropic;

let clientFactory: AnthropicClientFactory | null = null;

/**
 * Module-scope escape hatch used by integration tests; not part of the stable
 * surface. Pass `null` to restore the real `Anthropic` constructor.
 */
export function __setAnthropicClientFactory(
  factory: AnthropicClientFactory | null,
): void {
  clientFactory = factory;
}

/**
 * Read the currently-installed module-scope client factory.
 *
 * Invariant: callers MUST read through this accessor at call time rather than
 * caching the value at module load. `__setAnthropicClientFactory` is routinely
 * called from a test's `beforeEach` — after this module was first imported —
 * so a captured binding would pin whatever was installed at import time and
 * silently send test traffic to the real SDK.
 */
export function getClientFactory(): AnthropicClientFactory | null {
  return clientFactory;
}

/** Construction options for {@link AnthropicDirectProvider}. */
export interface AnthropicDirectProviderOptions {
  /** Session-scoped Fast preference; top-level interactive providers only. */
  fastModeController?: FastModeController;
  /** Pluggable tool dispatcher. When set, overrides the built-in SessionToolDispatcher. */
  tools?: ToolDispatcher;
  /** Hook registry for PreToolUse/PostToolUse integration. */
  hookRegistry?: HookRegistry;
  /** Tool permission configuration (allowlist). */
  permissions?: ToolPermissionConfig;
  /** In-process permission callback, forwarded to the session dispatcher. */
  canUseTool?: CanUseTool;
  /**
   * Optional client factory override. When set, takes precedence over the
   * module-scope `__setAnthropicClientFactory` hook. Useful for callers that
   * want to inject a pre-built client (e.g. with custom retries) without
   * touching module state.
   */
  clientFactory?: AnthropicClientFactory;
  /** Optional subagent executor. When provided, the Agent tool is included in the tool set. */
  subagentExecutor?: SubagentExecutor;
  /** Optional skill executor. When provided, the Skill tool is included in the tool set. */
  skillExecutor?: SkillExecutor;
  /** Optional compose executor. When provided, the Compose tool is included in the tool set. */
  composeExecutor?: ComposeExecutor;
  /** Shared MemoryStore instance. When set, avoids creating a second store. */
  memoryStore?: MemoryStore;
  /** Surface identifier for fact metadata (e.g. 'cli', 'daemon', 'telegram'). */
  surface?: string;
  /**
   * When true, the provider exposes only the read-only `memory_search` tool
   * (no `memory_update`, no `procedure_write`) and substitutes the
   * {@link MEMORY_SYSTEM_PROMPT_READONLY} variant in the system prompt.
   * Defaults to false. Set by {@link createChildProviderFactory} for
   * subagent / skill child sessions — only the parent writes memory.
   */
  readOnlyMemory?: boolean;
  /**
   * When true, the per-query {@link SessionToolDispatcher} blocks mutating
   * `bash` commands (read-only recon — git status/log/diff, ls, cat, find,
   * grep — is allowed). Set by `createChildProviderFactory` /
   * `buildReadOnlyReconProvider` for a read-only skill's forked child, paired
   * with `permissions.allowedTools = RECON_ALLOWED_TOOLS` (which strips
   * `write_file`/`edit_file`). Defaults to false.
   */
  readOnlyBash?: boolean;
  /**
   * Optional MCP manager. When provided, every tool exposed by a
   * `connected` MCP server is merged into the provider's tool schema list
   * and the per-query dispatcher's handler map. Pre/PostToolUse hooks
   * fire for MCP tools automatically via the dispatcher (see
   * `tools/dispatcher.ts:247,342`).
   *
   * Lifecycle: caller owns construction (`McpManager.fromConfig()`) and
   * teardown (`disconnectAll()`). Subagents inherit the same manager by
   * reference — never reconstructed per-fork.
   */
  mcpManager?: import('../../mcp/index.js').McpManager;
  /**
   * In-process custom tools registered by the library consumer. Each entry
   * supplies an `AnthropicToolDef` schema (added to the provider's schema
   * list at construction time) and a `ToolHandler` (registered in the
   * per-query dispatcher's handler map).
   *
   * Custom tools run through the same permission gate and PreToolUse /
   * PostToolUse hooks as built-in tools — no bypass.
   *
   * Precedence: builtins > MCP > custom (a custom tool whose name collides
   * with a builtin is silently skipped — see `buildDispatcher`).
   */
  customTools?: import('../../tools/custom-tool.js').CustomToolDef[];
}
