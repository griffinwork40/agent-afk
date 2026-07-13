/**
 * Session identity, metadata, and the IAgentSession interface.
 * @module agent/types/session-types
 */

import type {
  AccountInfo,
  AgentInfo,
  ApiKeySource,
  McpServerStatus,
  ModelInfo,
  PermissionMode,
  SDKControlGetContextUsageResponse,
  SDKStatus,
  SlashCommand,
} from './sdk-types.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { AgentModelInput } from './model-types.js';
import type { InputStreamRef } from './permission-types.js';
import type {
  Message,
  MessageChunk,
  ResponseMetadata,
  SendMessageOptions,
  StructuredMessageOptions,
} from './message-types.js';
import type { ProviderCompactResult, ProviderQuery } from '../provider.js';
import type { HookRegistry } from '../hooks.js';
import type { ZodType } from 'zod';

/** Agent session state */
export type SessionState = 'idle' | 'processing' | 'streaming' | 'compacting' | 'closed';

/** Snapshot of the Claude session identity / persistence configuration. */
export interface SessionIdentity {
  sessionId?: string;
  /** Explicit session ID configured at construction time */
  configuredSessionId?: string;
  /** Resumed source session ID, when applicable */
  resume?: string;
  /** Resume boundary assistant message UUID */
  resumeSessionAt?: string;
  /** Continue the most recent persisted session in cwd */
  continue?: boolean;
  /** Fork resumed session state into a new session */
  forkSession?: boolean;
  /** Whether the SDK should persist the session on disk */
  persistSession: boolean;
}

/** Runtime metadata surfaced by the native Claude SDK. */
export interface SessionMetadata {
  sessionId?: string;
  model?: string;
  permissionMode?: PermissionMode;
  cwd?: string;
  tools?: string[];
  slashCommands?: string[];
  skills?: string[];
  plugins?: Array<{ name: string; path: string }>;
  mcpServers?: Array<{ name: string; status: string }>;
  apiKeySource?: ApiKeySource;
  claudeCodeVersion?: string;
  outputStyle?: string;
  status?: SDKStatus;
}

/**
 * Structural shape for a `panel` OutputEvent payload. The CLI renderer
 * (`src/cli/render.ts` `card()`) defines the strict `CardSpec` whose `kind`
 * is a literal-union; this interface is a structural subset so the agent
 * layer doesn't depend on CLI rendering types. CardSpec is assignable to
 * PanelSpec by construction.
 */
export interface PanelSpec {
  /** Visual category — narrowed by the renderer to `CardKind` at render time. */
  kind: string;
  /** Optional title shown as a chip in the panel header. */
  title?: string;
  /** Body content. Strings split on `\n`; arrays joined line-by-line. */
  body: string | string[];
}

/** Output stream event types */
export type OutputEvent =
  | { type: 'message'; message: Message }
  | { type: 'chunk'; chunk: MessageChunk }
  | { type: 'error'; error: Error }
  | { type: 'done'; metadata?: ResponseMetadata }
  // Lane D additions — richer streaming surfaces gated by
  // Options.agentProgressSummaries / Options.includePartialMessages /
  // Options.promptSuggestions. Consumers can ignore these and keep
  // receiving the legacy events unchanged.
  | { type: 'progress'; progress: ProgressEvent }
  | { type: 'suggestion'; suggestion: string }
  // Mid-stream retry marker (anthropic-direct overload re-drive). Surfaces
  // that accumulate streamed content deltas reset their current-round buffer
  // on this event so the re-streamed text does not visibly duplicate. See
  // ProviderEvent 'stream.retry' for the full contract.
  | { type: 'stream_retry' }
  // Skill-emitted panel/card payload. Skills call `emitCard(spec)` from
  // `src/skills/_lib/emit-card.ts`; the renderer flushes pending content
  // and renders via `card(spec)` from `src/cli/render.ts`.
  | { type: 'panel'; spec: PanelSpec }
  // Usage-limit pause/resume events emitted by the provider layer when an
  // OAuth subscription limit is hit and the provider is waiting to auto-resume.
  | {
      type: 'paused';
      reason: 'usage-limit';
      resetsAt?: Date;
      accountId?: string;
      /**
       * Mirror of {@link import('../provider.js').ProviderEvent.paused.autoResume} —
       * whether the provider will auto-wait + replay the turn (true) or surface
       * an error next (false). UI layers use this to choose between
       * "no need to retype" and "send the message again" copy.
       */
      autoResume?: boolean;
    }
  | {
      type: 'resumed';
      hotSwapped: boolean;
      accountId?: string;
    };

/** Summary of in-flight subagent / task progress, emitted by the SDK. */
export interface ProgressEvent {
  taskId: string;
  description: string;
  summary?: string;
  lastToolName?: string;
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

/** Metadata for routing progress events to a subagent sink. */
export interface SubagentProgressMeta {
  subagentId: string;
  parentId?: string;
  agentType?: string;
}

/** Ambient sink function for subagent progress streaming. */
export type SubagentProgressSink = (
  event: OutputEvent,
  meta: SubagentProgressMeta,
) => void;

/** Result of a rewindFiles operation (SDK type). */
export interface RewindFilesResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}

