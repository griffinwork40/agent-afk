/**
 * Shared nesting constants and factories for Agent + Skill tool child sessions.
 *
 * Extracted here to avoid circular imports between subagent-executor and
 * skill-executor and to de-duplicate the identical factory lambdas that were
 * copy-pasted across chat.ts, bootstrap.ts, and telegram.ts.
 *
 * @module agent/tools/nesting
 */

import type { IAgentSession } from '../types.js';
import type { ModelProvider } from '../provider.js';
import type { AgentModelInput } from '../types.js';
import type { Surface } from '../awareness/types.js';
import { AnthropicDirectProvider } from '../providers/anthropic-direct/index.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible/index.js';
import { providerForModel } from '../providers/index.js';
import { BUILTIN_TOOL_NAMES } from './schemas.js';
import { AWARENESS_TOOL_NAMES } from '../awareness/index.js';
import { READ_ONLY_PHASE_TOOLS } from '../tool-category.js';
import { SkillExecutor } from './skill-executor.js';
import type { SubagentExecutor } from './subagent-executor.js';
import type { TraceWriter } from '../trace/index.js';
import type { BackgroundAgentRegistry } from '../background-registry.js';

export const DEFAULT_MAX_NESTING_DEPTH = 3;

export interface ChildProviderFactoryArgs {
  childExecutor: SubagentExecutor;
  childSkillExecutor?: SkillExecutor;
  /**
   * Resolved child model. Drives the provider selection so an OpenAI-routed
   * child (gpt-*, o*, codex-*, HF-style `org/model`) gets an
   * `OpenAICompatibleProvider` instead of inheriting the hardcoded
   * `AnthropicDirectProvider` — which previously caused local-only sessions
   * (e.g. `afk interactive --model gpt-4o`) to silently dispatch every
   * `agent`/`skill` subagent to api.anthropic.com.
   *
   * When undefined, the factory falls back to `AnthropicDirectProvider`
   * (legacy default, preserved for the Anthropic-everywhere path).
   */
  model?: AgentModelInput;
  /**
   * Tool allowlist for the forked child's provider. When set, becomes the
   * child provider's `permissions.allowedTools`. Used to pass
   * {@link RECON_ALLOWED_TOOLS} for a read-only skill's child (stripping
   * `write_file`/`edit_file`). When undefined, defaults to
   * {@link CHILD_ALLOWED_TOOLS} (full write surface — the legacy default).
   */
  allowedTools?: string[];
  /**
   * When true, the child provider's per-query dispatcher blocks mutating
   * `bash` commands. Set together with `allowedTools: RECON_ALLOWED_TOOLS`
   * for a read-only skill's forked child. Defaults to false.
   */
  readOnlyBash?: boolean;
}

/** Minimal session stub for child executors that only need an abort signal. */
export function createStubParentSession(
  signal: AbortSignal,
): Pick<IAgentSession, 'sessionId' | 'getInputStreamRef' | 'abortSignal'> {
  return {
    sessionId: undefined,
    getInputStreamRef: () => ({ pushUserMessage: () => {} }),
    abortSignal: signal,
  };
}

// 'compose' is intentionally excluded from child allowed tools. Compose nodes
// are task workers — if they could use the compose tool they could spawn nested
// DAGs, leading to unbounded fan-out and recursive orchestration. Do NOT add
// 'compose' here without a depth-limit mechanism similar to DEFAULT_MAX_NESTING_DEPTH.
//
// Awareness tools (`get_runtime_state`) are critical for children — the tool's
// description explicitly invites callers to use it "when uncertain about your
// current nesting depth". Source of truth: `agent/awareness/tool.ts`.
//
// 'memory_search' is included because READ_ONLY_PHASE_TOOLS (src/agent/tool-category.ts:175)
// — the most restricted role in the system (mint's spec/research/plan phases) — already trusts
// it ("read-only by construction"). Excluding memory_search for general sub-agents while
// allowing it in the more restricted role is incoherent. 'memory_update' and 'procedure_write'
// are deliberately NOT included: memory_update with target:"hot" mutates HOT.md, which is
// injected into every future session's system prompt — blast radius too large for unsupervised
// sub-agent writes. If specific skills need memory write access, do it per-skill via a
// buildPhaseRestrictedProvider-style opt-in builder (see nesting.ts around line 207), not by
// extending this global default.
export const CHILD_ALLOWED_TOOLS = [...BUILTIN_TOOL_NAMES, ...AWARENESS_TOOL_NAMES, 'memory_search', 'agent', 'skill'];

