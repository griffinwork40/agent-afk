/**
 * Construction-time options and static model metadata for
 * {@link AnthropicDirectQuery}.
 *
 * Extracted verbatim from `query-runtime.ts` (#824 split) so the orchestrator
 * file holds only the class. These are pure declarations — no instance state,
 * no behavior. `AnthropicDirectQueryOptions` is re-exported from
 * `query-runtime.ts` (and thence `query.ts` / `index.ts`), so every historical
 * import path stays valid.
 *
 * @module agent/providers/anthropic-direct/query-options
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';
import type { ProviderModelInfo, ProviderUserTurn } from '../../provider.js';
import type { ToolDispatcher } from './tool-dispatcher.js';
import type { AnthropicToolDef, AuthMode } from './types.js';
import type { HookRegistry } from '../../hooks.js';

/**
 * Small static starter list returned by `supportedModels()`. The provider
 * accepts arbitrary Claude model ids at runtime — this is only a hint for UI
 * surfaces that want a quick dropdown.
 */
const STARTER_MODELS: ReadonlyArray<{ value: string; displayName: string; description: string }> = [
  {
    value: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    description: 'Balanced Claude — recommended default (1M context, 128k output)',
  },
  {
    value: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    description: 'Newer balanced Claude — adaptive thinking, new tokenizer',
  },
  {
    value: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    description: 'Highest-capability Claude for agentic coding',
  },
  {
    value: 'claude-haiku-4-5-20251001',
    displayName: 'Claude Haiku 4.5',
    description: 'Fastest, cheapest Claude',
  },
];

