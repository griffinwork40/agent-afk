import * as readline from 'node:readline';
import { statSync } from 'node:fs';
import type { HookRegistry } from '../../../agent/hooks.js';
import type { SessionRef } from '../../../agent/session-ref.js';
import type { MemoryStore } from '../../../agent/memory/index.js';
import type { AgentModelInput } from '../../../agent/types.js';
import type { BackgroundAgentRegistry } from '../../../agent/background-registry.js';
import type { BackgroundSummarizer } from '../../../agent/background-summarizer.js';
import type { SubagentControl } from '../../../agent/tools/subagent-executor.js';
import type { SlashContext, SessionStats, ResumeSwapResult, ThinkingUiMode } from '../../slash/types.js';
import type { StoredSession } from '../../session-store.js';
import type { StatusLine } from '../../status-line.js';
import type { ReplRenderer } from './repl-renderer.js';
import type { ResolvedResumeTarget } from '../../resume-session.js';
import { contextLimitFor } from '../../model-limits.js';
import { ContextSampler } from '../../context-sampler.js';
import type { GitStatusSampler } from '../../git-status-sampler.js';
import { formatTurnSparkline } from '../../context-sparkline.js';
import { palette } from '../../palette.js';

/**
 * Result of a mid-session resume swap attempt.
 * Canonical definition lives in `slash/types.ts` (neutral layer).
 * Re-exported here so existing imports from this module continue to work.
 */
export type { ResumeSwapResult } from '../../slash/types.js';

/**
 * Hydrate `stats` from a `StoredSession` payload. Extracted as a shared
 * helper to keep `bootstrap.ts` (initial load) and `resume-swap.ts`
 * (mid-session swap) in sync — divergence caused bootstrap to miss
 * `stats.model` while swap set it, and neither set `stats.sessionStartTime`
 * consistently.
 *
 * Callers own any fields that are NOT derived from the stored payload
 * (e.g. `cwd`, `permissionMode`, `turnCosts`, `turnTokens` on initial bootstrap
 * may be managed differently).
 */
export function reseedStatsFromStored(
  stats: SessionStats,
  stored: StoredSession,
  resumeId: string,
): void {
  stats.totalTurns = stored.totalTurns;
  stats.totalCostUsd = stored.totalCostUsd;
  stats.totalTokens = stored.totalTokens;
  stats.totalDurationMs = stored.totalDurationMs;
  stats.turns = [...stored.turns];
  stats.sessionId = stored.sessionId ?? resumeId;
  stats.name = stored.name;
  stats.model = stored.model;
  // External constraint: legacy stored sessions saved before `startedAt`
  // was added lack the field, deserializing as undefined despite the type.
  // Default to now so the status-line duration is 0, not NaN.
  stats.sessionStartTime = stored.startedAt ?? Date.now();
}

/**
 * True iff `p` exists AND is a directory. A stored cwd that resolved to a
 * regular file (or a broken symlink) must NOT be used as a working directory,
 * so we stat rather than existsSync. Any stat error (ENOENT, EACCES, race)
 * degrades to false, so the caller falls back to process.cwd().
 */
function isExistingDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the effective working directory for a (possibly resumed) interactive
 * session. Precedence:
 *   1. An explicit `--worktree` override (`extrasCwd`) ALWAYS wins.
 *   2. Otherwise, fall back to the resumed session's stored cwd — but ONLY when
 *      it still exists on disk as a directory. A resumed session should run in
 *      the directory it was saved in (e.g. an `afk --worktree` session later
 *      `/fork`'d or `--resume`'d), not wherever the shell happens to be. A
 *      cleaned-up worktree degrades safely (the stored cwd is ignored, caller
 *      falls back to `process.cwd()`).
 *
 * Returns `undefined` when neither source applies, so callers keep their
 * existing `?? process.cwd()` fallback. Because it defaults to `extrasCwd` when
 * there is no resume override, this is a safe drop-in — behavior only changes
 * for a resume whose stored cwd still exists.
 *
 * Extracted as a pure helper (rather than inlined in bootstrap) so the
 * precedence contract is unit-testable in isolation from the heavy session
 * construction path.
 */
export function resolveResumeCwd(
  extrasCwd: string | undefined,
  storedCwd: string | undefined,
): string | undefined {
  if (extrasCwd !== undefined) return extrasCwd;
  if (storedCwd !== undefined && isExistingDir(storedCwd)) return storedCwd;
  return undefined;
}