// Recon allowlist for a READ-ONLY skill's forked child. This is the tool half
// of read-only-skill enforcement (the bash half is the dispatcher's
// `readOnlyBash` gate). A read-only skill (e.g. `ground-state`) is pure
// pre-flight reconnaissance: it reads files, greps, lists, scrapes, recalls
// memory, runs read-only bash (git status/log/diff for dirty-tree detection),
// and fans out surveyors via `agent`/`skill`. It must NOT mutate the repo — so
// `write_file` and `edit_file` are excluded entirely, and `bash` is admitted
// only behind the mutating-command guard.
//
// Excluded vs CHILD_ALLOWED_TOOLS: write_file, edit_file (file mutation),
// config_set (mutates ~/.afk/config — config_get IS included for recon reads),
// send_telegram (side-effecting notification), browser_* (stateful automation
// that can submit forms / mutate remote state), terminal_font_size +
// ask_question (environment / operator-prompt tools with no recon role), and
// all schedule tools (create/list/get_history/cancel — scheduling is a
// mutation of daemon state). `bash` IS included (read-only recon needs it) and
// is gated by classifyBashCommand in the dispatcher. `agent`/`skill` ARE
// included so the surveyor fan-out the SKILL.md prescribes still works.
export const RECON_ALLOWED_TOOLS: readonly string[] = [
  'read_file',
  'glob',
  'grep',
  'list_directory',
  // config_get is a masked read of ~/.afk/config — recon may inspect config but
  // config_set (write) is deliberately excluded, mirroring READ_ONLY_PHASE_TOOLS.
  'config_get',
  'bash',
  'web_scrape',
  ...AWARENESS_TOOL_NAMES,
  'memory_search',
  'agent',
  'skill',
];

// Skills treated as read-only by NAME, independent of their SKILL.md
// frontmatter. Keying on name (not just the `read-only:` frontmatter flag)
// protects users running ANY copy of the SKILL.md — including a bundled or
// vendored copy whose frontmatter has not been (or cannot be) edited. A skill
// is enforced read-only when `frontmatter.readOnly === true` OR its name is in
// this set. Initially contains only `ground-state` (the proven offender: it
// made 22 edit_file + 27 bash calls in one session despite "never edits files"
// prose). Add a name here only for skills that are genuinely read-only recon.
export const DEFAULT_READ_ONLY_SKILLS: ReadonlySet<string> = new Set(['ground-state']);

/**
 * Bootstrap-time options captured by closure into the factory returned by
 * {@link createChildProviderFactory}. Held at factory-construction (not
 * passed per-call) because the values are session-wide and rarely change
 * between sibling dispatches — folding them into closure keeps every
 * call site in the executors free of provider-routing detail.
 */
export interface CreateChildProviderFactoryOptions {
  /**
   * OpenAI-compatible endpoint URL. Forwarded as `baseURL` when the factory
   * builds an `OpenAICompatibleProvider` for an OpenAI-routed child. Sourced
   * at bootstrap from `cliConfig.openaiBaseUrl` (env `AFK_OPENAI_BASE_URL`)
   * so local-server runs (mlx_lm.server, Ollama, vLLM, llama.cpp,
   * LM Studio) keep hitting their configured shim rather than the default
   * api.openai.com.
   */
  openaiBaseUrl?: string;
}

/**
 * Build the factory the executors use to construct provider instances for
 * forked child sessions.
 *
 * Routing: branches on `providerForModel(model)` (passed per-call by the
 * executor) so a gpt-4o-routed child gets `OpenAICompatibleProvider` and a
 * sonnet-routed child gets `AnthropicDirectProvider`. Both providers accept
 * the same `{ permissions, subagentExecutor, skillExecutor }` surface
 * (verified at openai-compatible/index.ts:45-72 vs anthropic-direct).
 *
 * Without this routing the executors would inherit the historic hardcoded
 * `AnthropicDirectProvider`, and an OpenAI-routed parent would silently
 * dispatch every subagent to api.anthropic.com — the bug reported in the
 * "local models (openai) dispatching anthropic-direct subagents" thread.
 */
