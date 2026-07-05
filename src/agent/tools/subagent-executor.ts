/**
 * SubagentExecutor: provider-level handler for the Agent tool.
 *
 * Receives a ToolCall from the SessionToolDispatcher, forks a child agent
 * session via SubagentManager, runs the prompt, and returns the result as
 * a ToolResult.
 *
 * @module agent/tools/subagent-executor
 */

import { isAbsolute } from 'node:path';

import { SubagentManager } from '../subagent.js';
import { BackgroundAgentRegistry, BackgroundJobCapError } from '../background-registry.js';
import type { ModelProvider } from '../provider.js';
import type { AgentModelInput, IAgentSession } from '../types.js';
import type { AgentConfig } from '../types/config-types.js';
import { providerForModel } from '../providers/index.js';
import { applyParentCredentialFallback } from './child-credential.js';
import { resolveCredentialForModel } from '../auth/credential-resolver.js';
import type { AnthropicToolDef, ToolCall, ToolResult } from './types.js';
import {
  CHILD_ALLOWED_TOOLS,
  DEFAULT_MAX_NESTING_DEPTH,
  buildSkillRestrictedProvider,
  createStubParentSession,
  type ChildProviderFactoryArgs,
} from './nesting.js';
import { buildAgentToolDef, resolveAgentToolAccess } from '../agents/index.js';
import type { AgentRegistry, RegisteredAgent } from '../agents/index.js';
import type { SkillExecutor } from './skill-executor.js';
import { appendRoutingDecision } from '../routing-telemetry.js';
import { debugLog } from '../../utils/debug.js';
import { stripEscapeSequences } from '../../utils/terminal-sanitize.js';
import type { Surface } from '../awareness/types.js';
import { deriveOrigin, actorFromDepth, type TraceOrigin, type TraceActor } from '../session/session-identity.js';

export { DEFAULT_MAX_NESTING_DEPTH, type ChildProviderFactoryArgs } from './nesting.js';

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
   * excluding TOOL_SYSTEM_PROMPT and ROUTING_DIRECTIVE. Subagents are task
   * workers: they must not inherit routing directives that would allow
   * recursive skill invocation or nested DAG spawning. ComposeExecutor follows
   * the same convention; see `ComposeExecutorContext.systemPrompt`.
   */
  defaultConfig: Pick<AgentConfig, 'apiKey' | 'systemPrompt' | 'baseUrl' | 'openaiBaseUrl'>;
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
  defaultSubagentModel?: AgentModelInput;
  childProviderFactory?: (args: ChildProviderFactoryArgs) => ModelProvider;
  childSkillExecutorFactory?: (depth: number, maxDepth: number, signal: AbortSignal, inheritedCwd?: string) => SkillExecutor;
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
  /**
   * The dispatching session's own model. Used to resolve a named agent's
   * `model: inherit` (and the omitted-model default for NAMED dispatches,
   * Claude Code parity). Distinct from `defaultSubagentModel`, which is the
   * cost-policy default for UNNAMED dispatches and stays authoritative for
   * them. When unset, `inherit` falls back to the policy default chain.
   */
  parentModel?: AgentModelInput;
}

export type AgentExecutionMode = 'foreground' | 'background';

/** Identity of a subagent that was promoted from foreground to background. */
export interface PromotedSubagentInfo {
  jobId: string;
  label: string;
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
   */
  promoteActiveForeground(): Promise<PromotedSubagentInfo[]>;
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

interface AgentInput {
  prompt: string;
  model?: string;
  max_turns?: number;
  /**
   * True when the caller supplied `max_turns` explicitly. Distinguishes the
   * parse-time default (10) from a deliberate value so a named agent's
   * `maxTurns` frontmatter can act as the default without being able to
   * override an explicit per-call budget.
   */
  max_turns_explicit: boolean;
  id_prefix?: string;
  /**
   * Named agent type to dispatch (`agent_type`, alias `subagent_type`).
   * Resolved against {@link SubagentExecutorContext.agentRegistry}.
   */
  agent_type?: string;
  /** Execution mode. Defaults to 'foreground' (existing await-and-return semantic). */
  mode: AgentExecutionMode;
  /**
   * Optional working directory the subagent runs in. When omitted, the child
   * inherits the parent's cwd (`SubagentManager.parentCwd`) so `afk -w`
   * worktree isolation extends transparently. When provided, must be an
   * absolute path with no `..` segments — the executor threads it into
   * `AgentConfig.cwd`, which `SubagentManager.forkSubagent` applies in
   * preference to the parent fallback (see `src/agent/subagent.ts:291-297`).
   *
   * Validation is format-only at parse time (existence/git-worktree status
   * is not checked) — a non-existent path surfaces as an ENOENT on the
   * child's first cwd-relative tool call, which the parent sees as a
   * structured failure. Mirrors the existing AgentConfig.cwd contract
   * used by `afk interactive -w` and the diagnose/farm orchestrators.
   *
   * Caveat: this field affects only the dispatched child's cwd. Depth-2+
   * forks (the child itself calling `agent`) inherit through
   * `SubagentExecutorContext.cwd` set at orchestrator construction —
   * passing `cwd` here does NOT auto-propagate to recursive subagents.
   * Each level must specify `cwd` explicitly to operate in a worktree.
   */
  cwd?: string;
}

/**
 * Validate and parse Agent tool input.
 * @throws if input is invalid
 */
function parseAgentInput(input: unknown): AgentInput {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Agent tool input must be an object');
  }

  const agentInput = input as Record<string, unknown>;

  const prompt = agentInput['prompt'];
  if (typeof prompt !== 'string') {
    throw new Error('Agent tool input must have a "prompt" field of type string');
  }
  if (prompt.trim().length === 0) {
    throw new Error('Agent tool prompt cannot be empty');
  }

  let model: string | undefined;
  const modelValue = agentInput['model'];
  if (modelValue !== undefined) {
    if (typeof modelValue !== 'string') {
      throw new Error('Agent tool model must be a string');
    }
    model = modelValue;
  }