/**
 * Print a 2–3 line "where was I" cue immediately after the resume banner,
 * surfacing the LAST stored turn (user message + first sentence of the
 * assistant reply) so a human reorienting in a wiped terminal has context
 * to anchor on. Always closes with a pointer to `/history` for full
 * review — that command owns the real replay machinery.
 *
 * Deliberately NOT a turn replay loop. A full replay would:
 *   (a) flood scrollback on long sessions (no size cap on stats.turns),
 *   (b) risk writing unsanitized ANSI/cursor-control sequences from
 *       prior tool output (ToolEvent.input/.result are raw SDK strings),
 *   (c) require correct ordering against the ReplRenderer compositor's
 *       arm/disarm lifecycle.
 * The banner sidesteps all three: bounded output, aggressive flattening,
 * and routing through the caller-supplied writer so each callsite picks
 * the right transport for its compositor state.
 *
 * Writer transport: caller passes `CompletionWriter` (mutable). At
 * bootstrap the writer is `console.log` (compositor not yet armed); at
 * mid-session /resume swap the writer is `compositor.commitAbove` (the
 * persistent compositor is armed). Reading `.fn` lazily on each line
 * means a swap mid-banner would still route correctly, though the
 * banner runs synchronously so this is purely defensive.
 *
 * Best-effort: returns silently when `stats.turns` is empty (legacy
 * sidecars from before turn-record persistence, or stored sessions
 * with totalTurns > 0 but turns: []).
 */
export function printResumeBanner(stats: SessionStats, writer: CompletionWriter): void {
  const turns = stats.turns;
  if (turns.length === 0) return;

  // noUncheckedIndexedAccess: length>0 guarantees the access, but TS
  // doesn't narrow, so guard explicitly.
  const last = turns[turns.length - 1];
  if (!last) return;

  // Ordered pipeline (external constraint: each stage assumes its input
  // is normalized by the prior stage):
  //   1. flatten — collapse whitespace + strip ANSI control bytes
  //   2. firstSentence — runs on flat text so newline-based sentence
  //      detection is unnecessary, and version numbers / file extensions
  //      (".ts", "v1.2") don't trip the terminator lookahead
  //   3. truncate — hard upper bound regardless of upstream accuracy
  const userSnippet = truncate(flatten(last.user), 80);
  const assistantSnippet = truncate(firstSentence(flatten(last.assistant)), 120);

  if (userSnippet.length > 0) {
    writer.fn(palette.dim(`  Last: ${userSnippet}`));
  }
  if (assistantSnippet.length > 0) {
    writer.fn(palette.dim(`  ↳ ${assistantSnippet}`));
  }
  writer.fn(palette.dim('  ↪ /history for full review'));
}

/**
 * Flatten whitespace + strip ANSI escape sequences. Both steps are
 * load-bearing:
 *
 *   - Whitespace flattening prevents stored multi-line assistant replies
 *     from spilling the banner into a wall of text. It also normalizes
 *     the input for downstream sentence detection — newline handling
 *     in `firstSentence` becomes unnecessary once flattened.
 *   - ANSI stripping defends against prior tool output (bash, etc.) that
 *     was stored verbatim with cursor-control sequences. Replaying those
 *     raw via writer.fn would corrupt terminal state — applying
 *     `palette.dim` styling AFTER stripping is safe because dim wraps
 *     the sanitized content, not raw bytes.
 *
 * The ANSI regex covers four escape categories that can land in stored
 * turn text (e.g., when the model echoes colorized tool output verbatim
 * in its reply):
 *   1. OSC sequences (incl. OSC 8 hyperlinks):    `ESC ] ... ST`
 *   2. DCS / SOS / PM / APC string sequences:     `ESC P|X|^|_ ... ST`
 *   3. Fe single-char escapes (cursor save/restore, index, etc.):
 *      `ESC <byte 0x40–0x5F excluding [, ], P, X, ^, _>` plus `ESC 6/7/8/9`
 *      and `ESC =` (DECKPAM). The exclusion list keeps this from
 *      consuming the opener of string-family sequences above.
 *   4. CSI sequences, 7-bit (`ESC [ params final`) and 8-bit C1
 *      (`0x9B params final`).
 *
 * Alternation order is load-bearing: the string-family openers (OSC, DCS)
 * must precede CSI because the CSI alternative is loose — it can match
 * `ESC <digit> <letter>` and would otherwise greedily eat into a
 * Fe escape like `ESC 7 s a v e d`. Likewise the Fe alternative must
 * come before CSI so `ESC 7` doesn't get misparsed as a digit-parameter
 * CSI. Mirrors the strategy of `strip-ansi` / `ansi-regex` (npm) with
 * extra coverage for Fe `ESC 7/8` and DCS — both of which the published
 * `ansi-regex@6` still misses. We inline the pattern (rather than depend
 * on `strip-ansi`) because the input is bounded to one banner line and
 * the additional alternatives are short.
 */
