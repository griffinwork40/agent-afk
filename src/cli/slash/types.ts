/**
 * Type contracts for the interactive slash-command registry.
 *
 * The registry is a dispatcher: it receives a `/command args...` string,
 * resolves it to a `SlashCommand`, and calls the handler with the live
 * REPL context. Handlers return a `SlashResult` telling the REPL whether
 * to keep looping, exit, or re-run another command.
 */

import type { SessionRef } from '../../agent/session-ref.js';
import type { ElicitationHandler } from '../../agent/elicitation-router.js';
import type { AgentModelInput } from '../../agent/types.js';
import type { TraceActor } from '../../agent/session/session-identity.js';
import type { PermissionMode } from '../../agent/types/sdk-types.js';
import type { TrustedSkillLedger } from '../trusted-skill-ledger.js';
import type { ImageAttachment } from '../input/attachments.js';
import type { ResolvedResumeTarget } from '../resume-session.js';

/**
 * Result of a mid-session resume swap attempt.
 * Defined here (neutral slash-layer) to avoid the upward import that
 * previously pointed slash/types.ts → commands/interactive/shared.ts.
 * `commands/interactive/shared.ts` re-exports this for backward compat.
 */
export type ResumeSwapResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: string };

/** A recorded tool invocation within a turn — persisted for post-mortem diagnosis. */
export interface ToolEvent {
  toolName: string;
  toolUseId: string;
  input: string;
  /** Raw JSON-serialized tool input object — populated for facet derivation (exact field extraction). */
  inputRaw?: string;
  result?: string;
  isError?: boolean;
}

/** A single stored user/assistant exchange — used by /history and /save. */
export interface TurnRecord {
  user: string;
  assistant: string;
  timestamp: number;
  costUsd?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  toolEvents?: ToolEvent[];
}

/** Mutable session-wide counters displayed in the status line and /cost. */
export interface SessionStats {
  totalTurns: number;
  totalCostUsd: number;
  totalTokens: number;
  totalDurationMs: number;
  sessionStartTime: number;
  /** Per-turn cost history, in order. */
  turnCosts: number[];
  /**
   * Per-turn token history, in order. `input`/`output`/`cache` are the
   * last-round per-field counts; `footprint` (when present) is the
   * provider-computed context-window occupancy for that turn — the
   * authoritative "how full is the window" value, preferred over
   * input+output+cache (which mixes cumulative input with last-round cache).
   */
  turnTokens: Array<{ input: number; output: number; cache: number; footprint?: number }>;
  /** Full turn records (user + assistant pair) for /history and /save. */
  turns: TurnRecord[];
  /**
   * Current active model. Holds the exact string the user supplied (short
   * alias, full Claude ID, or proxy keyword like `auto`). `/model` mid-session
   * switches still validate against the short-alias allow-list, but the
   * initial session may carry any string the SDK/proxy accepts.
   */
  model: AgentModelInput;
  /**
   * Current REPL permission mode — the single source of truth the prompt
   * marker, status line, and the plan/AFK gate getters all read. `'plan'`
   * gates writes (plan mode); `'autonomous'` is AFK mode (the operator is away
   * — autonomous work + Telegram reporting, with a high-risk gate); `'default'`
   * is normal interactive operation. Mutually exclusive by construction (one
   * field), which is why AFK is not a separate boolean alongside plan.
   */
  permissionMode: PermissionMode;
  /** SDK session ID once initialized. Populated from ResponseMetadata. */
  sessionId?: string;
  /**
   * Human-readable session name (kebab-case slug). Auto-derived from the
   * first user message by `recordTurn`, or set explicitly via `/name` (or
   * `/save <name>`). Persisted as metadata on the <sessionId>.json sidecar —
   * never used as the filename — so `/resume` can show it instead of a UUID
   * and `--resume <name>` / `/resume <name>` can resolve by it.
   */
  name?: string;
  /**
   * Effective working directory for the session — the `cwd` passed to the
   * provider, or `process.cwd()` when none was overridden (e.g. `--worktree`
   * supplies an override). Captured at bootstrap and treated as immutable
   * for the lifetime of the session; rendered on the status line so the
   * user always sees which directory their tools are operating in.
   */
  cwd?: string;
  /**
   * Origin surface of the session. Persisted to the shared session store so a
   * resumer can tell where a session came from. Undefined is treated as 'cli'
   * (the default surface); the Telegram bot sets 'telegram' so CLI `/resume`
   * can flag and resume conversations that started in chat; the daemon sets
   * 'daemon'.
   */
  source?: 'cli' | 'telegram' | 'daemon';
  /**
   * Telegram chat id, set only when `source === 'telegram'`. Enables reverse
   * lookup from a stored session back to its chat (used by later phases).
   */
  telegramChatId?: number;
  /**
   * Execution role of the session ('main' | 'subagent'), persisted to the
   * shared session store for uniform session-identity telemetry. Sidecars are
   * only written for top-level sessions, so this is 'main' when set; left
   * optional/absent on legacy and un-threaded callers.
   */
  actor?: TraceActor;
}

