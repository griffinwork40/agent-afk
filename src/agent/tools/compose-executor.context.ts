/**
 * `ComposeExecutorContext` — construction-time dependency bundle for
 * {@link ComposeExecutor}. Split out of `compose-executor.ts` (file-size
 * ceiling, #3481).
 *
 * @module agent/tools/compose-executor.context
 */

import type { AgentModelInput, IAgentSession } from '../types.js';
import type { Surface } from '../awareness/types.js';
import type { WorkspaceStore } from '../workspace/index.js';
import type { TraceSink } from '../trace/index.js';
import type { ReadScopeInputs } from '../subagent-read-scope.js';
import type { AgentRegistry } from '../agents/index.js';
import type { InboundAttachmentReader } from '../content/attachment-registry.js';

export interface ComposeExecutorContext {
  // NOTE: compose nodes are NOT wired for the parent-registry fallback. The
  // DAG executor (dag-subagent.ts) forks each node with `parent: { sessionId }`
  // only — it strips getInputStreamRef/hookRegistry — so SubagentStop can
  // neither inject nor resolve a registry here. Wiring it would also emit one
  // nudge per node (noisy for an N-node DAG). Left dark intentionally. The
  // journal view IS forwarded: each node journals via forSubagent(nodeChildId).
  parentSession: Pick<IAgentSession, 'sessionId' | 'abortSignal'> & import('../subagent/fork-types.js').JournalParent;
  defaultModel?: AgentModelInput;
  defaultSubagentModel: AgentModelInput;
  apiKey?: string;
  // Contract:
  // Per-node credential resolver for the compose path. Called with each DAG
  // node's effective model string at fork time to resolve the appropriate API
  // key — matching the agent tool's per-fork resolution pattern (child-config.ts:
  // 302-308). `ctx.apiKey` serves as a fallback when fresh resolution returns
  // empty (expired keychain token / transient failure), not the primary source.
  //
  // The resolver must implement the cross-provider credential anti-leak
  // invariant: Anthropic credentials must never reach OpenAI-routed nodes
  // (commits 263e25e2 / d17fb890 / dc58d5e0). The canonical implementation is
  // `getApiKeyForModel` from `src/cli/shared-helpers.ts`. The `nodeIsOpenAI ?
  // undefined` guard is preserved as a defense-in-depth layer.
  //
  // Optional: when absent, the executor calls `resolveCredentialForModel`
  // (from `src/agent/auth/credential-resolver.ts`) directly — a live env read.
  // The keyless hard-fail precondition is relaxed when a resolver is present,
  // allowing keyless-parent setups (e.g. a local-shim OpenAI parent) to serve
  // Anthropic-routed nodes via the resolver without holding a parent-level
  // apiKey.
  resolveApiKeyForModel?: (model: string) => string | undefined;
  /**
   * Local-server base URL forwarded to every compose subagent so nodes
   * inherit the same Anthropic-compatible local endpoint as the parent.
   */
  baseUrl?: string;
  /** OpenAI-compatible base URL for workspace-enabled compose node providers. */
  openaiBaseUrl?: string;
  /**
   * The raw base system prompt (pre-assembly) forwarded to every compose
   * subagent. Intentionally the *base* prompt rather than the assembled one
   * (which also contains TOOL_SYSTEM_PROMPT and ROUTING_DIRECTIVE): compose
   * nodes run as task workers, not orchestrators, so they must not inherit
   * routing directives that would allow them to spawn nested DAGs or recursively
   * invoke skills. This mirrors the SubagentExecutor convention; see
   * `SubagentExecutorContext.defaultConfig.systemPrompt` for the matching rationale.
   *
   * Callers **must** supply this; omitting it leaves subagents with an empty
   * system prompt and no tool context.
   */
  systemPrompt: string;
  /**
   * Working directory inherited by every compose DAG node. Seeded into the
   * SubagentManager so forked nodes anchor to the session's worktree instead
   * of the host's `process.cwd()`. Re-anchored mid-session via
   * {@link ComposeExecutor.setCwd} (born-named `afk -w` worktree created on
   * turn 1). Mirrors the SubagentExecutor / SkillExecutor cwd convention.
   * Optional: when absent, nodes fall back to `process.cwd()` (pre-fix
   * behavior).
   */
  cwd?: string;
  /**
   * Witness-layer trace writer inherited from the owning surface. Seeded into
   * the per-call {@link SubagentManager} so every compose DAG node emits
   * `subagent_lifecycle` events into the session trace. Without it, compose
   * nodes are invisible in `afk trace show` — same gap as the raw `agent`
   * tool path; see SubagentExecutorContext.traceWriter.
   */
  traceWriter?: TraceSink;
  /**
   * User-facing surface of the session that owns this executor
   * (cli/telegram/daemon). Recorded as `origin` on compose routing-decision
   * rows. `actor` is derived from {@link ComposeExecutorContext.depth}.
   * Optional/back-compat: when unset, rows omit `origin`/`actor`.
   * Mirrors the same field on {@link SubagentExecutorContext}.
   */
  surface?: Surface;
  /**
   * Nesting depth this executor sits at. Used together with `surface` to
   * derive `actor` for routing-decision rows (depth 0 → `main`; depth > 0
   * → `subagent`). Optional/back-compat: defaults to 0 when unset.
   */
  depth?: number;
  /**
   * Maximum allowed nesting depth. Optional: unset resolves the default from
   * `AFK_MAX_NESTING_DEPTH` via {@link resolveMaxNestingDepth}, matching the
   * `agent` and `skill` executors.
   *
   * Invariant: `compose` is excluded from {@link CHILD_ALLOWED_TOOLS}, so this
   * executor is only ever wired at the root (`depth` 0) and the gate below is
   * inert at any default cap. It exists so `AFK_MAX_NESTING_DEPTH=0` means what
   * it says — no nested delegation from ANY of the three dispatch tools —
   * rather than silently leaving one fan-out door open.
   */
  maxDepth?: number;
  /**
   * Reads the parent session's read scope ({@link ReadScopeInputs}) at
   * dispatch time (wired to the root
   * {@link SubagentManager.getReadScopeInputs}). Used to seed the per-call
   * compose {@link SubagentManager}'s `parentReadRoots` via
   * {@link resolveChildManagerReadRoots} so every DAG node inherits the parent
   * session's full read scope — the `child ⊇ parent` invariant the `agent`
   * tool enforces (#544), extended to compose dispatch (#547). Without it,
   * nodes derive read scope from cwd alone and silently narrow when the parent
   * session is read-open or `/allow-dir`-widened. Optional/back-compat: when
   * unset, nodes fall back to cwd-only derivation, unchanged.
   */
  getReadScopeInputs?: () => ReadScopeInputs;
  /** Shared workspace store so compose DAG nodes can publish/receive findings. */
  workspaceStore?: WorkspaceStore;
  /**
   * Named-agent registry. When set, compose nodes that declare `agent_type`
   * are resolved against this registry:
   *  - A miss fails the entire compose call with the available-agent list
   *    (mirrors the `agent` tool's fail-fast behaviour).
   *  - A hit wires the named agent's system prompt, model default, and
   *    `canUseTool` tool-restriction callback into the `SubagentDAGNode`
   *    so the node's tool surface is mechanically enforced — not just
   *    displayed as a render label.
   *
   * Optional/back-compat: when unset, `agent_type` is forwarded as a display
   * label only (legacy behaviour, preserved for callers that have not yet
   * threaded the registry).
   */
  agentRegistry?: AgentRegistry;
  /** Tree-wide delegation budget. Opt-in: undefined when no budget env vars set. */
  delegationBudget?: import('./delegation-budget.js').DelegationBudget;
  /**
   * Inbound attachment registry for resolving image IDs in per-node
   * `attachments` arrays. Falls back to the module-scope singleton
   * (`defaultInboundAttachmentRegistry`) when absent — matching the pattern
   * SubagentExecutor uses (subagent-executor.ts). Wired from wire-executors.ts
   * via the same `inboundAttachmentRegistry` import that the agent tool uses.
   */
  inboundAttachmentRegistry?: InboundAttachmentReader;