/** Constructor options for {@link AnthropicDirectQuery}. */
export interface AnthropicDirectQueryOptions {
  client: Anthropic;
  authMode: AuthMode;
  promptStream: AsyncIterable<ProviderUserTurn>;
  toolDispatcher: ToolDispatcher;
  sessionId?: string;
  initialMessages?: MessageParam[];
  model: string;
  /**
   * The model the caller requested — a short alias (`opus_1m`, `sonnet`, …)
   * or a full id. When omitted, defaults to `model`. Carries the alias so the
   * context-window lookup can distinguish 1M variants (`opus_1m`) from their
   * base (`opus`), which resolve to the same wire `model` but have different
   * windows. See {@link SessionState.requestedModel}.
   */
  requestedModel?: string;
  permissionMode?: string;
  maxTokens: number;
  tools: AnthropicToolDef[] | null;
  userSystem: string | null;
  systemPrefix: ContentBlockParam[] | null;
  /** When set, called on 401 to obtain a fresh SDK client. Retry once. */
  tokenRefresher?: () => Promise<Anthropic | null>;
  /** Extended thinking configuration forwarded to `messages.create`. */
  thinking?: import('@anthropic-ai/sdk/resources').ThinkingConfigParam;
  /**
   * Effort level forwarded as `output_config.effort` to `messages.create`.
   * When set, the per-request `anthropic-beta` header is extended with the
   * effort beta string via the `withEffort` flag on `buildRequestHeaders`.
   */
  effort?: import('../../types/sdk-types.js').EffortLevel;
  /**
   * Local-server base URL. When set, prompt-cache markers are suppressed
   * across all turns (see `isCacheEnabled({baseUrl})`).
   */
  baseUrl?: string;
  /**
   * Hard cap on tool-use loop iterations within a single user turn, forwarded
   * to `runTurn` as `RunTurnInput.maxToolUseIterations`. Unset/`0` means no cap
   * (the top-level default); subagent forks pass a non-zero ceiling so a
   * runaway child cannot spin unboundedly while the parent awaits its result.
   */
  maxToolUseIterations?: number;
  /**
   * Soft wall-clock deadline (ms from turn start) forwarded to `runTurn` as
   * `RunTurnInput.softDeadlineMs`. The TIME sibling of the round cap above:
   * once passed, the loop runs ONE tools-stripped wind-down round rather than
   * being killed mid-work by the hard `withTimeout` abort. Unset/`0` means no
   * soft deadline — see `shared/soft-deadline.ts`.
   */
  softDeadlineMs?: number;
  /** Witness-layer trace writer threaded into each per-turn run. */
  traceWriter?: import('../../trace/index.js').TraceWriter;
  /**
   * Owning subagent id when this query runs inside a forked child
   * (`AgentConfig.subagentId`). Threaded into `RunTurnInput.subagentId` so the
   * loop's `tool_call` events are attributable in the shared parent trace.
   * Absent for a top-level session. See issue #612.
   */
  subagentId?: string;
  /**
   * When true (default), the query automatically waits for the OAuth
   * subscription reset and replays the in-flight turn on 429 usage-limit
   * errors instead of surfacing them immediately.
   */
  autoResumeOnUsageLimit?: boolean;
  /**
   * User-facing surface (`AgentConfig.surface`) forwarded verbatim to
   * {@link RetryLayer} so the overload-pause ceiling can differ for interactive
   * vs. daemon sessions (#762). Undefined ⇒ treated as non-interactive.
   */
  surface?: string;
  /**
   * Factory for rebuilding the cwd-dependent pair (userSystem + dispatcher)
   * when `setCwd()` is called mid-session. When absent, `setCwd()` is a
   * no-op (e.g. external-dispatcher callers that own their own lifecycle).
   *
   * The factory is supplied by `AnthropicDirectProvider.query()` as a
   * closure over the stable parts of the system prompt (toolBase,
   * MEMORY_SYSTEM_PROMPT, manifest, userSystemPart) that do not change when
   * the cwd changes. Only the `# Environment\n- Working directory:` line
   * and the bash/grep/glob handler closures need to be rebuilt.
   */
  cwdDependentsFactory?: (cwd: string) => { userSystem: string; dispatcher: ToolDispatcher };
  /**
   * Factory for re-assembling `userSystem` around a NEW composed base prompt
   * when `setSystemPrompt()` is called mid-session (the `/afk-md` hot-reload
   * path). When absent, `setSystemPrompt()` reports `false` and changes
   * nothing — same degradation contract as `cwdDependentsFactory`.
   *
   * Supplied by `AnthropicDirectProvider.query()` as a closure over the same
   * shared `stableSystemPrefix` the cwd factory uses, so the two rebuild paths
   * compose rather than overwrite each other. See `query/overlay-rebuild.ts`.
   */
  systemPromptRebuildFactory?: (basePrompt: string | undefined) => string;
  /**
   * Provider callback invoked by `setPermissionMode()` to update the
   * provider-level `_currentPermissionMode` — the field the path-approval hook
   * reads via the provider's `getGrants().allowAll`. This is the path-approval
   * half of a live `/bypass` toggle; the file-tool half is the dispatcher's
   * `setAllowAll()`. Supplied by `AnthropicDirectProvider.query()`.
   */
  onPermissionMode?: (mode: string) => void;
  /**
   * Optional MCP manager — used by `session.init` and `mcpServerStatus()`
   * to surface live MCP server status to the REPL (`/mcp`), the Telegram
   * bridge, and the daemon's state file. The query itself does NOT call
   * into the manager beyond reading status; tool dispatch is handled via
   * the merged handler map in the dispatcher (set up in
   * `AnthropicDirectProvider.buildDispatcher`).
   */
  mcpManager?: import('../../mcp/index.js').McpManager;
  /**
   * Auto-compaction threshold (fraction of context window, 0–1 exclusive).
   * When provided, the turn loop triggers compact() automatically after
   * any turn whose token footprint exceeds this fraction of the model's
   * context limit. Guarded by abort.isIdle() and the compact-handler lock.
   * undefined means auto-compaction is disabled (the default).
   */
  autoCompactThreshold?: number;
  /**
   * Hook registry forwarded from the session harness. When present, the
   * auto-compact path dispatches `PreCompact(trigger:'auto')` before calling
   * `compact()`, matching the manual-compact paths in the REPL and Telegram
   * surfaces. A `block` decision (HookBlockedError) skips compaction for that
   * turn without surfacing an error to the caller.
   */
  hookRegistry?: HookRegistry;
  /**
   * Out-of-band mailbox for live throttle (rate-limit/backoff) signals. The
   * SAME instance is wired to the SDK client's `fetch` throttle callback at
   * query construction (`index.ts`); threaded into each per-turn `runTurn`
   * via `RunTurnInput.throttleQueue` so the loop can surface a `rate_limit`
   * ProviderEvent LIVE while parked on a throttled `messages.create`. Absent
   * for local-shim / external-dispatcher paths where the tracing fetch is not
   * installed.
   */
  throttleQueue?: import('./throttle-queue.js').ThrottleQueue;
  fastModeController?: import('../../fast-mode.js').FastModeController;
}

/** Snapshot of the starter list, freshly cloned per call (callers may mutate). */
export function starterModels(): ProviderModelInfo[] {
  return STARTER_MODELS.map((m) => ({ ...m }));
}