  let max_turns = 10;
  let max_turns_explicit = false;
  const maxTurnsValue = agentInput['max_turns'];
  if (maxTurnsValue !== undefined) {
    if (typeof maxTurnsValue !== 'number') {
      throw new Error('Agent tool max_turns must be a number');
    }
    // Clamp to [1, 50]
    max_turns = Math.max(1, Math.min(50, Math.floor(maxTurnsValue)));
    max_turns_explicit = true;
  }

  // agent_type: canonical param; `subagent_type` accepted as an alias for
  // Claude Code-ported prompts (bundled SKILL.mds already write it). When
  // both are present the canonical name wins.
  let agent_type: string | undefined;
  const agentTypeValue = agentInput['agent_type'] ?? agentInput['subagent_type'];
  if (agentTypeValue !== undefined) {
    if (typeof agentTypeValue !== 'string') {
      throw new Error('Agent tool agent_type must be a string');
    }
    const trimmed = agentTypeValue.trim();
    if (trimmed.length > 0) agent_type = trimmed;
  }

  let id_prefix = 'agent-tool';
  const idPrefixValue = agentInput['id_prefix'];
  if (idPrefixValue !== undefined) {
    if (typeof idPrefixValue !== 'string') {
      throw new Error('Agent tool id_prefix must be a string');
    }
    id_prefix = idPrefixValue;
  }

  // mode: default 'foreground'. Unknown strings reject loudly rather than
  // silently coercing — a typo like "back" would be silently downgraded
  // to a foreground run, exactly the surprise this feature is built to
  // avoid.
  let mode: AgentExecutionMode = 'foreground';
  const modeValue = agentInput['mode'];
  if (modeValue !== undefined) {
    if (modeValue !== 'foreground' && modeValue !== 'background') {
      throw new Error(
        `Agent tool mode must be "foreground" or "background", got: ${JSON.stringify(modeValue)}`,
      );
    }
    mode = modeValue;
  }

  // cwd: optional absolute path. Format-only validation here — existence is
  // not checked because the call site is sync and any ENOENT surfaces
  // cleanly through the child's first tool call. Rules:
  //   1. Must be a non-empty string when present.
  //   2. Must be absolute (`path.isAbsolute`) — relative paths would otherwise
  //      resolve against `process.cwd()` and silently land somewhere
  //      unrelated to the caller's intent.
  //   3. Must not contain `..` as a path segment. `path.resolve` would
  //      silently collapse them; rejecting forces the caller to write
  //      what they mean. Splits on both `/` and `\\` so the check holds
  //      on Windows too.
  let cwd: string | undefined;
  const cwdValue = agentInput['cwd'];
  if (cwdValue !== undefined) {
    if (typeof cwdValue !== 'string') {
      throw new Error(
        `Agent tool cwd must be a string, got: ${JSON.stringify(cwdValue)}`,
      );
    }
    if (cwdValue.length === 0) {
      throw new Error('Agent tool cwd must be a non-empty string');
    }
    if (!isAbsolute(cwdValue)) {
      throw new Error(
        `Agent tool cwd must be an absolute path, got: ${JSON.stringify(cwdValue)}`,
      );
    }
    const segments = cwdValue.split(/[/\\]/);
    if (segments.includes('..')) {
      throw new Error(
        `Agent tool cwd must not contain '..' segments, got: ${JSON.stringify(cwdValue)}`,
      );
    }
    cwd = cwdValue;
  }