  /**
   * Callback wired to the per-call compose {@link SubagentManager} so every
   * successfully-completed DAG node's token usage and USD cost rolls up into
   * the parent session's `session_sealed` telemetry. Mirrors the wiring that
   * `bootstrap.ts` applies to the root manager via
   * `rootManager.setOnSubagentSucceeded()`.
   *
   * The compose manager is ephemeral (created and torn down per `execute()`
   * call), so the callback must route to the parent session's accumulator —
   * i.e. `(usage, costUsd) => session.recordSubagentCompletion(usage, costUsd)`
   * — rather than a local one. Late-bound via {@link ComposeExecutor.setOnSubagentSucceeded}
   * after the session is constructed to avoid a circular reference.
   */
  onSubagentSucceeded?: (
    usage: import('../subagent/result.js').SubagentTrace['usage'],
    costUsd: number | undefined,
  ) => void;
  /**
   * Contract: the model that {@link ComposeExecutorContext.apiKey} was resolved
   * FROM. Distinct from `defaultModel` when the session was launched with an
   * explicit `--model` override: e.g. `AFK_MODEL=claude-opus-5-5` (Anthropic,
   * credential source) + `--model gpt-6.1-sol` (OpenAI, session model). The
   * per-call {@link SubagentManager} derives its `parentProvider` from
   * `parentModel` — if that is `gpt-6.1-sol`, the provider resolves to
   * `openai-compatible` and `sameCredentialFamily` returns true for OpenAI
   * child nodes, causing the Anthropic `sk-ant-…` token to be forwarded (401).
   *
   * Setting `parentModel` to `credentialModel` instead keeps the provider gate
   * aligned with the actual credential shape. Falls back to `defaultModel` when
   * absent (back-compat: callers that do not supply this field are unaffected).
   *
   * Invariant: only the key's SOURCE model — never the session's routing model
   * — must be used as `parentModel` for the compose SubagentManager.
   */
  credentialModel?: AgentModelInput;
}
