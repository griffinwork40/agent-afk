/**
 * Shared types for the subagent-executor module family.
 *
 * Extracted from `subagent-executor.ts` to keep the main file under the
 * 350-code-line ratchet. Consumer imports should go through the
 * `subagent-executor.ts` facade re-exports, not this file directly.
 *
 * @module agent/tools/subagent-executor/types
 */

import type { SubagentManager } from '../../subagent.js';
import type { ReadScopeInputs } from '../../subagent-read-scope.js';
import type { BackgroundAgentRegistry } from '../../background-registry.js';
import type { ModelProvider } from '../../provider.js';
import type { AgentModelInput, IAgentSession } from '../../types.js';
import type { AgentConfig } from '../../types/config-types.js';
import type { ChildProviderFactoryArgs } from '../nesting.js';
import type { AgentRegistry } from '../../agents/index.js';
import type { SkillExecutor } from '../skill-executor.js';
import type { Surface } from '../../awareness/types.js';
import type { TraceSink } from '../../trace/index.js';
import type { InboundAttachmentReader } from '../../content/attachment-registry.js';
import type { DelegationBudget } from '../delegation-budget.js';
import type { QueuedNoteClaim } from '../subagent/queued-note.js';
import type { PromotedSubagentInfo } from '../subagent/foreground-promotion.js';

export type { PromotedSubagentInfo, QueuedNoteClaim };

