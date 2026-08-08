/**
 * The view of {@link AnthropicDirectProvider} that its extracted `query()`
 * pipeline operates on.
 *
 * # Why a context object rather than methods on the class
 *
 * `query()` was extracted from `provider-runtime.ts` (#824 split) to hold every
 * module under the 350-LOC budget. A TypeScript class cannot be physically
 * continued across files, so `query()` became a free function taking this
 * context and the class kept a one-line delegate.
 *
 * # Invariant: mutable session state is exposed as accessors, not values
 *
 * `_currentCwd`, `_currentPermissionMode`, `_mintedSessionId` and
 * `_presenceSessionId` are re-read and re-written across a session's lifetime
 * (per turn, and again on every `setCwd`). They MUST stay owned by the provider
 * instance — the shared-root arrays in particular are shared BY REFERENCE with
 * every per-query dispatcher, which is how `/allow-dir` grants survive across
 * turns. Passing copies would silently break that.
 *
 * @module agent/providers/anthropic-direct/provider-context
 */

import type { CanUseTool } from '../../types/sdk-types.js';
import type { SessionToolDispatcher } from '../../tools/dispatcher.js';
import type { ToolDispatcher } from './tool-dispatcher.js';
import type { SkillExecutor } from '../../tools/skill-executor.js';
import type { AnthropicClientFactory } from './provider-options.js';
import type { BuildDispatcherOptions } from './build-dispatcher.js';

/** Provider-scoped collaborators and live session state used by `query()`. */
export interface ProviderQueryContext {
  /** Non-null only when the caller provided an explicit `opts.tools` override. */
  readonly externalTools: ToolDispatcher | undefined;
  readonly providerFactory: AnthropicClientFactory | undefined;
  readonly skillExecutor: SkillExecutor | undefined;
  readonly subagentExecutor: import('../../tools/subagent-executor.js').SubagentExecutor | undefined;
  readonly composeExecutor: import('../../tools/compose-executor.js').ComposeExecutor | undefined;
  readonly canUseTool: CanUseTool | undefined;
  /** Defaults to 'cli' for presence advertising — see {@link declaredSurface}. */
  readonly surface: string;
  /**
   * The surface as DECLARED by the constructor caller — `undefined` when none
   * was passed. The overload-pause gate reads THIS, never `surface`, so a
   * forked child (constructed with no surface) is never granted the
   * interactive park (#762/#764).
   */
  readonly declaredSurface: string | undefined;
  readonly readOnlyMemory: boolean;
  readonly mcpManager: import('../../mcp/index.js').McpManager | undefined;
  readonly fastModeController: import('../../fast-mode.js').FastModeController | undefined;

  /** Shared-by-reference root arrays; mutated in place so grants survive turns. */
  getSharedReadRoots(): string[] | undefined;
  getSharedWriteRoots(): string[] | undefined;
  getCurrentCwd(): string | undefined;
  setCurrentCwd(cwd: string | undefined): void;
  getCurrentPermissionMode(): string;
  setCurrentPermissionMode(mode: string): void;
  getMintedSessionId(): string | null;
  setMintedSessionId(v: string | null): void;
  getPresenceSessionId(): string | null;
  setPresenceSessionId(v: string | null): void;

  /** Lazily initialise the shared root arrays (see the provider's method). */
  ensureSharedRoots(cwd?: string): void;
  /** Build a per-query tool dispatcher closed over the session's mode + cwd. */
  buildDispatcher(permissionMode: string, opts?: BuildDispatcherOptions): SessionToolDispatcher;
}