/** Minimal console writer passed to handlers — thin wrapper around chalk output. */
export interface Writer {
  line(text?: string): void;
  raw(text: string): void;
  success(text: string): void;
  info(text: string): void;
  warn(text: string): void;
  error(text: string): void;
}

/** UI surface handlers can poke without reaching into readline internals. */
export interface UiSurface {
  clearScreen(): void;
  repaintStatusLine(): void;
}

/** What the handler sees when invoked. */
export interface SlashContext {
  session: SessionRef;
  stats: SessionStats;
  out: Writer;
  ui: UiSurface;
  ledger?: TrustedSkillLedger;
  /**
   * Atomically swap the active session for a stored one. See
   * `InteractiveCtx.requestResume` for full semantics. Absent in contexts
   * that do not support mid-session swap (e.g. Telegram, daemon).
   */
  requestResume?: (target: ResolvedResumeTarget) => Promise<ResumeSwapResult>;
  /**
   * MCP manager — exposes `completeAuth()` so `/mcp auth complete` can
   * deliver an OAuth authorization code to a pending server. Optional:
   * absent in Telegram / daemon surfaces that do not bootstrap an
   * `McpManager`.
   */
  mcpManager?: import('../../agent/mcp/index.js').McpManager;
  /**
   * Borrow accessor for the REPL's persistent TerminalCompositor (Stage
   * 3e). Slash handlers that construct their own `StreamRenderer` — e.g.
   * built-in TS skills dispatched via `makeImmediateHandler` — must pass
   * the returned compositor as `StreamRenderer.options.compositor` so the
   * renderer takes the borrow path (no second compositor / second
   * `createLogUpdate` on the same stdout).
   *
   * Wired in `repl-loop.ts` after `surface.armCompositor()` runs.
   * Returns null on non-TTY surfaces (Telegram, daemon, tests) or before
   * arm completes — callers MUST tolerate null and fall back to the
   * own-compositor path. Absent (`undefined`) on contexts that never arm
   * a persistent compositor at all (e.g. Telegram, daemon's slash
   * dispatcher).
   *
   * Symmetry: mirrors the `TurnHandles.getCompositor` field consumed by
   * `runTurn` (see commands/interactive/shared.ts) — same shape, same
   * borrow contract, same null semantics.
   */
  getCompositor?: () => import('../terminal-compositor.js').TerminalCompositor | null;
  /**
   * Install or clear the ESC soft-stop handler on the surface's
   * persistent compositor. Per-skill-dispatch — `runSkillDispatchTurn`
   * sets a closure that flips its `softStopRequested` flag at dispatch
   * start and clears with `null` in finally so ESC between dispatches
   * is a no-op.
   *
   * Symmetry: mirrors the `TurnHandles.setSoftStopHandler` field
   * consumed by `runTurn` — same shape, same wiring, same null
   * semantics. Absent (`undefined`) on contexts that never arm a
   * persistent compositor (Telegram, daemon's slash dispatcher).
   */
  setSoftStopHandler?: (handler: (() => void) | null) => void;
  /**
   * Fired whenever the loop stage transitions (Observe → Model → Choose →
   * Act → Update) during a skill-dispatch turn. Carries the new stage name.
   *
   * Symmetry: mirrors the `TurnHandles.onStageChange` field consumed by
   * `runTurn` — same shape, same wiring (REPL → `LoopStageBar.repaint`).
   * Threaded into the skill renderer by `createSkillRenderer` so the
   * footer stage rail advances during `/skill` turns exactly as it does
   * during normal turns. Absent (`undefined`) on non-TTY surfaces
   * (Telegram, daemon) — the renderer treats this as a no-op.
   */
  onStageChange?: (stage: import('../commands/interactive/loop-stage.js').LoopStage) => void;
  /**
   * Fired mid-turn on tool_result events during a skill-dispatch turn so
   * the REPL can refresh the context sampler and repaint the status line
   * with live context usage.
   *
   * Symmetry: mirrors the `TurnHandles.onContextProgress` field consumed
   * by `runTurn` — same shape, same throttle expectation (the dispatcher
   * throttles internally; callers need not debounce). Best-effort: errors
   * are swallowed by the caller. Absent on non-interactive surfaces.
   */
  onContextProgress?: () => void | Promise<void>;
  /**
   * Session transcript sink. `runSkillDispatchTurn` appends the completed
   * skill exchange (`/<skill> <args>` → final assistant text) so skill
   * turns survive into the autosaved markdown transcript exactly like
   * normal turns (which append via `repl-loop.ts`'s `onTurnComplete`).
   *
   * Structural subset of `TranscriptHandle` (commands/interactive/
   * transcript.ts) — declared inline to keep this neutral slash-layer
   * module free of an upward import. Absent on surfaces without a
   * transcript (Telegram, daemon, tests).
   */
  transcript?: {
    appendTurn(userInput: string, assistantText: string): Promise<void>;
    /**
     * Optional immediate user-message write (TranscriptHandle.appendUser).
     * When present, `runSkillDispatchTurn` persists `/<skill> <args>` at
     * dispatch start so an interrupted skill turn still leaves the user's
     * invocation in the transcript.
     */
    appendUser?(userInput: string): Promise<void>;
  };
  /**
   * AFK bidirectional Telegram (scope.lock criterion 1). Swap the active
   * elicitation handler: a non-null handler is installed (the AFK ledger
   * channel, which races a watching daemon's phone reply against the keyboard);
   * `null` restores the surface's default stdin handler. Wired in
   * `surface-setup.ts` after the router install. Absent on surfaces without a
   * swappable router (Telegram, daemon, tests) — `toggleAfkMode` no-ops the
   * swap when absent (keyboard stays live; channel is additive, invariant #3).
   */
  swapElicitationHandler?: (handler: ElicitationHandler | null) => void;
  /**
   * The surface's default stdin elicitation handler — exposed so the AFK
   * ledger channel can compose it as its always-live keyboard fallback
   * (invariant #3). Wired alongside `swapElicitationHandler`; absent on
   * surfaces that never install a stdin handler.
   */
  stdinElicitationHandler?: ElicitationHandler;
}