export interface SubagentExecutorContext {
  subagentManager: SubagentManager;
  parentSession: Pick<IAgentSession, 'sessionId' | 'getInputStreamRef' | 'abortSignal'> &
    // Optional: when the parent exposes its hook registry, forked children
    // dispatch SubagentStart/Stop (incl. the shadow-verify nudge) against it
    // and inherit it. Nested stub parents omit it, so depth-2+ forks stay
    // unhooked (no nudges injected into intermediate subagents).
    Partial<Pick<IAgentSession, 'hookRegistry'>>;
  /**
   * `systemPrompt` is the raw base prompt (pre-assembly), intentionally
   * excluding TOOL_SYSTEM_PROMPT and ROUTING_DIRECTIVE — subagents are task
   * workers that must not inherit routing directives. See ComposeExecutorContext.
   */
  defaultConfig: Pick<AgentConfig, 'apiKey' | 'systemPrompt' | 'baseUrl' | 'openaiBaseUrl' | 'xaiBaseUrl' | 'skillDispatchName'>;
  /**
   * User-facing surface of the session that owns this executor (cli/telegram/
   * daemon). Set at top-level wiring sites; inherited by nested child executors.
   * Recorded as `origin` on the routing-decision rows this executor emits.
   * Optional/back-compat: when unset, rows omit `origin`/`actor`. The `actor`
   * role itself is derived from {@link SubagentExecutorContext.depth}, not from
   * a separate field.
   */
  surface?: Surface;
  /**
   * Per-model credential resolver. When provided, the executor calls this
   * with the child's effective model string to resolve the appropriate API
   * key at fork time — rather than forwarding the parent's pre-captured
   * `defaultConfig.apiKey` verbatim.
   *
   * This fixes the "Anthropic child starves when parent is OpenAI-routed"
   * bug: `getApiKey()` captures a single credential keyed to the *main*
   * model at bootstrap. When the main model is OpenAI-routed, that credential
   * is an OpenAI key (or undefined), but child subagents default to `'sonnet'`
   * (Anthropic-routed) and need a keychain/env Anthropic credential instead.
   *
   * The resolver must implement the cross-provider credential anti-leak
   * invariant: Anthropic credentials must never reach OpenAI-routed
   * children (commits 263e25e2 / d17fb890 / dc58d5e0). The canonical
   * implementation is `getApiKeyForModel` from `src/cli/shared-helpers.ts`,
   * which gates on `providerForModel(model)` and routes to the correct
   * credential chain. The existing `childIsOpenAI ? undefined : apiKey`
   * guard below is ALSO preserved as a defense-in-depth layer.
   *
   * Optional for backward compat: when absent, the executor falls back to
   * `defaultConfig.apiKey` (the pre-6xx behavior).
   */
  resolveApiKeyForModel?: (model: string) => string | undefined;
  /**
   * Default model when a dispatched `agent` tool call omits `model`. Sourced
   * from `AFK_DEFAULT_SUBAGENT_MODEL`; falls back to `'sonnet'` when unset.
   * Intentionally decoupled from the parent session — a high-tier parent
   * (e.g. opus) should not silently dispatch high-tier subagents.
   */
  defaultSubagentModel: AgentModelInput;
  childProviderFactory?: (args: ChildProviderFactoryArgs) => ModelProvider;
  childSkillExecutorFactory?: (
    depth: number,
    maxDepth: number,
    signal: AbortSignal,
    inheritedCwd?: string,
    inheritedReadScope?: ReadScopeInputs,
    skillDispatchName?: string,
  ) => SkillExecutor;
  /**
   * Nesting depth this executor sits at. **Required** — pass explicit `0`
   * at top-level wiring sites (CLI, telegram, threads) and `parent.depth + 1`
   * when constructing a child executor.
   *
   * Contract: an undefined value used to silently coerce to `0`, which
   * conflated "top-level wiring (intended)" with "misconfigured construction
   * (bug)". Making it required surfaces the second case as a TypeScript
   * compile error so the awareness layer's "depth for a top-level session is
   * null" snapshot rule (see {@link RuntimeSelf.depth}) is not undermined by
   * a silent fallback inside the fork-depth math at execute() below.
   *
   * The snapshot's `depth: null` reporting for top-level sessions is sourced
   * from `AgentConfig.depth === undefined`, not from this field — they are
   * intentionally decoupled: the runtime internally treats top-level as
   * depth 0 for nesting math, while the model-facing snapshot reports null.
   */
  depth: number;
  maxDepth?: number;
  /**
   * Optional registry for background-mode dispatches. When undefined, an
   * `agent` tool call with `mode: 'background'` falls back to a synthesized
   * error rather than silently downgrading to foreground — the operator
   * needs to see that background dispatch is not configured in this surface
   * (e.g. one-shot CLI, daemon turn).
   */
  backgroundRegistry?: BackgroundAgentRegistry;
  /**
   * Worktree cwd inherited from the parent session. Forwarded to the
   * per-depth child {@link SubagentManager} and to the recursive child
   * {@link SubagentExecutor} so depth ≥ 2 forks (a depth-1 subagent calling
   * the `agent` tool) keep operating in the worktree instead of falling
   * back to the Node host's `process.cwd()`.
   *
   * Invariant: depth-1 forks already inherit cwd because the parent's root
   * SubagentManager was constructed with it (see bootstrap.ts:158,
   * chat.ts:376). The bug this field fixes is silent at depth ≥ 2 — the
   * child manager constructed below was not receiving cwd, so its forks'
   * bash/grep/read_file fell back to the host repo. Same shape as the
   * SkillExecutorContext.cwd fix; see skill-executor.ts.
   *
   * Optional: surfaces without a worktree (telegram, threads without an
   * explicit cwd) leave this unset and the legacy `process.cwd()` fallback
   * applies.
   */
  cwd?: string;
  /**
   * Witness-layer trace writer inherited from the owning surface. Forwarded
   * into the per-call child {@link SubagentManager} built by
   * `buildChildConfig` so depth ≥ 2 `agent` forks (a depth-1 subagent calling
   * the `agent` tool) emit `subagent_lifecycle` events into the same trace
   * file as the root session. Depth-1 forks are covered separately by the
   * root manager's own manager-level writer (bootstrap/chat/telegram wiring);
   * this field closes the same gap for the nested managers, mirroring how
   * `cwd` chains through every depth.
   *
   * `workspaceStore` (declared on the same line below) is the exact parallel for
   * the workspace READ channel: forwarded into the same per-call child manager so
   * depth ≥ 2 `agent` forks receive the sibling-findings preamble
   * `injectWorkspacePreamble` builds from it. Depth-1 forks are likewise covered
   * by the root manager's own store (wire-executors.ts). Without it the READ
   * channel stopped at depth 1 while the WRITE channel (the provider's
   * `workspace_publish` handler) reached every depth — so a grandchild could
   * publish into a store whose contents it was never shown.
   *
   * The two share one declaration line because this file is grandfathered in
   * .filesize-baseline.json, whose ratchet permits only shrinkage.
   *
   * `delegationBudget` (declared on the same line below) is the tree-wide
   * spawn-limit tracker threaded by reference from the root session. See
   * delegation-budget.ts. Opt-in: undefined when no budget env vars are set.
   */
  // Delegation budget: shared by reference across the entire session tree.
  // See delegation-budget.ts. Opt-in: undefined when no budget env vars are set.
  traceWriter?: TraceSink; workspaceStore?: import('../../workspace/index.js').WorkspaceStore; delegationBudget?: DelegationBudget;
  /**
   * Tool allowlist to propagate to grandchild providers when this executor
   * is itself a read-only skill's child. Forwarded into `childProviderFactory`
   * so the read-only constraint survives `agent` fan-out (depth ≥ 2).
   * When undefined, `childProviderFactory` defaults to `CHILD_ALLOWED_TOOLS`.
   */
  allowedTools?: string[];
  /**
   * When true, the mutating-bash gate is forwarded to grandchild providers.
   * Set together with `allowedTools` for read-only skill fan-out propagation.
   */
  readOnlyBash?: boolean;
  /**
   * Nested-dispatch allowlist for the agent that OWNS this executor. Set when
   * the dispatching agent declared a scoped `Agent(x)` grant (e.g.
   * research-agent's `Agent(git-investigator)`, surfaced by resolve.ts as
   * `nestedAgentTypes`). When present, {@link SubagentExecutor.execute} rejects
   * any `agent_type` not in the list — and any bare/no-type dispatch — before a
   * fork happens. An EMPTY array `[]` is a deny-all (from an `Agent()` grant):
   * the check is on presence, not length, so `[]` matches nothing and rejects
   * every dispatch. `undefined` = no restriction (top-level executors, or an
   * inherit-all / bare-`Agent` agent).
   *
   * Why this is the safety boundary: a dispatched child's own grandchild
   * executor inherits the parent CAGE ({@link allowedTools}), NOT the child's
   * definition (see the childExecutor wiring below). At top level that cage is
   * unrestricted, so a read-only agent granted the `agent` tool could otherwise
   * spawn an unrestricted `general-purpose` (or bare) grandchild with full
   * bash/write. This allowlist scopes the child to exactly the leaf agents its
   * definition named — each of which is self-caged by its own definition.
   */
  nestedAgentAllowlist?: readonly string[];
  /**
   * Session-wide named-agent registry (see `agent/agents/`). When present,
   * the `agent` tool accepts an `agent_type` (alias `subagent_type`) input
   * that dispatches the named definition: its body becomes the child's
   * system prompt, its resolved tool allowlist is mechanically enforced at
   * the child provider's permission gate, and its `model`/`maxTurns` act as
   * defaults under explicit per-call values. Threaded by reference through
   * nested executors so depth ≥ 2 dispatches resolve the same registry.
   * When absent, `agent_type` inputs fail with an "available: (none)" error
   * and the legacy dispatch path is byte-identical.
   */
  agentRegistry?: AgentRegistry;
  /** Read-only session attachment lookup; paths are loaded only at dispatch. */
  inboundAttachmentRegistry?: InboundAttachmentReader;
  /**
   * The dispatching session's own model. Used to resolve a named agent's
   * `model: inherit` (and the omitted-model default for NAMED dispatches,
   * Claude Code parity). Distinct from `defaultSubagentModel`, which is the
   * cost-policy default for UNNAMED dispatches and stays authoritative for
   * them. When unset, `inherit` falls back to the policy default chain.
   */
  parentModel?: AgentModelInput;
}