  return {
    prompt,
    model,
    max_turns,
    max_turns_explicit,
    id_prefix,
    mode,
    ...(agent_type !== undefined ? { agent_type } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

/**
 * Best-effort telemetry helper. Wraps {@link appendRoutingDecision} so a
 * synchronous throw (shouldn't happen — the helper already swallows) cannot
 * propagate into the dispatch path.
 */
function emitTelemetry(entry: Parameters<typeof appendRoutingDecision>[0]): Promise<void> {
  try {
    return appendRoutingDecision(entry).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/** Truncate short telemetry strings; we never log full error bodies. */
function truncate(s: string, max = 240): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

/** Measure partial output size without serializing large structures repeatedly. */
function measurePartial(partial: unknown): number | undefined {
  if (partial === undefined || partial === null) return undefined;
  if (typeof partial === 'string') return partial.length;
  try {
    return JSON.stringify(partial).length;
  } catch {
    return undefined;
  }
}

/**
 * Maximum serialized size of `partialOutput` we will surface to the parent
 * model. Above this, we replace the payload with a `{ truncated, chars }`
 * marker so the parent learns partial output existed without flooding its
 * context.
 */
const MAX_PARTIAL_OUTPUT_CHARS = 4096;

/** Maximum length of the `error` field in the structured failure payload. */
const MAX_ERROR_MESSAGE_CHARS = 1024;

/**
 * Shape a partial output for inclusion in the structured failure payload.
 * Returns `undefined` when the input is null/undefined (key is omitted).
 * Returns a `{ truncated, chars }` marker when serialization exceeds the cap.
 */
function shapePartialOutput(
  partial: unknown,
): unknown | undefined {
  if (partial === undefined || partial === null) return undefined;
  const chars = measurePartial(partial);
  if (chars !== undefined && chars > MAX_PARTIAL_OUTPUT_CHARS) {
    return { truncated: true, chars };
  }
  return partial;
}

/**
 * Build the structured JSON payload returned to the parent model on the
 * failure path. Intentionally small: status + short error + optional schema
 * error string + optional (size-capped) partial output + subagent id.
 *
 * Excludes by design: prompts, full subagent assistant messages, file
 * contents, tool inputs/outputs, credentials, stack traces.
 */
interface StructuredFailurePayload {
  status: string;
  error: string;
  schemaError?: string;
  partialOutput?: unknown;
  subagent_id: string;
}

function buildFailurePayload(args: {
  status: string;
  errorMessage: string;
  schemaErrorMessage?: string;
  partialOutput?: unknown;
  subagentId: string;
}): StructuredFailurePayload {
  const payload: StructuredFailurePayload = {
    status: args.status,
    error: truncate(args.errorMessage, MAX_ERROR_MESSAGE_CHARS),
    subagent_id: args.subagentId,
  };
  if (args.schemaErrorMessage) {
    payload.schemaError = truncate(args.schemaErrorMessage, MAX_ERROR_MESSAGE_CHARS);
  }
  const shaped = shapePartialOutput(args.partialOutput);
  if (shaped !== undefined) {
    payload.partialOutput = shaped;
  }
  return payload;
}

export class SubagentExecutor implements SubagentControl {
  // Current worktree cwd. Seeded from ctx.cwd; updated by setCwd when the
  // session's cwd changes (born-named `afk -w` worktree created on turn 1).
  // Read when building the depth-2+ child manager/executor below.
  private currentCwd: string | undefined;

  constructor(private readonly ctx: SubagentExecutorContext) {
    this.currentCwd = ctx.cwd;
  }

  /**
   * Re-anchor the cwd used for forked sub-agents after a mid-session cwd change.
   * Updates the depth-2+ anchor (this.currentCwd) AND the root manager that
   * dispatches depth-1 forks, so the whole `agent`-tool tree follows the new
   * worktree instead of falling back to the host's process.cwd().
   */
  setCwd(cwd: string): void {
    this.currentCwd = cwd;
    this.ctx.subagentManager.setCwd(cwd);
  }

  /**
   * The `agent` tool definition this executor's owning provider should
   * advertise. With a non-empty named-agent registry, the definition gains
   * the `agent_type` input property and an "Available agent types" listing
   * (Claude Code advertises subagent types in its Task tool the same way).
   * Without one, returns the static schema byte-identical to the legacy
   * surface. Providers call this via optional chaining so stubbed executors
   * in tests fall back to the static def.
   */
  describeAgentTool(): AnthropicToolDef {
    return buildAgentToolDef(this.ctx.agentRegistry);
  }

  /**
   * In-flight foreground subagents that can be promoted to background, keyed
   * by `handle.id`. Each entry is registered by the foreground branch of
   * {@link execute} immediately before its run-vs-promotion race and removed
   * in that branch's `finally`. `fire()` resolves the executor's promotion
   * signal (winning the race); `ready` resolves with the created job once the
   * handoff completes, or `null` if promotion could not happen.
   *
   * Multiple concurrent `agent` calls in one tool batch each add an entry, so
   * `promoteActiveForeground()` promotes the whole in-flight set ("promote
   * all"), which is what unblocks a parent parked in `executeBatch` awaiting
   * several subagents at once.
   */
  private readonly promotionTriggers = new Map<
    string,
    { fire: () => void; ready: Promise<PromotedSubagentInfo | null> }
  >();

  // In-flight foreground handles keyed by `handle.id`. Tracked separately from
  // promotionTriggers because cancellation must work with NO background
  // registry wired: a soft-stop (ESC / Ctrl+C) cancels these to unblock a
  // parent turn parked on a subagent `await`. Populated alongside the promotion
  // trigger in execute()'s foreground branch and cleared in the same finally.
  private readonly activeForegroundHandles = new Map<string, { cancel: () => Promise<void> }>();

  hasPromotableForeground(): boolean {
    return this.ctx.backgroundRegistry !== undefined && this.promotionTriggers.size > 0;
  }

  hasActiveForeground(): boolean {
    return this.activeForegroundHandles.size > 0;
  }

  async cancelActiveForeground(): Promise<number> {
    // Snapshot first: cancel() resolves the run, whose finally removes the entry
    // from the map while we iterate. handle.cancel() is idempotent and aborts
    // the child session; its runToResult settles (buildResultFromError with any
    // partialOutput), the Promise.race in execute() picks the 'result' branch,
    // and the parent receives a structured failure tool_result — unblocking the
    // suspended turn. We do NOT delete entries here; the run's own finally does
    // so idempotently.
    const handles = [...this.activeForegroundHandles.values()];
    if (handles.length === 0) return 0;
    await Promise.all(handles.map((h) => h.cancel().catch(() => { /* best-effort */ })));
    return handles.length;
  }

  async promoteActiveForeground(): Promise<PromotedSubagentInfo[]> {
    // Snapshot first: firing a trigger may settle and remove its entry from
    // the map (via execute()'s finally) while we iterate.
    const triggers = [...this.promotionTriggers.values()];
    triggers.forEach((t) => t.fire());
    const settled = await Promise.all(triggers.map((t) => t.ready));
    return settled.filter((j): j is PromotedSubagentInfo => j !== null);
  }

  /**
   * Read-only snapshot of active subagents + background jobs for the
   * `get_runtime_state` tool's `subagents` view. Pulls fresh from the
   * manager + registry on every call so live counts are visible.
   *
   * Lite shape only — does not expose `SubagentHandle` references or raw
   * `BackgroundJob` objects (which would leak handle internals like the
   * progress sink). Background `startedAt` is converted from epoch-ms to
   * ISO 8601 to match the rest of the snapshot's timestamp convention.
   */
  getSubagentsLite(): {
    active: Array<{
      id: string;
      status: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    }>;
    backgroundJobs: Array<{
      jobId: string;
      status: 'running' | 'completed' | 'failed' | 'cancelled';
      startedAt: string;
      label: string | null;
    }>;
  } {
    const active = this.ctx.subagentManager
      .list()
      .map((h) => ({ id: h.id, status: h.status }));
    const backgroundJobs = this.ctx.backgroundRegistry
      ? this.ctx.backgroundRegistry.list().map((j) => ({
          jobId: j.jobId,
          status: j.status,
          startedAt: new Date(j.startedAt).toISOString(),
          label: j.label.length > 0 ? j.label : null,
        }))
      : [];
    return { active, backgroundJobs };
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    // If signal is already aborted, return immediately
    if (call.signal.aborted) {
      return {
        content: 'Agent tool call aborted',
        isError: true,
      };
    }

    let parsed: AgentInput;
    try {
      parsed = parseAgentInput(call.input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: `Agent tool input validation failed: ${message}`,
        isError: true,
      };
    }

    // Named-agent resolution. A miss fails fast with the available list
    // (mirrors skill-executor.ts's "Skill not found. Available skills: …")
    // rather than silently dispatching an unrestricted generic child under
    // a name the caller believed carried constraints.
    let namedAgent: RegisteredAgent | undefined;
    if (parsed.agent_type !== undefined) {
      namedAgent = this.ctx.agentRegistry?.get(parsed.agent_type);
      if (namedAgent === undefined) {
        const available = [...(this.ctx.agentRegistry?.keys() ?? [])].sort().join(', ');
        return {
          content:
            `Agent type "${parsed.agent_type}" not found. ` +
            `Available agent types: ${available.length > 0 ? available : '(none)'}`,
          isError: true,
        };
      }
    }

    // Build child config.
    //
    // Invariant: `ctx.depth` is required (see SubagentExecutorContext.depth
    // jsdoc) — top-level callers pass explicit `0` so the child's `depth + 1`
    // arithmetic below produces a confident nesting position. A future change
    // that loosens the type back to optional would re-introduce the silent
    // misconfig fallback the Phase 1 awareness contract is designed to avoid.
    const depth = this.ctx.depth;
    const maxDepth = this.ctx.maxDepth ?? DEFAULT_MAX_NESTING_DEPTH;
    let childManager: SubagentManager | undefined;

    // Session identity for routing-decision rows. Only emitted when this
    // executor was wired with a `surface` (the new top-level wiring); legacy/
    // un-threaded contexts omit both fields, preserving back-compat. `actor`
    // comes from `depth` (>0 ⟺ this executor is owned by a subagent).
    const identity: { origin?: TraceOrigin; actor?: TraceActor } =
      this.ctx.surface !== undefined
        ? { origin: deriveOrigin(this.ctx.surface), actor: actorFromDepth(depth) }
        : {};

    // Resolve the child's effective model and the provider it routes to FIRST,
    // so we can decide whether the parent's Anthropic-shaped `apiKey` /
    // `baseUrl` (sourced from `loadCredential()` + `AFK_LOCAL_BASE_URL`) should
    // be forwarded. Forwarding them to an OpenAI-routed child causes
    // `resolveOpenAIAuth()` to return the Anthropic key as if it were a config
    // OpenAI key (tier 1 wins) — the OpenAI API then 401s. Clearing them lets
    // the OpenAI auth resolver walk its env / codex precedence cleanly.
    // Model resolution.
    //   Unnamed dispatch (legacy, unchanged): call-site > policy default > 'sonnet'.
    //   Named dispatch (Claude Code parity): call-site > definition model
    //   ('inherit' → dispatching session's model) > inherit-by-default
    //   (omitted model also means inherit) > policy default > 'sonnet'.
    // `parentModel` is optional ctx wiring; when absent, inherit falls
    // through to the policy chain rather than guessing.
    let namedDefaultModel: string | undefined;
    if (namedAgent !== undefined) {
      const defModel = namedAgent.definition.model;
      namedDefaultModel =
        defModel !== undefined && defModel !== 'inherit'
          ? defModel
          : this.ctx.parentModel;
    }
    const childModel: string =
      parsed.model ?? namedDefaultModel ?? this.ctx.defaultSubagentModel ?? 'sonnet';
    const childIsOpenAI = providerForModel(childModel) === 'openai-compatible';

    // Named-agent tool access: resolve the definition's declared surface into
    // runtime terms, then compose with any cage this executor already sits in
    // (a read-only skill's fan-out). Composition is fail-closed:
    //   allowlist  = def ∩ cage   (when both exist; either alone otherwise)
    //   bash gate  = def ∨ cage
    // — mirroring skill-executor.ts buildForkedChildConfig's intersection
    // semantics, so a named dispatch can never widen an existing cage.
    const resolvedAccess =
      namedAgent !== undefined
        ? resolveAgentToolAccess(namedAgent, CHILD_ALLOWED_TOOLS)
        : undefined;
    let effectiveAllowedTools: string[] | undefined = this.ctx.allowedTools;
    if (resolvedAccess?.allowedTools !== undefined) {
      const cage = this.ctx.allowedTools;
      effectiveAllowedTools =
        cage !== undefined
          ? resolvedAccess.allowedTools.filter((t) => cage.includes(t))
          : resolvedAccess.allowedTools;
    }
    const effectiveReadOnlyBash =
      this.ctx.readOnlyBash === true || resolvedAccess?.bashReadOnly === true;
    if (resolvedAccess !== undefined && resolvedAccess.droppedTokens.length > 0) {
      // Fail-closed token drops silently NARROW the child's tool surface, so a
      // misconfigured agent file must be visible by default — not only under
      // AFK_DEBUG. Route through the same stderr sink the agent registry uses
      // for its load-time warnings (loadAgentRegistry's default `warn`).
      process.stderr.write(
        `[afk] agents: agent_type ${JSON.stringify(namedAgent?.name)}: ` +
          `unknown tool token(s) dropped fail-closed: ${resolvedAccess.droppedTokens.join(', ')}\n`,
      );
    }

    // Turn budget: explicit per-call max_turns wins; otherwise a named
    // agent's maxTurns frontmatter (clamped to the same [1, 50] envelope);
    // otherwise the parse-time default.
    const effectiveMaxTurns =
      !parsed.max_turns_explicit && namedAgent?.definition.maxTurns !== undefined
        ? Math.max(1, Math.min(50, Math.floor(namedAgent.definition.maxTurns)))
        : parsed.max_turns;

    // Resolve the child's API key by its own model/provider. The resolver is
    // now available directly from the agent layer (resolveCredentialForModel),
    // so no injection is required — `this.ctx.resolveApiKeyForModel` acts as
    // an optional override for callers that need a custom strategy (e.g. tests).
    // When absent, the default agent-layer resolver is used. The
    // `childIsOpenAI ? undefined` guard below is preserved as a
    // defense-in-depth layer (cross-provider credential anti-leak invariant).
    //
    // applyParentCredentialFallback adds a second safety net: when fresh
    // per-model resolution comes up empty for an Anthropic child (the sync
    // keychain reader bailing on an expired OAuth token), reuse the parent's
    // bootstrap-captured credential IFF it is Anthropic-shaped — so the child
    // gets a token to attempt with and its own 401 refresher self-heals,
    // instead of dying at the provider pre-flight. See child-credential.ts.
    const resolvedChildApiKey = applyParentCredentialFallback({
      childModel,
      resolved: this.ctx.resolveApiKeyForModel
        ? this.ctx.resolveApiKeyForModel(childModel)
        : resolveCredentialForModel(childModel),
      parentApiKey: this.ctx.defaultConfig.apiKey,
    });

    const childConfig: AgentConfig = {
      model: childModel,
      apiKey: childIsOpenAI ? undefined : resolvedChildApiKey,
      // A named agent's markdown body IS the child's system prompt (Claude
      // Code parity: subagents receive the definition prompt, not the parent
      // surface's full prompt). Unnamed dispatches keep the raw base prompt.
      systemPrompt: namedAgent !== undefined ? namedAgent.definition.prompt : this.ctx.defaultConfig.systemPrompt,
      baseUrl: childIsOpenAI ? undefined : this.ctx.defaultConfig.baseUrl,
      maxTurns: effectiveMaxTurns,
      // Awareness metadata (Phase 1, get_runtime_state):
      // Thread depth + maxDepth into the child's AgentConfig so the
      // `self` view of the child's get_runtime_state snapshot reflects
      // its actual nesting position. `parentSessionId` is injected later
      // by SubagentManager.forkSubagent which has options.parent.sessionId
      // in scope; phaseRole is also handled there.
      depth: depth + 1,
      maxDepth,
      // Per-call cwd override. When set, `SubagentManager.forkSubagent`
      // applies this in preference to the manager's `parentCwd` fallback
      // (see src/agent/subagent.ts:291-297) — the child's dispatcher
      // resolveBase + read/write roots anchor at this path. When omitted,
      // the parent inheritance chain stays intact.
      ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
    } as AgentConfig;

    // Wire nesting: give the child its own executor + provider so it can
    // dispatch Agent and Skill tool calls. Skip when at maxDepth or no
    // factory — child gracefully loses both tools.
    //
    // childParentSession is a mutable stub: sessionId starts undefined and is
    // backfilled to handle.id once forkSubagent resolves. This ensures depth-2
    // forks (dispatched by childExecutor) see a real parentId rather than
    // undefined, so the stream-renderer can attribute them correctly.
    let childParentSession: ReturnType<typeof createStubParentSession> & { sessionId: string | undefined } | undefined;
    if (this.ctx.childProviderFactory && depth < maxDepth) {
      // Forward cwd to the child manager so depth-2 forks (this depth-1
      // child calling the `agent` tool) inherit the worktree anchor.
      // Without this, `SubagentManager.forkSubagent` reads `this.parentCwd`
      // (undefined) and depth-2 child config.cwd is omitted — its
      // bash/grep/read_file fall back to process.cwd() (host repo).
      childManager = new SubagentManager({
        parentAbortSignal: call.signal,
        ...(this.currentCwd !== undefined ? { cwd: this.currentCwd } : {}),
      });
      childParentSession = createStubParentSession(call.signal) as ReturnType<typeof createStubParentSession> & { sessionId: string | undefined };
      const childExecutor = new SubagentExecutor({
        subagentManager: childManager,
        parentSession: childParentSession as Pick<IAgentSession, 'sessionId' | 'getInputStreamRef' | 'abortSignal'>,
        defaultConfig: this.ctx.defaultConfig,
        // Inherit origin from the parent; `depth + 1` below makes this child's
        // emitted rows carry actor:'subagent'.
        ...(this.ctx.surface !== undefined ? { surface: this.ctx.surface } : {}),
        defaultSubagentModel: this.ctx.defaultSubagentModel,
        childProviderFactory: this.ctx.childProviderFactory,
        childSkillExecutorFactory: this.ctx.childSkillExecutorFactory,
        // Propagate the resolver so depth ≥ 2 forks (this depth-1 child
        // calling the `agent` tool) also resolve credentials by child model.
        ...(this.ctx.resolveApiKeyForModel !== undefined
          ? { resolveApiKeyForModel: this.ctx.resolveApiKeyForModel }
          : {}),
        depth: depth + 1,
        maxDepth,
        // Forward cwd so the depth-1 child executor, when it constructs
        // ITS own childManager for depth-3+ forks, also receives cwd. The
        // chain holds for arbitrary depth up to maxDepth.
        ...(this.currentCwd !== undefined ? { cwd: this.currentCwd } : {}),
        // Propagate read-only constraints so depth ≥ 2 forks (this depth-1
        // child calling the `agent` tool) keep the same tool allowlist and
        // bash gate that the originating read-only skill imposed.
        //
        // Deliberately the CAGE (ctx) values, not the named-agent effective
        // values: a named definition constrains the child it dispatches, not
        // that child's own descendants (Claude Code parity — nested spawns
        // resolve their own agent types). The cage, by contrast, cascades.
        ...(this.ctx.allowedTools !== undefined ? { allowedTools: this.ctx.allowedTools } : {}),
        ...(this.ctx.readOnlyBash ? { readOnlyBash: true } : {}),
        // Named-agent registry + the child's model (for grandchild `inherit`
        // resolution) thread through every depth.
        ...(this.ctx.agentRegistry !== undefined ? { agentRegistry: this.ctx.agentRegistry } : {}),
        parentModel: childModel,
      });
      const childSkillExecutor = this.ctx.childSkillExecutorFactory
        ? this.ctx.childSkillExecutorFactory(depth + 1, maxDepth, call.signal, this.currentCwd)
        : undefined;
      // Pass `model` so the factory routes between AnthropicDirect /
      // OpenAICompatible per `providerForModel(model)`. Without this, every
      // child inherits the legacy hardcoded AnthropicDirectProvider — which
      // means a gpt-4o parent silently dispatches subagents to
      // api.anthropic.com. See nesting.ts `createChildProviderFactory`.
      childConfig.provider = this.ctx.childProviderFactory({
        childExecutor,
        ...(childSkillExecutor !== undefined ? { childSkillExecutor } : {}),
        ...(childConfig.model !== undefined ? { model: childConfig.model } : {}),
        // Effective tool access for the dispatched child: the pre-existing
        // cage (read-only skill fan-out), intersected with the named agent's
        // resolved allowlist when one is in play (computed above). The
        // dispatcher both enforces this at the permission gate AND filters
        // the advertised schema to match (dispatcher.ts toolDefs), so a
        // research-agent child never even sees bash/write_file/agent.
        ...(effectiveAllowedTools !== undefined ? { allowedTools: effectiveAllowedTools } : {}),
        ...(effectiveReadOnlyBash ? { readOnlyBash: true } : {}),
      });
    } else if (effectiveAllowedTools !== undefined || effectiveReadOnlyBash) {
      // Restricted dispatch at the depth cap (or with no factory wired):
      // without an explicit provider the fork would inherit the default
      // UNRESTRICTED provider and the named agent's contract would silently
      // fail open. Build a minimal restricted provider instead — no nested
      // executors (at the cap the child cannot fan out anyway). Mirrors the
      // cap-path fix in skill-executor.ts buildForkedChildConfig.
      childConfig.provider = buildSkillRestrictedProvider(
        effectiveAllowedTools ?? [...CHILD_ALLOWED_TOOLS],
        childConfig.model,
        effectiveReadOnlyBash,
        this.ctx.defaultConfig.openaiBaseUrl,
      );
    }

    let handle: Awaited<ReturnType<SubagentManager['forkSubagent']>>;
    try {
      handle = await this.ctx.subagentManager.forkSubagent({
        parent: this.ctx.parentSession,
        parentId: call.id,
        config: childConfig,
        idPrefix: parsed.id_prefix,
        // Derive a human-readable render label. If the caller supplied a
        // meaningful id_prefix (not the default 'agent-tool'), use it.
        // Otherwise fall back to the first 40 chars of the prompt — the
        // most informative hint available at the raw agent dispatch site.
        //
        // External constraint: this string flows unsanitized through the TUI
        // tree-connector path (`formatToolLine` uses a regex with the `s`
        // flag that passes embedded newlines through). Strip ANSI escapes
        // and collapse interior newlines BEFORE slicing, so the rendered
        // line cannot be split mid-glyph or injected with control codes.
        // Named dispatches render as Agent(<type>) — the registry name is
        // trusted display input (already validated at registration). Unnamed
        // dispatches keep the id_prefix / prompt-slice derivation.
        agentType: namedAgent !== undefined
          ? namedAgent.name
          : (parsed.id_prefix && parsed.id_prefix !== 'agent-tool')
            ? stripEscapeSequences(parsed.id_prefix).replace(/[\r\n]+/g, ' ').trim() || 'agent'
            : stripEscapeSequences(parsed.prompt).replace(/[\r\n]+/g, ' ').slice(0, 40).trim() || 'agent',
        // A forked sub-agent has no human relationship of its own: it returns
        // findings (including Blocked/Asking) to its PARENT, which owns the
        // operator surface. Deny MCP elicitation for BOTH foreground and
        // background forks — together with the isNonInteractive default in
        // subagent.ts this makes every sub-agent uniformly non-interactive.
        // (Previously only background denied; foreground leaked elicitations to
        // the REPL/Telegram human via the process-wide elicitation router.)
        denyElicitations: true,
      });
      // Backfill: give the depth-1 child executor a real parentId so any
      // depth-2 forks it spawns carry handle.id as their parentId.
      if (childParentSession !== undefined) {
        childParentSession.sessionId = handle.id;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void emitTelemetry({
        ...identity,
        event: 'subagent.failed',
        subagent_id: 'unknown',
        id_prefix: parsed.id_prefix,
        parent_session_id: this.ctx.parentSession.sessionId,
        status: 'failed',
        error_message: truncate(message),
        depth,
      });
      return {
        content: `Failed to fork subagent: ${message}`,
        isError: true,
      };
    }

    // ------------------------------------------------------------------
    // Background-mode branch.
    //
    // External constraint: the parent SDK tool-use loop expects a
    // ToolResult per ToolCall *before the next assistant turn begins*.
    // Background mode honors that contract by returning immediately with
    // a structured pointer. The handle keeps running detached; the
    // parent's AbortGraph still owns its lifetime (parent abort
    // cascades down), and the registry's terminal-state callback
    // captures the eventual outcome for explicit `join`.
    //
    // We deliberately do NOT wire the call.signal -> handle.cancel
    // bridge here. That bridge ties the child's lifetime to the parent
    // tool-call's signal, which is exactly wrong for fire-and-forget:
    // the tool-call signal aborts at end-of-turn, and a background
    // job is supposed to outlive the turn that spawned it. Cascade
    // on parent-session abort still works because forkSubagent
    // installs the SubagentManager root abort wiring independently.
    // ------------------------------------------------------------------
    if (parsed.mode === 'background') {
      const registry = this.ctx.backgroundRegistry;
      if (!registry) {
        // Tear down the orphaned handle so the fork isn't leaked.
        // teardown() is the safe no-op when the handle hasn't started.
        await handle.teardown().catch((e: unknown) =>
          debugLog('subagent-executor: handle teardown failed: ' + (e instanceof Error ? e.message : String(e))),
        );
        return {
          content:
            'Background mode is not available in this session — no BackgroundAgentRegistry is wired. ' +
            'Re-issue the call with mode="foreground" or run inside `afk interactive`.',
          isError: true,
        };
      }
      let job: ReturnType<typeof registry.register>;
      try {
        job = registry.register({
          handle,
          prompt: parsed.prompt,
          model: childConfig.model ?? 'sonnet',
          parentSessionId: this.ctx.parentSession.sessionId,
        });
      } catch (e) {
        if (e instanceof BackgroundJobCapError) {
          // Cap exceeded — tear down the orphaned handle so the fork isn't leaked.
          await handle.teardown().catch((te: unknown) =>
            debugLog('subagent-executor: handle teardown failed after cap error: ' + (te instanceof Error ? te.message : String(te))),
          );
          return {
            content: e.message,
            isError: true,
          };
        }
        throw e;
      }
      const payload = {
        status: 'running' as const,
        jobId: job.jobId,
        subagentId: job.subagentId,
        label: job.label,
        message:
          `Background subagent started (jobId=${job.jobId}). ` +
          `It is running detached; its result will be delivered into this context ` +
          `automatically with the next user message once it finishes. ` +
          `/bgsub:join ${job.jobId} remains available for manual replay.`,
      };
      return { content: JSON.stringify(payload) };
    }

    // Wire abort: if signal fires, cancel the handle (foreground only —
    // see comment on the background branch above for why).
    const abortListener = () => {
      void handle.cancel();
    };
    call.signal.addEventListener('abort', abortListener, { once: true });

    const startedAt = Date.now();
    const parentSessionId = this.ctx.parentSession.sessionId;

    // ------------------------------------------------------------------
    // Promotion plumbing (user-triggered backgrounding of a running
    // foreground subagent — Ctrl+B).
    //
    // External constraint: the parent model is suspended at the single
    // `runToResult` await below for this subagent's entire lifetime, and
    // its progress reaches the UI through a side-channel progress sink —
    // NOT via events on the parent stream. So a keyboard flag polled in the
    // turn loop cannot interrupt this await. Instead we expose a promotion
    // trigger through the narrow SubagentControl seam: when fired, it wins a
    // race against the run; we hand the still-running handle to the
    // BackgroundAgentRegistry and return the same synthetic "running"
    // pointer the mode:'background' branch returns — unblocking the parent
    // turn while the subagent keeps running detached.
    //
    // `promoted` gates the finally so a promoted (detached) handle and its
    // child manager are NOT torn down here: the registry now owns the
    // handle's lifetime, bounded by parent-session abort exactly like a
    // natively-backgrounded job.
    // ------------------------------------------------------------------
    let promoted = false;
    let firePromotion!: () => void;
    const promotionSignal = new Promise<void>((resolve) => {
      firePromotion = resolve;
    });
    let resolveJob!: (info: PromotedSubagentInfo | null) => void;
    const jobReady = new Promise<PromotedSubagentInfo | null>((resolve) => {
      resolveJob = resolve;
    });
    this.promotionTriggers.set(handle.id, { fire: firePromotion, ready: jobReady });
    // Registry-independent cancel handle (soft-stop path). Removed in the same
    // finally as the promotion trigger below.
    this.activeForegroundHandles.set(handle.id, handle);

    // In-turn SubagentStop delivery.
    //
    // Invariant (delivery order — externally governed by the SDK tool-use
    // protocol): SubagentStop fires from `handle.teardown()` in the `finally`
    // below, which runs BEFORE this async execute() resolves and its
    // tool_result is assembled/sent. So a foreground `agent` fork can carry the
    // stop hook's `injectContext` (e.g. the shadow-verify nudge) in-turn — as
    // part of the SAME tool_result the parent sees — instead of via the
    // deferred queue channel. We therefore hoist the completion ToolResult into
    // `toolResult` (rather than returning inside the try) and, after teardown
    // records the note, append it to `toolResult.content`. Exactly-once:
    // `teardown({ deferInjectContextToCaller: true })` suppresses the queue
    // push for this stop, so the note rides the tool_result OR the queue, never
    // both. The promoted / error-rethrow / abort paths leave `toolResult`
    // unset, so no append happens on them (queue/registry semantics preserved).
    let toolResult: ToolResult | undefined;

    // Start the run but don't await it directly — race it against the
    // promotion signal. The same `runPromise` is handed to the registry on
    // promotion (it must NOT be re-run via runInBackground; see adoptRunning).
    const runPromise = handle.runToResult(parsed.prompt);
    try {
      const outcome = await Promise.race<
        | { kind: 'result'; result: Awaited<typeof runPromise> }
        | { kind: 'promote' }
      >([
        runPromise.then((result) => ({ kind: 'result' as const, result })),
        promotionSignal.then(() => ({ kind: 'promote' as const })),
      ]);

      // Promotion path: hand the in-flight handle to the background registry
      // and return the synthetic running pointer (mirrors mode:'background').
      // Falls through to await the run normally when no registry is wired or
      // the background-job cap is hit — the subagent is never dropped.
      if (outcome.kind === 'promote') {
        const registry = this.ctx.backgroundRegistry;
        if (registry) {
          try {
            const job = registry.adoptRunning({
              handle,
              runPromise,
              prompt: parsed.prompt,
              model: childConfig.model ?? 'sonnet',
              parentSessionId,
            });
            promoted = true;
            // Detach the end-of-turn abort bridge — the promoted job must
            // outlive the turn that spawned it, exactly like mode:'background'.
            call.signal.removeEventListener('abort', abortListener);
            resolveJob({ jobId: job.jobId, label: job.label });
            return {
              content: JSON.stringify({
                status: 'running' as const,
                jobId: job.jobId,
                subagentId: job.subagentId,
                label: job.label,
                message:
                  `Subagent backgrounded by user (jobId=${job.jobId}). ` +
                  `It keeps running detached; its result will be delivered into ` +
                  `this context automatically with the next user message once it ` +
                  `finishes. /bgsub:join ${job.jobId} remains available for manual replay.`,
              }),
            };
          } catch (e) {
            // Cap hit (or registry refusal): stay foreground. Mark the trigger
            // "not promoted" and await the run normally below.
            debugLog(
              'subagent-executor: promotion failed, staying foreground: ' +
                (e instanceof Error ? e.message : String(e)),
            );
            resolveJob(null);
          }
        } else {
          resolveJob(null);
        }
      }

      // Normal completion: result already in hand from the race, or promotion
      // fell through and we await the still-running run.
      const result = outcome.kind === 'result' ? outcome.result : await runPromise;

      // Extract success or failure
      if (result.status === 'succeeded' && result.message) {
        const rawContent = result.message.content;
        // Guard against non-string content (e.g. SDK may return a ContentBlock[])
        const content = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);
        const trace = result.trace;
        void emitTelemetry({
          ...identity,
          event: 'subagent.completed',
          subagent_id: handle.id,
          parent_session_id: parentSessionId,
          status: result.status,
          duration_ms: Date.now() - startedAt,
          content_chars: content.length,
          depth,
          tool_call_count: trace?.toolCalls.length,
          // Preserve `false` ("confirmed absent") distinctly from `undefined`
          // ("no trace available"); `|| undefined` would collapse both.
          thinking_present: trace != null ? trace.thinkingPresent : undefined,
          tool_names: trace?.toolCalls.length
            ? JSON.stringify([...new Set(trace.toolCalls.map(tc => tc.name))])
            : undefined,
        });
        // Assign (don't return) so the finally can append the in-turn
        // SubagentStop injectContext after teardown. See `toolResult` above.
        toolResult = { content };
        return toolResult;
      }

      const errorMessage =
        result.error?.message ?? 'Subagent failed with no output';
      const failedTrace = result.trace;
      void emitTelemetry({
        ...identity,
        event: 'subagent.failed',
        subagent_id: handle.id,
        id_prefix: parsed.id_prefix,
        parent_session_id: parentSessionId,
        status: result.status,
        duration_ms: Date.now() - startedAt,
        error_message: truncate(errorMessage),
        schema_error: result.schemaError
          ? truncate(result.schemaError.message)
          : undefined,
        partial_output_chars: measurePartial(result.partialOutput),
        depth,
        // Mirror trace fields on the failure path — failed subagents are the
        // highest-value debugging target and benefit most from this signal.
        tool_call_count: failedTrace?.toolCalls.length,
        thinking_present: failedTrace != null ? failedTrace.thinkingPresent : undefined,
        tool_names: failedTrace?.toolCalls.length
          ? JSON.stringify([...new Set(failedTrace.toolCalls.map(tc => tc.name))])
          : undefined,
      });
      // Audit §F.1: surface a structured JSON payload to the parent model
      // instead of a plain error string, so the model can distinguish
      // schema mismatch / partial output / hard failure rather than seeing
      // a flattened "Subagent failed: ..." line.
      const payload = buildFailurePayload({
        status: result.status,
        errorMessage,
        schemaErrorMessage: result.schemaError?.message,
        partialOutput: result.partialOutput,
        subagentId: handle.id,
      });
      // Assign (don't return) so the finally can append the in-turn
      // SubagentStop injectContext after teardown. See `toolResult` above.
      toolResult = {
        content: JSON.stringify(payload),
        isError: true,
      };
      return toolResult;
    } catch (err) {
      // Defense in depth: an unexpected throw (e.g. timeout that surfaces
      // as a rejection rather than a `failed` status) should still emit
      // telemetry before propagating. The outer call chain treats a thrown
      // execute() as an error path; we preserve that by re-throwing.
      const message = err instanceof Error ? err.message : String(err);
      void emitTelemetry({
        ...identity,
        event: 'subagent.failed',
        subagent_id: handle.id,
        id_prefix: parsed.id_prefix,
        parent_session_id: parentSessionId,
        status: 'failed',
        duration_ms: Date.now() - startedAt,
        error_message: truncate(message),
        depth,
      });
      throw err;
    } finally {
      this.promotionTriggers.delete(handle.id);
      this.activeForegroundHandles.delete(handle.id);
      // Safety net: if the run won the race (or threw) before a fired
      // promotion could be honored, resolve the trigger so a concurrent
      // promoteActiveForeground() await never hangs. Idempotent — a no-op
      // once resolveJob has already settled on the promotion path.
      resolveJob(null);
      if (!promoted) {
        call.signal.removeEventListener('abort', abortListener);
        await childManager?.teardownAll();
        // Defer the SubagentStop injectContext to this caller so it rides the
        // tool_result in-turn instead of the deferred queue. teardown() fires
        // SubagentStop; with deferInjectContextToCaller the queue push is
        // suppressed and the note (if any) is readable below.
        await handle.teardown({ deferInjectContextToCaller: true });
        // In-turn append: only when this foreground run produced a completion
        // ToolResult (success or structured failure). The error-rethrow path
        // leaves toolResult unset — nothing to append to, note is dropped for
        // that stop by design (the throw is the parent's signal). Attribution:
        // the note is appended to THIS subagent's own result, so a parent
        // batching multiple `agent` calls sees each nudge next to its result.
        // Optional-chain: real SubagentHandleImpl always defines this; the
        // `?.()` tolerates narrow handle doubles (returns undefined = no note).
        const injectContext = handle.getLastStopInjectContext?.();
        if (toolResult !== undefined && injectContext !== undefined && injectContext.length > 0) {
          toolResult.content = `${toolResult.content}\n\n${injectContext}`;
        }
      }
    }
  }
}