/** Agent SDK wrapper instance interface */
export interface IAgentSession {
  readonly state: SessionState;
  readonly sessionId?: string;
  /**
   * The session's configured working directory, if any. Mirrors
   * {@link AgentConfig.cwd} for callers that need to inherit it (e.g.
   * forking subagents that must share the parent's worktree). `undefined`
   * means "use the Node host's `process.cwd()`".
   */
  readonly cwd?: string;

  /**
   * The session's lifecycle hook registry, if any. Exposed so a
   * {@link SubagentManager} can resolve the registry to dispatch
   * SubagentStart/SubagentStop against (and thread into forked children) from
   * the forking *parent* at fork time — the production wiring path, since the
   * registry is typically constructed after the manager. `undefined` when the
   * session runs without hooks (e.g. tests, bare harnesses).
   */
  readonly hookRegistry?: HookRegistry;

  sendMessage(content: string, options?: SendMessageOptions): Promise<Message>;
  sendMessageStream(content: string | ContentBlockParam[]): AsyncIterable<OutputEvent>;

  /**
   * Send a message and return its assistant response parsed against a Zod
   * schema. Extracts a JSON payload from the reply (last fenced ```json block
   * or last balanced object) and validates it; on mismatch, re-prompts the
   * model with the validation error up to `maxRetries` times (default 2)
   * before throwing. Mirrors the Claude Agent SDK's `outputFormat:
   * json_schema`. Composes `sendMessage` turns — no streaming-path changes.
   *
   * Optional (`?`) so adding it does not break external implementers of
   * `IAgentSession`. `AgentSession` always implements it; the library
   * `query()`/`queryStructured()` path calls it on the concrete class, never
   * through this interface.
   */
  sendMessageStructured?<T>(
    content: string,
    schema: ZodType<T>,
    options?: StructuredMessageOptions,
  ): Promise<T>;

  interrupt(): Promise<void>;

  /**
   * Tear down the SDK conversation and rebuild it from the same config.
   * Used by `/clear` so the model genuinely loses prior-turn context —
   * forwarding the literal string `/clear` to a provider does not.
   */
  reset(): Promise<void>;

  /**
   * Internal abort signal. Fires when {@link IAgentSession.interrupt} is called,
   * when the external `abortSignal` fires, or when a turn times out.
   */
  readonly abortSignal: AbortSignal;

  /**
   * Pre-abort the session with a caller-supplied reason BEFORE calling
   * {@link IAgentSession.close}. Signal handlers (SIGINT/SIGTERM/SIGHUP)
   * and other external-teardown surfaces use this so `deriveClosureReason`
   * sees a non-'closed' reason and the trace records reason='abort'
   * instead of misclassifying user interrupts as 'model_end_turn'.
   *
   * Contract: `reason` must NOT be 'closed' (reserved for the internal
   * close() path) and must NOT start with 'Budget ' or contain 'timed out'
   * (reserved for budget/timeout classification). Violations throw.
   * Idempotent: a no-op once the signal is already aborted.
   */
  abort(reason: string): void;

  setModel(model?: AgentModelInput): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;

  /**
   * Return and CLEAR any implement-turn queued by an approved `exit_plan_mode`
   * tool call. Atomically applies the deferred permission-mode flip (closing the
   * mid-turn TOCTOU window) then returns BOTH the seed message AND the mode it
   * flipped to. The REPL drains this post-turn: it mirrors `mode` onto
   * `stats.permissionMode` (the value the plan-mode gate and prompt read — see
   * #495) and auto-submits `message` as a fresh user turn (reproducing
   * `/plan off`'s save-and-implement handoff). Returns `undefined` when nothing
   * is pending (or when the deferred flip rejected and the seed was dropped).
   */
  takePendingPlanExitSeed(): Promise<{ message: string; mode: PermissionMode } | undefined>;

  waitForInitialization(): Promise<SessionMetadata>;

  getSessionIdentity(): SessionIdentity;
  getSessionMetadata(): SessionMetadata;
  /**
   * Get the provider-neutral session handle. The shape is consistent across
   * Anthropic and OpenAI Codex backends; consumers that need provider-specific
   * escape hatches (e.g. the Anthropic SDK's `reloadPlugins()`) cast the
   * returned object at the call site.
   */
  getQuery(): ProviderQuery;
  getLastResponseMetadata(): ResponseMetadata | null;
  getOutputStream(): AsyncIterable<OutputEvent>;

  /**
   * Get a narrow reference to the session's input channels.
   *
   * `pushUserMessage` starts a standalone turn (live steering);
   * `queueFrameworkContext` holds hook-generated context (SubagentStop
   * `injectContext`) to be prepended to the next real user message so it can
   * never displace one. See `InputStreamRef` for the full contract.
   */
  getInputStreamRef(): Pick<InputStreamRef, 'pushUserMessage' | 'queueFrameworkContext'>;

  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  supportedAgents(): Promise<AgentInfo[]>;
  getContextUsage(): Promise<SDKControlGetContextUsageResponse>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  accountInfo(): Promise<AccountInfo>;

  /** Rewind files to a prior user message (when file checkpointing is enabled). */
  rewindFiles?(
    userMessageId: string,
    options?: { dryRun?: boolean }
  ): Promise<RewindFilesResult>;

  /**
   * Compact older history into a synthetic preamble. Providers that don't
   * support compaction (e.g. Codex) return `{ compacted: false, reason:
   * 'not-supported' }` instead of throwing.
   */
  compact(): Promise<ProviderCompactResult>;

  close(): Promise<void>;
}