/**
 * Narrow control seam exposed to the keyboard / REPL layer for user-triggered
 * promotion of a running foreground subagent to a detached background job
 * (Ctrl+B). Deliberately minimal — one query + one command — so the keyboard
 * never reaches into `SubagentHandle`, the manager's active map, or abort
 * internals. The composition root (bootstrap) injects the executor as a
 * `SubagentControl` into the turn handler's handles bag; the keyboard layer
 * depends only on this interface.
 *
 * Invariant: the only sanctioned cross-layer dependency from `src/cli/**`
 * onto subagent control is this interface. See the architectural boundary
 * test that forbids `src/cli/**` from importing `SubagentHandleImpl`, reading
 * `.active`, or calling `.promote(`.
 */
export interface SubagentControl {
  /**
   * True iff at least one foreground subagent dispatched by this executor is
   * currently running AND can be promoted (a `BackgroundAgentRegistry` is
   * wired). The keyboard uses this to decide whether Ctrl+B promotes the
   * in-flight subagent(s) or falls back to whole-turn backgrounding.
   */
  hasPromotableForeground(): boolean;
  /**
   * Promote every in-flight foreground subagent to a detached background job.
   * Resolves once each promotion has been handed to the registry. Entries that
   * could not be promoted (the subagent completed in the same tick, or the
   * background-job cap was hit) are omitted from the returned array.
   *
   * `queuedNote` optionally carries the REPL user's typed-ahead messages so they
   * reach the parent's still-running turn on the same keypress that backgrounded
   * the subagent (riding the synthetic promotion `tool_result`). The ticket is
   * shared across every trigger, so the note is folded in at most once. The
   * caller MUST re-read `queuedNote.claimed` after this resolves and keep its
   * message queued when it is still `false` — an unclaimed note means nothing
   * was promoted and the text has nowhere to ride.
   */
  promoteActiveForeground(queuedNote?: QueuedNoteClaim): Promise<PromotedSubagentInfo[]>;
  /**
   * True iff at least one foreground subagent dispatched by this executor is
   * currently in flight. Unlike {@link hasPromotableForeground} this does NOT
   * require a `BackgroundAgentRegistry` — cancellation is always available. The
   * keyboard layer reads this to decide whether a soft-stop (ESC / first Ctrl+C)
   * must cancel in-flight subagents to unblock a turn suspended on a subagent
   * `await`.
   */
  hasActiveForeground(): boolean;
  /**
   * Cancel every in-flight foreground subagent dispatched by this executor.
   * Each cancellation resolves the subagent's suspended `runToResult` (as a
   * failed result carrying any streamed partial output), which lets the parent
   * turn's tool-use loop unblock and observe the pending soft-stop so the turn
   * ends cleanly instead of hanging for the subagent's entire lifetime (up to
   * the 2h usage-limit cap). Returns the number of subagents cancelled; a no-op
   * returning 0 when none are in flight.
   */
  cancelActiveForeground(): Promise<number>;
}