export function createChildProviderFactory(
  opts: CreateChildProviderFactoryOptions = {},
): (args: ChildProviderFactoryArgs) => ModelProvider {
  return ({ childExecutor, childSkillExecutor, model, allowedTools, readOnlyBash }) => {
    const providerOpts = {
      // A read-only skill's child passes `allowedTools: RECON_ALLOWED_TOOLS`
      // (no write_file/edit_file); everyone else gets the full CHILD_ALLOWED_TOOLS.
      permissions: { allowedTools: allowedTools ?? CHILD_ALLOWED_TOOLS },
      subagentExecutor: childExecutor,
      ...(childSkillExecutor !== undefined ? { skillExecutor: childSkillExecutor } : {}),
      // Bash gate (read-only skill child). Forwarded into BOTH provider
      // constructors so the per-query dispatcher blocks mutating shell commands.
      ...(readOnlyBash === true ? { readOnlyBash: true } : {}),
    };
    const route = providerForModel(typeof model === 'string' ? model : undefined);
    if (route === 'openai-compatible') {
      return new OpenAICompatibleProvider({
        ...providerOpts,
        ...(opts.openaiBaseUrl !== undefined ? { baseURL: opts.openaiBaseUrl } : {}),
        readOnlyMemory: true,
      });
    }
    // Child sessions get read-only memory access — they may call `memory_search`
    // to recall prior facts but cannot persist new memory (no `memory_update` /
    // `procedure_write`). The parent session is the only writer; allowing writes
    // from subagents would cause uncoordinated fan-out into the shared store.
    return new AnthropicDirectProvider({ ...providerOpts, readOnlyMemory: true });
  };
}

/**
 * Build a provider for a READ-ONLY skill's forked child when the normal
 * factory path is NOT available — i.e. when `childProviderFactory` is unset or
 * the nesting depth cap was hit (the branch in
 * {@link SkillExecutor.buildForkedChildConfig} that returns early without a
 * factory-built provider). In that fallback the child would otherwise inherit
 * the bare provider singleton — with the full write surface and no bash gate —
 * silently defeating read-only enforcement.
 *
 * This helper builds a minimal provider with:
 *   - `permissions.allowedTools = RECON_ALLOWED_TOOLS` (no write_file/edit_file)
 *   - `readOnlyBash: true` (dispatcher blocks mutating bash)
 *   - `readOnlyMemory: true` (consistency with the factory path)
 *   - NO `subagentExecutor` / `skillExecutor` — at the depth cap the child
 *     cannot fan out further anyway, so `agent`/`skill` would be dead schema.
 *
 * Routed by `providerForModel(model)` exactly like
 * {@link createChildProviderFactory} and {@link buildPhaseRestrictedProvider}.
 */
export function buildReadOnlyReconProvider(model: AgentModelInput | undefined): ModelProvider {
  // Materialize the allowlist per call so test/runtime mutation of the shared
  // array doesn't bleed across siblings (mirrors buildPhaseRestrictedProvider).
  const permissions = { allowedTools: [...RECON_ALLOWED_TOOLS] };
  const route = providerForModel(typeof model === 'string' ? model : undefined);
  if (route === 'openai-compatible') {
    return new OpenAICompatibleProvider({ permissions, readOnlyBash: true, readOnlyMemory: true });
  }
  return new AnthropicDirectProvider({ permissions, readOnlyBash: true, readOnlyMemory: true });
}