function flatten(s: string): string {
  // Order matters: strip ANSI first so any whitespace that surrounded a
  // stripped escape gets collapsed by the subsequent whitespace pass.
  // Reversing this order leaves "before \x1bM after" as "before  after"
  // (double space) because the whitespace pass sees ESC-M as non-space
  // and can't merge across it.
  const stripped = s.replace(ANSI_STRIP_RE, '');
  return stripped.replace(/\s+/g, ' ').trim();
}

// eslint-disable-next-line no-control-regex
const ANSI_STRIP_RE = /\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C)|\u001B[PX^_][\s\S]*?(?:\u0007|\u001B\\|\u009C)|\u001B[@-OQ-WY-Z\\`6-9=]|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

/**
 * Return the first sentence of `s` (through the first `.`, `!`, or `?`
 * followed by whitespace or end-of-string), or the whole string when no
 * terminator is found.
 *
 * Two load-bearing constraints, both encoded as lookarounds:
 *
 *   - Negative lookbehind `(?<![A-Za-z]\.[A-Za-z])` — skips the
 *     terminator when it sits inside a letter-dot-letter abbreviation
 *     like `e.g.` or `i.e.`. Without this, the regex used to stop at
 *     "Use e.g." mid-prose. The pattern only matches abbreviations of
 *     the form `letter.letter` immediately before the terminator, so
 *     numeric tokens ("3.14", "v1.2") aren't shielded — they still
 *     terminate the sentence, which is the desired behavior for stored
 *     content that happens to embed version numbers.
 *
 *   - Positive lookahead `(?=\s|$)` — prevents stopping mid-token at
 *     dots inside file extensions ("middleware.ts") and abbreviations
 *     not followed by whitespace ("e.g.something").
 *
 * Caller MUST flatten first — newline handling is intentionally absent
 * because flattening eliminates them upstream.
 */
function firstSentence(s: string): string {
  const m = s.match(/^.*?(?<![A-Za-z]\.[A-Za-z])[.!?](?=\s|$)/);
  return m ? m[0] : s;
}

/**
 * Hard-truncate `s` to `max` Unicode code points, replacing the tail
 * with `…` when truncation occurs. The ellipsis counts toward the max
 * so the returned string is always at most `max` code points wide.
 *
 * Iterates via `[...s]` (string iterator) rather than `s.slice(...)`
 * (UTF-16 code units) so emoji and other non-BMP characters aren't
 * split across a surrogate pair — slicing inside a surrogate pair
 * produces a malformed string with a lone surrogate, which most
 * terminals render as the replacement character (U+FFFD). The
 * iterator yields each code point as a single array element regardless
 * of UTF-16 width.
 *
 * Note: this is code-point-correct but NOT grapheme-cluster-correct.
 * Combining marks (`a\u0301` → `á`) and ZWJ emoji sequences
 * (`👨‍👩‍👧‍👦`) can still split mid-cluster. That would require
 * `Intl.Segmenter` — overkill for a bounded banner snippet.
 */
function truncate(s: string, max: number): string {
  const codePoints = [...s];
  if (codePoints.length <= max) return s;
  return codePoints.slice(0, max - 1).join('') + '…';
}

/**
 * Canonical definition lives in `slash/types.ts` (neutral layer) to avoid the
 * upward import that would result from defining it here. Re-exported for
 * backward compat — existing imports from this module continue to work.
 */
export type { ThinkingUiMode } from '../../slash/types.js';

export interface CliOptions {
  /**
   * Model argument from `-m, --model`. Short aliases (opus/sonnet/haiku/…)
   * expand at session-build time; unknown strings (e.g. `auto`, full
   * `claude-*` IDs) pass through so the value the SDK/proxy sees is exactly
   * what the user typed.
   */
  model: AgentModelInput;
  maxTurns: string;
  thinking?: string;
  /**
   * `--thinking-ui` display mode. Optional at the CLI layer: the Commander
   * option carries no static default, so this is `undefined` until the action
   * handler resolves the flag > `AFK_THINKING_UI` env > `interactive.thinkingUi`
   * config > `'live'` precedence (see `resolveThinkingUi`) and assigns it back.
   */
  thinkingUi?: ThinkingUiMode;
  effort?: string;
  maxOutputTokens?: string;
  resume?: string;
  continue?: boolean;
  debug?: boolean;
  /**
   * `--dangerously-skip-permissions` — start the session in `'bypassPermissions'`
   * (skip path-approval prompts; read/write anywhere). Toggle live with Shift+Tab
   * (the permission-mode cycle: default → plan → bypass).
   */
  dangerouslySkipPermissions?: boolean;
  /**
   * `--worktree [branch]` flag. `true` when the flag was passed without a value
   * (auto-named branch). String when the user supplied a branch name.
   * `undefined` when the flag was not passed.
   */
  worktree?: string | true;
  /**
   * Commander emits `worktreeAutoname: false` when `--no-worktree-autoname`
   * is passed and leaves it `true` (or undefined, which is treated as true)
   * otherwise. Only consulted when `worktree === true` — explicit branch
   * names already opt out of auto-naming by definition.
   */
  worktreeAutoname?: boolean;
  /**
   * `--worktree-base <ref>` — override the base git ref for the new worktree
   * (e.g. `origin/main`, a tag, or a SHA). Remote-tracking refs are fetched
   * before creation. Falls back to `AFK_WORKTREE_BASE`, then
   * `interactive.worktreeBase`. When none is set, AFK defaults to the remote's
   * default branch (origin/main); pass `HEAD` to base on the local checkout.
   */
  worktreeBase?: string;
  /**
   * Commander emits `shellPassthrough: false` when `--no-shell-passthrough`
   * is passed. When false, `!text` is NOT dispatched to the shell and falls
   * through to the model as literal input. Default: true (shell passthrough
   * enabled). Also: AFK_SHELL_PASSTHROUGH=0.
   */
  shellPassthrough?: boolean;
  provider?: string;
  /** `--dump-prompt [path]` — activates AFK_DUMP_PROMPT for this session. */
  dumpPrompt?: string | boolean;
  /**
   * `--mcp-config <path>` — explicit path to an MCP config file that is
   * merged at highest priority over plugin / user-global / project-local
   * layers. The file format is identical to `~/.afk/config/mcp.json`.
   */
  mcpConfig?: string;
}

/**
 * Shared-state bundle produced by `bootstrapSession`. Members marked mutable
 * are owned by the REPL lifecycle: `stats` is updated every turn by
 * `recordTurn`; `statusLine` repaints on demand. Callers must re-read these
 * through the bundle rather than caching derived values.
 */
export interface InteractiveCtx {
  session: SessionRef;
  memoryStore: MemoryStore;
  stats: SessionStats;          // mutable across turns
  statusLine: StatusLine;        // mutable — owns terminal side-effects
  contextSampler: ContextSampler; // mutable — cached SDK calls
  gitStatusSampler: GitStatusSampler; // mutable — cached git branch + PR for the status line
  completionWriter: CompletionWriter;
  replRenderer: ReplRenderer;
  slashCtx: SlashContext;
  rl: readline.Interface;
  options: CliOptions;
  resumeTarget?: ResolvedResumeTarget;
  teardownTrustedSkillEvents?: () => void;
  /**
   * MCP manager — owns connections to every server in `~/.afk/config/mcp.json`.
   * Lifetime is tied to the REPL session: connected at bootstrap, disconnected
   * by the teardown path in `interactive.ts`. Subagents share this reference
   * (never reconstructed per fork), matching the `hookRegistry` pattern.
   *
   * Absent when no MCP config file exists or every server is `disabled`.
   */
  mcpManager?: import('../../../agent/mcp/index.js').McpManager;
  /**
   * Registry of background subagent jobs spawned by the `agent` tool with
   * `mode: "background"`. The teardown path calls `cancelAll()` so detached
   * jobs do not outlive the parent process — see `interactive.ts`.
   */
  backgroundRegistry: BackgroundAgentRegistry;
  /**
   * Narrow control seam over the root `SubagentExecutor` for user-triggered
   * promotion of a running foreground subagent to a detached background job
   * (Ctrl+B). The turn handler reads this off the handles bag to make Ctrl+B
   * context-sensitive: promote the in-flight subagent if one is running, else
   * fall back to backgrounding the whole turn. Injected by bootstrap (the
   * composition root); the keyboard layer depends only on the `SubagentControl`
   * interface, never on `SubagentExecutor` internals or `SubagentHandle`.
   */
  subagentControl?: SubagentControl;
  /**
   * Optional background summarizer. Constructed only when `bgSummaries: true`
   * in afk.config.json. The teardown path calls `stop()` before
   * `backgroundRegistry.cancelAll()` so in-flight Haiku calls are aborted
   * cleanly.
   */
  bgSummarizer?: BackgroundSummarizer;
  /**
   * Invoked by the REPL loop with the user's first non-slash message BEFORE
   * the first `runTurn`. Optional — when set, the hook owns whatever pre-
   * turn side effects the caller wants (worktree autorename, telemetry,
   * etc.). Failures are the hook's responsibility — the loop awaits but
   * never reacts to the resolved value.
   *
   * Single-fire by contract: the loop only invokes it on the first turn
   * (`stats.totalTurns === 0`).
   */
  firstTurnHook?: (firstMessage: string) => Promise<void>;
  /**
   * Optional first message seeded from the launch argument — set when the user
   * runs `afk "prompt"` or `afk /slash args` (the interactive command's
   * variadic `[input...]` positional). When present, the REPL loop promotes it
   * into its `seedBuffer` fast-path and auto-submits it as the opening turn,
   * echoed and dispatched exactly as if typed: a plain prompt runs a turn, a
   * `/command` routes through the slash dispatcher. Absent for a bare `afk`.
   */
  initialInput?: string;
  /**
   * Returns true while a turn is in flight. Set by `interactive.ts` after
   * building `turnState` so the swap closure can refuse mid-turn swaps.
   * Defaults to false when absent.
   */
  getInFlight?: () => boolean;
  /**
   * Atomically swap the active session for a stored one. Refuses while a
   * turn is in flight. Tears down the outgoing session, builds a new one,
   * mutates `session.current`, re-runs plugin passthrough registration,
   * hydrates stats from the stored payload, and prints the "Resuming…"
   * banner.
   *
   * Returns the new session id on success, or a string reason on refusal
   * (so the caller can render a user-facing message).
   */
  requestResume?: (target: ResolvedResumeTarget) => Promise<ResumeSwapResult>;
  /**
   * Reset the verdict ledger (terminal-state trajectory rail) on the
   * outgoing session. Owned by the REPL loop's closure; wired through here
   * so the resume swap can clear it via `onSwapped` without the swap
   * sequence needing to know about the ledger's internals. Optional — set
   * by `runReplLoop` after the ledger is created.
   */
  clearVerdictLedger?: () => void;
  /**
   * Drops any buffered background-subagent results (BgResultNotifier) so a
   * mid-session /resume swap can't leak the outgoing session's settled-job
   * injections into the resumed session's first turn. Same wiring pattern
   * as `clearVerdictLedger`: owned by the REPL loop's closure, set by
   * `setupFooterSubsystems`, invoked from the swap's `onSwapped` callback.
   */
  clearBgResultBuffer?: () => void;
  /**
  /**
   * Cursor row (1-based) at the moment `armCompositor` will be invoked,
   * computed by counting `
` writes made to stdout/stderr by the
   * pre-arm bootstrap block (welcome banner, update-notice, boot-prune
   * notice, etc.). Threaded through to the compositor's `anchorRow`
   * option so the live frame's CUP-positioned upward growth cannot
   * overwrite those rows — instead the frame evicts the deficit into
   * scrollback when it would otherwise climb above this row.
   *
   * Absent when no bootstrap printed anything before arm (daemon, tests).
   */
  preArmAnchorRow?: number;
  /**
   * Live reference to the armed InputSurface. Null until `runReplLoop`
   * arms the surface (after bootstrap). The elicitation handler closes
   * over this ref so it can call `suspendForElicitation()` /
   * `resumeAfterElicitation()` at invocation time even though the
   * surface does not exist yet at install time.
   *
   * Set by `runReplLoop` immediately after `armCompositor` succeeds.
   * Callers must check for null (non-TTY, daemon, tests).
   */
  inputSurfaceRef?: { current: import('../../input/input-surface.js').InputSurface | null };
  /**
   * Resolved API key used by the session's provider. Captured once at
   * bootstrap from `getApiKey()` — identical to the token the AgentSession
   * was constructed with. Threaded into the ghost-text suggest engine's
   * `getContext()` closure so Tier-2 LLM suggestions authenticate with
   * the same credential as the session (covers Anthropic key, OAuth/Claude
   * subscription, and OpenAI API key — whichever `getApiKey()` resolved).
   *
   * Absent in test stubs that do not exercise the suggestion path.
   */
  suggestApiKey?: string;
  /**
   * Resolved base URL for the session's provider, sourced from
   * `loadConfig().baseUrl`. Passed to the suggest engine so Tier-2 LLM
   * suggestions are routed to the same endpoint the session uses (local
   * MLX/OpenAI-compatible shims, custom proxies, etc.). `undefined` for
   * standard Anthropic API sessions — the engine's default endpoint applies.
   *
   * Absent in test stubs that do not exercise the suggestion path.
   */
  suggestBaseUrl?: string;
  /**
   * Resolved `interactive.suggestGhost` from `afk.config.json`.
   * `undefined` = not set (default-on). Read by `runReplLoop` via
   * `resolveSuggestGhost()`. Absent in test stubs that do not exercise
   * the ghost toggle.
   */
  suggestGhostConfig?: boolean;
  /**
   * Hook registry for dispatching harness lifecycle events from the REPL loop.
   * Absent in test stubs that do not exercise hooks. Set by bootstrap.ts from
   * `hookRegistryBundle.registry`. Fires UserPromptSubmit before each runTurn
   * call (enabling per-prompt policy hooks) and Stop after each completed turn.
   */
  hookRegistry?: HookRegistry;
}

/**
 * Mutable writer for subagent completion lines and between-turn slash
 * output (e.g. `/model` warnings via `ctx.out.warn` → `completionWriter`).
 *
 * Two slots:
 *   - `fn`     — the active sink. Swapped per-turn by the turn handler:
 *                defaults to `console.log`, becomes `compositor.commitAbove`
 *                while a turn is in flight (turn-handler.ts:135–144).
 *   - `idleFn` — the between-turn sink. Set once at REPL bootstrap by
 *                `runReplLoop` after `armCompositor` resolves (repl-loop.ts).
 *                For the borrowed/persistent compositor path (Stage 3e),
 *                this is `compositor.commitAbove`; for the legacy non-TTY
 *                or own-compositor path, it stays `console.log`.
 *
 * Invariant: `turn-handler.ts`'s finally block resets `fn := idleFn` after
 * every turn (NOT `console.log`). This is what keeps between-turn slash
 * output (e.g. `/model claude-opus-4-8` → "Unknown model" warning) routed
 * through the live compositor instead of writing raw at the input row's
 * current cursor position, which would otherwise overlay the warning onto
 * the just-echoed user input.
 */
export interface CompletionWriter {
  fn: (line: string) => void;
  idleFn: (line: string) => void;
  /**
   * Turn-scoped guard: when true, the REPL's SubagentStop-hook completion
   * line (`✓ <agentType> · <duration>` via {@link emitSubagentCompletion})
   * is dropped because a foreground turn's live overlay owns subagent
   * rendering — the ToolLane already commits the `→ Agent(…) Done` tree to
   * scrollback (Channel A). Emitting the compact line here (Channel B) would
   * double-render the node AND its uncoordinated `commitAbove` races the
   * OverlayComposer's `setOverlay`, corrupting the compositor's frame
   * row-accounting (ghost `◉` markers + swallowed committed lines).
   *
   * Set true by `turn-handler.ts`'s `armAndWire` (only when a compositor is
   * armed — TTY) and reset false in its finally block, bracketing exactly the
   * window where the overlay is live. Left false between turns and on non-TTY
   * / one-shot `chat` (which uses its own console writer), so background-job
   * completions and the `chat` surface still surface the line.
   */
  suppressSubagentCompletion?: boolean;
}

export interface TurnHandles {
  setInFlight(v: boolean): void;
  /**
   * Fired once at turn start, immediately after the user's submission is
   * normalized (describeForHistory) and before the model stream begins.
   * Used by the REPL to persist the user's message to the autosaved
   * transcript right away — a crash, ESC soft-stop, or backgrounded turn
   * must not lose it (onTurnComplete only fires on completed turns).
   * Receives the exact string onTurnComplete later receives as
   * `userInput`. Best-effort — errors are swallowed by the caller.
   */
  onUserMessage?(userInput: string): Promise<void> | void;
  /**
   * Fired once per completed turn after the assistant's final text is
   * in hand. Used by the REPL to append a human-readable row to the
   * autosaved markdown transcript. Best-effort — errors are swallowed
   * by the caller.
   */
  onTurnComplete?(userInput: string, assistantText: string): Promise<void>;
  /**
   * Fired after a turn completes and the status line has been refreshed.
   * Used to trigger periodic context sampling and other post-turn updates.
   */
  onAfterTurn?(): void | Promise<void>;
  /**
   * Fired at every compositor lifecycle boundary (after arm, after disarm).
   * Re-asserts the StatusLine's DECSTBM scroll-region reservation so any
   * cursor/scroll-state mutation by intervening renderers can't leave the
   * bottom-row reservation stale. Best-effort — implementations should be
   * idempotent and TTY-safe.
   */
  rearmStatus?(): void;
  /**
   * Fired exactly once per turn when the assistant's final text matched
   * AFK's terminal-state contract (Done / Blocked / Asking / Interrupted).
   * The REPL uses this to push the parsed state onto the verdict ledger
   * so the trajectory rail above the next prompt updates immediately.
   *
   * The verdict card itself has already been printed to scrollback by the
   * turn handler before this hook fires; the hook is purely for ledger
   * bookkeeping. Best-effort — errors are swallowed by the caller.
   */
  onTerminalState?(state: import('./terminal-state.js').TerminalState): void;
  /**
   * Publishes the in-flight turn's active TerminalCompositor (or null when
   * none exists, e.g. on non-TTY surfaces or after dispose). The REPL's
   * SIGINT handler reads this so it can route the interrupt notice
   * through `commitAbove` — which commits to scrollback above the live
   * overlay — rather than `console.log`, which races the compositor's
   * log-update clear/repaint cycle and can be silently erased.
   * Best-effort; absent on non-interactive callers.
   */
  setActiveCompositor?(
    c: import('../../terminal-compositor.js').TerminalCompositor | null,
  ): void;
  /**
   * Publish (or clear, with null) a notifier the REPL SIGINT handler calls to
   * toggle the live "interrupting…" overlay affordance on the active renderer.
   * The renderer owns the OverlayComposer (the single overlay owner), so the
   * SIGINT handler — which only holds the TerminalCompositor — routes through
   * this notifier rather than writing the overlay directly. Best-effort;
   * absent on non-interactive callers.
   */
  setInterruptNotifier?(notifier: ((active: boolean) => void) | null): void;
  /**
   * Optional DECSTBM scroll-region guard, typically the active StatusLine.
   * Forwarded to the per-turn StreamRenderer → TerminalCompositor so
   * `commitAbove` writes happen with full-screen scroll semantics rather
   * than inside the sub-region scroll (which would silently drop displaced
   * lines on xterm/iTerm2/Apple Terminal). Best-effort; absent on
   * non-interactive callers.
   */
  scrollRegion?: { withFullScrollRegion<T>(fn: () => T): T; getExtraRows(): number };
  /**
   * Accessor for the REPL's persistent TerminalCompositor (Stage 3e+),
   * if one has been armed by the InputSurface. The turn handler passes
   * the returned compositor to the per-turn StreamRenderer's
   * `compositor` option, which then BORROWS it for the turn's
   * lifetime — arms streaming mode, attaches the spinner/overlay,
   * and on dispose flips back to idle (NOT disarming, since the
   * surface owns the lifetime). Returns null when:
   *   - No persistent compositor armed (non-TTY surfaces, daemon).
   *   - The surface hasn't called armCompositor() yet.
   *   - The surface disposed (shouldn't happen during a turn).
   * Best-effort; absent on non-REPL callers.
   */
  getCompositor?(): import('../../terminal-compositor.js').TerminalCompositor | null;
  /**
   * Install/clear a per-turn Ctrl+B handler on the surface's persistent
   * compositor. Used by the turn handler to flip `backgroundRequested`
   * when the user backgrounds an in-flight turn (Ctrl+B), and to clear
   * the closure at turn end so the compositor's onBackground is null
   * between turns (Ctrl+B has no meaningful idle-mode semantics).
   *
   * Wired by the REPL to `surface.setBackgroundHandler(...)`. The
   * surface's armCompositor closure dereferences this ref on every
   * Ctrl+B press, so swapping it here takes effect immediately
   * without reconstructing the compositor.
   *
   * Absent on non-REPL callers and non-TTY surfaces — the turn
   * handler treats this as a no-op when undefined.
   */
  setBackgroundHandler?(handler: (() => void) | null): void;
  /**
   * Narrow control seam for promoting a running foreground subagent to a
   * detached background job (Ctrl+B). When present and
   * `hasPromotableForeground()` is true at keypress time, the turn handler
   * promotes the in-flight subagent(s) and the main turn keeps streaming.
   * When no subagent is promotable, Ctrl+B is a no-op — there is no whole-turn
   * detach. Forwarded from `InteractiveCtx.subagentControl` at the `runTurn`
   * call site. Absent on non-REPL callers, where Ctrl+B does nothing.
   */
  subagentControl?: SubagentControl;
  /**
   * Install/clear a per-turn ESC soft-stop handler on the surface's
   * persistent compositor. Used by the turn handler to flip
   * `softStopRequested` when the user presses ESC mid-stream, and to
   * clear it at turn end so ESC between turns is a no-op.
   *
   * Wired by the REPL to `surface.setSoftStopHandler(...)`. The
   * surface's armCompositor closure dereferences this ref on every
   * ESC press, so swapping it here takes effect immediately
   * without reconstructing the compositor.
   *
   * Absent on non-REPL callers and non-TTY surfaces — the turn
   * handler treats this as a no-op when undefined.
   */
  setSoftStopHandler?(handler: (() => void) | null): void;
  /**
   * Toggle the compositor's `paused` flag for the duration of a usage-limit
   * pause (set true on the `paused` provider event, false on `resumed` / turn
   * end). While true, a submitted line fires the pause-interrupt handler below
   * instead of merely queuing — ending the auto-resume wait so the queued
   * command runs as the next turn.
   *
   * Wired by the REPL to `surface.setPausedState(...)`. Absent on non-REPL
   * callers and a no-op on non-TTY surfaces — the turn handler treats this as
   * a no-op when undefined.
   */
  setPausedState?(paused: boolean): void;
  /**
   * Install/clear the per-turn pause-interrupt handler on the surface's
   * persistent compositor. The turn handler sets a `session.interrupt()`
   * closure at turn start and clears it (`null`) at turn end.
   *
   * Wired by the REPL to `surface.setPauseInterruptHandler(...)`. Absent on
   * non-REPL callers and non-TTY surfaces — treated as a no-op when undefined.
   */
  setPauseInterruptHandler?(handler: (() => void) | null): void;
  /**
   * Fired mid-turn on tool_result events so the REPL can refresh the
   * context sampler and repaint the status line with live context usage.
   * The turn handler throttles calls internally (min interval) — callers
   * need not debounce. Best-effort; absent on non-interactive callers.
   */
  onContextProgress?(): void | Promise<void>;
  /**
   * Fired whenever the loop stage transitions (Observe → Model → Choose →
   * Act → Update). Carries the new stage name. Used by the REPL to repaint
   * the `LoopStageBar` reserved footer row with the current stage.
   *
   * Forwarded into the per-turn `StreamRenderer` as `onStageChange`, which
   * threads it through `OrchestratorCtx` so `handleOrchestratorEvent` can
   * fire it when `advanceStage` returns true.
   *
   * Best-effort; absent on non-interactive callers and non-TTY surfaces.
   */
  onStageChange?(stage: import('./loop-stage.js').LoopStage): void;
}

// `discardStdin: false` is load-bearing — ora's default wraps process.stdin
// via stdin-discarder; if a future REPL spinner restarts mid-turn, that wrap
// can break readline's 'line' event and silently hang the next turn.
// `hideCursor: false` prevents cursor ANSI codes from leaking on abrupt exit.
export const REPL_SPINNER_OPTIONS = {
  stream: process.stdout,
  hideCursor: false,
  discardStdin: false,
} as const;

export function contextRatio(stats: SessionStats, sampler?: ContextSampler): number {
  // If sampler has a cached ratio, prefer that (it's from the SDK)
  if (sampler?.getRatio() !== undefined) {
    return sampler.getRatio()!;
  }
  // Fall back to computing from local stats. Prefer the provider-computed
  // context-window footprint; input+output+cache mixes cumulative input with
  // last-round cache and overcounts on tool-heavy turns.
  const last = stats.turnTokens[stats.turnTokens.length - 1];
  if (!last) return 0;
  const used = last.footprint ?? last.input + last.output + last.cache;
  return used / contextLimitFor(stats.model);
}

export function formatStatusFields(
  stats: SessionStats,
  sampler?: ContextSampler,
  gitSampler?: GitStatusSampler,
) {
  const pct = contextRatio(stats, sampler);
  const contextLimit = contextLimitFor(stats.model);

  // Get used tokens from sampler detail if available, else compute from stats
  let contextUsedTokens: number | undefined;
  const detail = sampler?.getDetail();
  if (detail !== undefined) {
    contextUsedTokens = detail.used;
  } else {
    const last = stats.turnTokens[stats.turnTokens.length - 1];
    if (last) {
      contextUsedTokens = last.footprint ?? last.input + last.output + last.cache;
    }
  }

  // Compute sparkline from recent turns (last 5)
  let contextSparkline: string | undefined;
  if (stats.turnTokens.length >= 2) {
    const ratios = stats.turnTokens.map((t) => {
      const used = t.footprint ?? t.input + t.output + t.cache;
      return used / contextLimit;
    });
    const sparklineStr = formatTurnSparkline(ratios, 5);
    if (sparklineStr.length > 0) {
      contextSparkline = sparklineStr;
    }
  }

  const branch = gitSampler?.getBranch();
  const pr = gitSampler?.getPr();

  return {
    model: stats.model,
    cost: stats.totalCostUsd,
    tokens: stats.totalTokens,
    contextPct: pct,
    contextLimit,
    contextUsedTokens,
    contextSparkline,
    permissionMode: stats.permissionMode,
    ...(stats.cwd !== undefined ? { cwd: stats.cwd } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(pr !== undefined ? { pr } : {}),
  };
}