/** The handler's return value — controls the REPL's next action. */
export type SlashResult =
  | 'continue'   // keep the REPL running
  | 'exit'       // tear down and quit
  | 'forward'    // forward the original input to the SDK as a regular turn
                 // (used by plugin-skill passthrough handlers — the SDK's
                 // subprocess natively parses `/<skill>` as an invocation)
  | { rerun: string }   // dispatch another command (e.g. /help after unknown)
  | { kind: 'submit'; message: string };  // pre-fill prompt and auto-submit

/** A registered slash command. */
export interface SlashCommand {
  /** Canonical name, including leading slash, e.g. "/cost". */
  name: string;
  /** Optional aliases, each with leading slash. */
  aliases?: string[];
  /** One-line description shown in /help. */
  summary: string;
  /** Optional usage string, e.g. "/model <name>". */
  usage?: string;
  /**
   * Optional "when to reach for this" guidance shown as a tooltip row beneath
   * the autocomplete dropdown when this command is the selected candidate.
   * Longer than `summary` — typically one sentence answering "when should I
   * use this?". Built-in skills auto-populate this from `whenToUse`; plugin
   * passthroughs harvest a "Use when…" sentence from the description.
   * Omitted commands simply render no tooltip — the row collapses cleanly.
   */
  hint?: string;
  /**
   * Long-form CLI flags this command accepts (e.g. `['--auto', '--ship', '--pr']`).
   * Populated for plugin-skill passthroughs by harvesting SKILL.md; lets the
   * REPL dropdown complete flags once a known skill name has been entered.
   * Empty or missing means no flag completion is offered.
   */
  flags?: readonly string[];
  /**
   * When true, image attachments the user has loaded are forwarded to this
   * command's handler as the third argument. Commands that do not opt in
   * (i.e. `acceptsAttachments !== true`) receive a named warning when the
   * user submits with attachments — the images are silently dropped.
   *
   * Only skill commands (makeImmediateHandler) set this to true; built-in
   * meta commands (/clear, /cost, etc.) do not consume images.
   */
  acceptsAttachments?: boolean;
  /**
   * Handler. `args` is the trimmed remainder after the command name.
   * Optional third param `_attachments` carries the user's image attachments
   * when `acceptsAttachments: true` is set on the command. Implementations
   * that do not consume images may omit this parameter — TypeScript's optional
   * trailing parameter rule makes existing 1- and 2-param handlers compatible.
   */
  handler(ctx: SlashContext, args: string, _attachments?: readonly ImageAttachment[]): Promise<SlashResult>;
}