/**
 * Build a depth-aware factory that produces a {@link SkillExecutor} for a
 * grandchild session at the given `depth`.
 *
 * The factory closes over `childProviderFactory` so the grandchild
 * SkillExecutor itself can fan out further (up to `maxDepth`). The
 * returned factory recursively references itself via the local `factory`
 * variable so any depth in the chain — skill→skill→skill — gets the same
 * nesting wiring. Without this propagation, the first nested skill child
 * would have `agent`/`skill` tools, but its skill grandchildren would
 * silently fall back to the bare provider (the same bug the depth-0
 * caller fixes).
 *
 * `defaultSubagentModel` is the resolved default-subagent policy
 * (`getDefaultSubagentModel(parentModel)`) threaded through every depth so
 * nested skill children inherit the SAME policy the top-level executors use.
 * When omitted (legacy/test callers), the nested SkillExecutor's
 * `defaultSubagentModel` stays undefined and its own fallback chain applies.
 *
 * Invariant: this parameter closes the "subagent model falls back to
 * Anthropic sonnet under an OpenAI-routed parent" leak. A nested SkillExecutor
 * built without it has `defaultSubagentModel: undefined`; that undefined then
 * flows into the child SubagentExecutor it constructs
 * (skill-executor.ts buildForkedChildConfig), whose `agent`-tool resolution is
 * `parsed.model ?? defaultSubagentModel ?? 'sonnet'` — with no `defaultModel`
 * link, so an unset `defaultSubagentModel` routes straight to Anthropic
 * `sonnet` even when the whole session is OpenAI-only (→ "missing Anthropic
 * credentials"). Threading the resolved value here keeps every depth on the
 * parent's provider. Explicit `agent.model` / SKILL.md `model:` still win —
 * this only governs the no-model-specified default.
 */
export function createChildSkillExecutorFactory(
  defaultModel: AgentModelInput,
  apiKey: string | undefined,
  childProviderFactory: (args: ChildProviderFactoryArgs) => ModelProvider,
  baseUrl?: string,
  traceWriter?: TraceWriter,
  backgroundRegistry?: BackgroundAgentRegistry,
  cwd?: string,
  resolveApiKeyForModel?: (model: string) => string | undefined,
  surface?: Surface,
  defaultSubagentModel?: AgentModelInput,
): (depth: number, maxDepth: number, signal: AbortSignal) => SkillExecutor {
  const factory: (depth: number, maxDepth: number, signal: AbortSignal) => SkillExecutor = (
    depth,
    maxDepth,
    signal,
  ) =>
    new SkillExecutor({
      parentSession: createStubParentSession(signal),
      defaultModel,
      // Resolved default-subagent policy threaded through every depth so a
      // nested skill child (and the SubagentExecutor it builds) defaults to the
      // parent's provider rather than the Anthropic `sonnet` literal. Optional:
      // when the caller omits it, back-compat fallback chains apply. See the
      // leak-closure invariant in this factory's jsdoc.
      ...(defaultSubagentModel !== undefined ? { defaultSubagentModel } : {}),
      apiKey,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      depth,
      maxDepth,
      childProviderFactory,
      childSkillExecutorFactory: factory,
      // Trace writer propagates through every depth so grandchild skill forks
      // remain visible. Optional so non-traced call sites (tests, telegram,
      // threads) keep working.
      ...(traceWriter !== undefined ? { traceWriter } : {}),
      // Invariant: background-mode dispatch requires the registry on every
      // SkillExecutor in the nesting chain too, not just the root. A
      // grandchild plugin-skill subagent calling `agent` with
      // `mode:"background"` reaches the registry through SkillExecutor →
      // buildForkedChildConfig → SubagentExecutor.ctx.backgroundRegistry.
      // Optional: chat/threads/telegram surfaces deliberately omit it.
      ...(backgroundRegistry !== undefined ? { backgroundRegistry } : {}),
      // Worktree isolation: forward cwd through every depth so a
      // grandchild SkillExecutor's per-call SubagentManager (and its
      // recursive SubagentExecutor's childManager) all anchor to the
      // worktree. Mirrors traceWriter / backgroundRegistry propagation.
      // Without this, a depth ≥ 2 skill dispatch silently loses worktree
      // isolation even though the depth-0 wiring was correct.
      ...(cwd !== undefined ? { cwd } : {}),
      // Per-model credential resolver: propagates so every depth in the
      // skill chain resolves credentials by child model rather than the
      // pre-captured parent apiKey. Optional — backward compat fallback to
      // apiKey when absent.
      ...(resolveApiKeyForModel !== undefined ? { resolveApiKeyForModel } : {}),
      // Surface propagates through every depth so grandchild SkillExecutor
      // routing-decision rows carry the correct origin/actor. Mirrors how
      // SubagentExecutor threads surface into its recursive child executor
      // (subagent-executor.ts:626).
      ...(surface !== undefined ? { surface } : {}),
    });
  return factory;
}

/**
 * Phase roles for forked subagents in orchestration skills (e.g. mint).
 *
 * - `'read-only'`: dispatcher rejects any tool not in `READ_ONLY_PHASE_TOOLS`.
 *   Used for plan-only phases (spec, research, plan) that must not mutate the
 *   repo before user approval.
 * - `'read-write'`: no enforcement; default behavior.
 *
 * Type lives in `nesting.ts` (not `subagent.ts`) so the dispatcher and the
 * fork-time helper share the same authoritative source.
 */
export type PhaseRole = 'read-only' | 'read-write';

/**
 * Build a provider whose `permissions.allowedTools` is restricted to the
 * explicit `allowedTools` list parsed from a plugin SKILL.md `tools:` field.
 *
 * Invariant: this is the ONLY path that connects a SKILL.md `tools:` frontmatter
 * list to the dispatcher's permission gate. Setting `AgentConfig.tools.allowedTools`
 * directly is NOT equivalent — that field is read only by `emitSubagentLifecycle`
 * for telemetry and does not reach the dispatcher.
 *
 * @see {@link buildPhaseRestrictedProvider} for the analogous read-only-phase path.
 * @see `SkillExecutor.executePluginSkill` for the caller wiring.
 */
export function buildSkillRestrictedProvider(
  allowedTools: string[],
  model: AgentModelInput | undefined,
): ModelProvider {
  // Materialise once per fork so runtime array mutations don't bleed across siblings.
  const permissions = { allowedTools: [...allowedTools] };
  const route = providerForModel(typeof model === 'string' ? model : undefined);
  if (route === 'openai-compatible') {
    return new OpenAICompatibleProvider({ permissions });
  }
  return new AnthropicDirectProvider({ permissions });
}

/**
 * Build a provider whose `permissions.allowedTools` is restricted to
 * `READ_ONLY_PHASE_TOOLS`. Routed by model: OpenAI-compatible models get an
 * `OpenAICompatibleProvider`; everything else falls back to
 * `AnthropicDirectProvider`. Both providers thread `permissions` through to
 * their per-query `SessionToolDispatcher`, which enforces the allowlist at
 * `dispatcher.ts:348` via `checkToolPermission`.
 *
 * Invariant: this is the ONLY path that connects a phase role to the
 * dispatcher's permission gate. Setting `AgentConfig.tools.allowedTools`
 * directly is NOT equivalent — that field is read only by
 * `emitSubagentLifecycle` for telemetry (`subagent.ts:380-382`) and does
 * not reach the dispatcher.
 *
 * @see {@link READ_ONLY_PHASE_TOOLS} for the allowed-tool set.
 * @see `SubagentManager.forkSubagent` for the caller wiring.
 */
export function buildPhaseRestrictedProvider(
  // Parameter kept for forward-compat: future phase roles (e.g.
  // 'read-only-with-network', 'read-only-no-memory') will pass distinct
  // values here. The `_` prefix silences `noUnusedParameters` until then.
  _role: 'read-only',
  model: AgentModelInput | undefined,
): ModelProvider {
  // The allowlist is materialized once per fork so any test or runtime
  // mutation of the array doesn't bleed across sibling subagents.
  const permissions = { allowedTools: [...READ_ONLY_PHASE_TOOLS] };
  const route = providerForModel(typeof model === 'string' ? model : undefined);
  if (route === 'openai-compatible') {
    return new OpenAICompatibleProvider({ permissions });
  }
  // 'anthropic' / 'anthropic-direct' / fallback all route here. Mirrors the
  // resolveProvider() default to keep the read-only path consistent with
  // the unrestricted path.
  return new AnthropicDirectProvider({ permissions });
}
