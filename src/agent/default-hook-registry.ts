/**
 * Factory for a `HookRegistry` pre-populated with the built-in
 * hook handlers. Entry points should use this instead of the bare
 * `createHookRegistry()` unless they explicitly want no built-ins.
 *
 * @module agent/default-hook-registry
 */

import { createHookRegistry, type HookRegistry } from './hooks.js';
import { installPluginHooks } from './plugins/load-entrypoints.js';
import { createShadowVerifyNudge } from './shadow-verify-nudge.js';
import { createPlaceholderDetectHook } from './placeholder-detect.js';
import { createPlaceholderPreventHook } from './placeholder-prevent.js';
import { createAskQuestionGate } from './ask-question-gate.js';
import { createSafeDestructDetect } from './safe-destruct-detect.js';
import { createReleaseBoundaryDetect } from './release-boundary-detect.js';
import { createShadowGitDetect } from './shadow-git-detect.js';
import { MemoryStore, createMemorySessionEndHook, createChildMemoryHotBlockHook } from './memory/index.js';
import { createPlanModeGate } from './plan-mode-gate.js';
import { createAfkModeGate } from './afk-mode-gate.js';
import { cleanupComposeSpills } from './tools/compose-executor.format.js';
import { runReceiptSessionEndHook } from './trace/receipt.js';
import { createFacetSessionEndHook } from './facets/session-end-hook.js';
import { createPreexistingLedgerHook } from './preexisting-ledger/session-end-hook.js';
import { createOutcomeSessionEndHook, createChildAttributionHook } from './outcomes/index.js';
import { createSpineSessionEndHook } from './spine/index.js';
import { inboundAttachmentRegistry } from './content/attachment-registry.js';
import { env } from '../config/env.js';
import { createEffectLedgerHooks } from './effect-ledger/index.js';
import {
  createPathApprovalHook,
  type PathApprovalSurface,
} from './tools/hooks/path-approval-hook.js';
import { createBashRestrictionHook } from './tools/hooks/bash-restriction-hook.js';
import { createEditPreviewHook, type PreviewDiffRef } from './tools/hooks/edit-preview-hook.js';
import type { PermissionMode } from './types/sdk-types.js';
import type { TraceSink } from './trace/index.js';
import type { LoadedHooksConfig } from './hooks/config-loader.js';
import { loadAndRegisterConfigHooks } from './hooks/config-bridge.js';
import { createWhatifEpisodeGate } from './whatif-episode-gate.js';
import { createEpisodeSessionEndHook } from './episodes/session-end-hook.js';
import { createUnprovenDiagnosisDetectHook } from './unproven-diagnosis-detect.js';
import { createInlineImageHook } from './tools/hooks/inline-image-hook.js';

export interface SubagentCompleteInfo {
  subagentId: string;
  status: string;
  durationMs?: number;
  agentType?: string;
}

export interface DefaultHookRegistryResult {
  registry: HookRegistry;
  memoryStore: MemoryStore;
  /**
   * Mutable ref the StreamRenderer arms at turn start. The edit-preview hook
   * calls `addPreviewDiffRef.current(toolUseId, diff)` to deliver previews
   * to the tool lane. Remains a no-op `() => {}` on non-interactive surfaces
   * (the ref is never populated outside the REPL bootstrap).
   */
  addPreviewDiffRef: PreviewDiffRef;
}

/**
 * Fires at most once per process: a heads-up that path-approval was disabled
 * via AFK_DISABLE_PATH_APPROVAL=1, so the operator's session output reflects
 * that typed-file path-access prompts and bash restrictions are OFF (the
 * setting was otherwise completely silent — no log, no audit trail). Module-
 * scoped so subagents / repeated session construction don't spam the warning.
 */
let warnedPathApprovalDisabled = false;

/**
 * Distinct hooks-config loader warnings already surfaced this process. The
 * loader records non-fatal problems (parse/schema errors, and the orphan
 * root-settings notice for a misplaced `$AFK_HOME/settings.json`) on
 * `LoadedHooksConfig.warnings`, documented as "the caller should surface" —
 * but no caller did, so a misplaced root file stayed silent and the owner
 * could believe those hooks were active. We surface them here (the single
 * chokepoint every surface routes through), deduped per distinct message so
 * repeated session construction (daemon ticks, per-chat Telegram sessions)
 * doesn't re-spam the same process-global notice while a genuinely new
 * warning from a later session still surfaces.
 */
const surfacedConfigWarnings = new Set<string>();

/**
 * Test-only: reset the once-per-process warning flag so Vitest files that
 * exercise the AFK_DISABLE_PATH_APPROVAL=1 warn path don't bleed state into
 * each other (module scope persists across files in a single worker).
 * Production never needs this — the flag is intentionally process-sticky.
 */
export function _resetWarningForTests(): void {
  warnedPathApprovalDisabled = false;
  surfacedConfigWarnings.clear();
}

// Invariant: hooks run sequentially in registration order; a handler that
// returns `decision: 'block'` short-circuits the chain so no later handler
// in the same event fires. Registration order is therefore load-bearing and
// must be preserved exactly across all helper functions below.

/**
 * Register the child-memory hot-write block hook on the given registry.
 * Sub-agents may call `memory_update` with `target:"fact"` (safe — fact
 * archive only) but are blocked from `target:"hot"` (would rewrite HOT.md,
 * injected into every future session's system prompt). The hook is a no-op
 * for top-level sessions (no parentSessionId).
 */
function registerChildMemoryGuard(registry: HookRegistry): void {
  registry.register('PreToolUse', createChildMemoryHotBlockHook());
}

/**
 * Register facet derivation and outcome-labeling hooks: the facet session-end
 * hook, the outcome immediate-pass labeler, and the child artifact attribution
 * listener. Extracted to keep {@link createDefaultHookRegistry} within its
 * baselined line-count ceiling.
 */
function registerFacetAndOutcomeHooks(
  registry: HookRegistry,
  spineRepoRoot?: string,
): void {
  registry.register('SessionEnd', createFacetSessionEndHook());
  registry.register('SessionEnd', createOutcomeSessionEndHook());
  registry.register('PostToolUse', createChildAttributionHook());
  // Background lane: the SPINE classifier is a model call (measured 1-5s per
  // run) that used to gate `/clear`'s screen clear. See RegisterOptions.background.
  registry.register('SessionEnd', createSpineSessionEndHook({ repoRoot: spineRepoRoot }), { background: true });
  registry.register('SessionEnd', createEpisodeSessionEndHook(), { background: true });
  registerPreexistingLedgerHook(registry);
}

/**
 * Register the SessionEnd hooks that clean up per-session transient state:
 * compose-truncation spill files and inbound attachment records. Both are
 * best-effort no-ops when `sessionId` is absent (top-level teardown without
 * an ID, or a non-SessionEnd event routed here by mistake).
 */
function registerSessionEndCleanupHooks(registry: HookRegistry): void {
  registry.register('SessionEnd', (c) => { if (c.event === 'SessionEnd' && c.sessionId) cleanupComposeSpills(c.sessionId); return {}; });
  registry.register('SessionEnd', (c) => { if (c.event === 'SessionEnd' && c.sessionId) inboundAttachmentRegistry.clear(c.sessionId); return {}; });
}

/**
 * Register the subagent-complete forwarding handler when a callback is
 * provided. Extracted from {@link createDefaultHookRegistry} to keep that
 * function within its baselined line-count ceiling.
 */
function registerSubagentCompleteHook(
  registry: HookRegistry,
  onSubagentComplete: ((info: SubagentCompleteInfo) => void) | undefined,
): void {
  if (!onSubagentComplete) return;
  registry.register('SubagentStop', (context) => {
    if (context.event !== 'SubagentStop') return {};
    if (context.status === 'idle' || context.status === 'running') return {};
    onSubagentComplete({
      subagentId: context.subagentId,
      status: context.status,
      durationMs: context.durationMs,
      agentType: context.agentType,
    });
    return {};
  });
}

/**
 * Register the what-if episode gate as the FIRST PreToolUse hook.
 *
 * Self-disables when AFK_WHATIF_EPISODE is not set, so registration is
 * unconditional. Tree-wide: no subagent exemption — episode isolation must
 * hold across every nested fork. Extracted from {@link createDefaultHookRegistry}
 * to keep that function within its baselined line-count ceiling.
 */
function registerWhatifEpisodeGate(registry: HookRegistry): void {
  registry.register('PreToolUse', createWhatifEpisodeGate());
}

/**
 * Register the two-layer placeholder defense and the unproven-diagnosis gate.
 *
 * Layer 1 (Prevention): `SessionStart` `injectContext` — proactively instructs
 * the model to resolve placeholder values from context before presenting shell
 * commands. Fires for top-level sessions only. See `placeholder-prevent.ts`.
 *
 * Layer 2 (Correction): `Stop` hook — scans shellable code blocks for
 * unresolved placeholder tokens and injects a correction. Bounded per session
 * (fails open after 2 corrections). No-op on non-REPL surfaces. See
 * `placeholder-detect.ts`.
 *
 * Unproven-diagnosis gate (issue #2987): `Stop` hook — injects the elimination
 * ladder when the turn closes on an external / cause-unknown diagnosis with no
 * instrumentation evidence. Opt-in via `AFK_UNPROVEN_DIAGNOSIS_GATE=1`. See
 * `unproven-diagnosis-detect.ts`.
 */
function registerPlaceholderAndDiagnosisHooks(registry: HookRegistry): void {
  registry.register('SessionStart', createPlaceholderPreventHook());
  registry.register('Stop', createPlaceholderDetectHook());
  registry.register('Stop', createUnprovenDiagnosisDetectHook());
}

/**
 * Register the pre-existing-defect ledger SessionEnd hook. Scans assistant
 * turns for pre-existing-defect flags and appends JSONL entries to
 * ~/.afk/agent-framework/preexisting-ledger.jsonl. Best-effort; never throws;
 * opt-out via AFK_PREEXISTING_LEDGER_DISABLE=1.
 */
function registerPreexistingLedgerHook(registry: HookRegistry): void {
  registry.register('SessionEnd', createPreexistingLedgerHook());
}

/** AgentOptions shape threaded through {@link createDefaultHookRegistry}. */
type AgentOptions = {
  cwd?: string;
  sessionId?: string;
  traceWriter?: TraceSink;
  afkPromptForApproval?: boolean;
  getTranscriptPath?: () => string | null;
  daemonTaskId?: string;
};

/**
 * Register the session-scoped shadow-verify nudge on both SubagentStop and
 * Stop. The instance is shared so the once-per-turn + once-per-child latch
 * (#355) prevents a parallel verifier wave from spamming the parent with
 * identical nudges.
 */
function registerShadowVerifyNudge(registry: HookRegistry): void {
  const shadowVerifyNudge = createShadowVerifyNudge();
  registry.register('SubagentStop', shadowVerifyNudge);
  registry.register('Stop', shadowVerifyNudge);
}

/**
 * Register the plan-mode gate and AFK-mode safety ceiling when a permission
 * mode getter is provided. Both read the same getter; they are mutually
 * exclusive (autonomous vs. plan), so at most one fires per tool call.
 * The AFK gate applies tree-wide (no subagent exemption) and is long-running
 * because it may await an operator approve/deny via elicitationRouter.
 */
function registerPermissionModeGates(
  registry: HookRegistry,
  getPermissionMode: () => PermissionMode,
  agentOptions: AgentOptions | undefined,
  getCwd: (() => string | undefined) | undefined,
): void {
  registry.register('PreToolUse', createPlanModeGate(getPermissionMode));
  // AFK-mode safety ceiling. getCwd (live) is preferred over the static
  // agentOptions.cwd so the gate's workspace-escape rule tracks a mid-session
  // /cwd change — it is the SOLE path-safety layer in AFK mode (path-approval
  // is disabled via allowAll for 'autonomous'; see agent/permission-policy.ts).
  registry.register(
    'PreToolUse',
    createAfkModeGate(getPermissionMode, agentOptions?.cwd, getCwd, {
      ...(agentOptions?.traceWriter !== undefined ? { traceWriter: agentOptions.traceWriter } : {}),
      // Surface-scoped approval posture. The REPL leaves this default (true =
      // keep-and-fix). The always-on Telegram host passes false → high-risk /
      // irreversible ops HARD-REFUSE + Asking summary. See
      // docs/afk-telegram-native-host.md.
      ...(agentOptions?.afkPromptForApproval !== undefined
        ? { promptForApproval: agentOptions.afkPromptForApproval }
        : {}),
      ...(agentOptions?.sessionId !== undefined ? { sessionId: agentOptions.sessionId } : {}),
      ...(agentOptions?.daemonTaskId !== undefined ? { daemonTaskId: agentOptions.daemonTaskId } : {}),
    }),
    // Longrunning: on a high-risk op the gate awaits elicitationRouter.route()
    // (deny-on-timeout). Bypass the 30s per-handler deadline; the gate
    // forwards the turn signal so session/turn teardown cancels the prompt.
    { longRunning: true },
  );
}

/**
 * Register the edit-preview hook and return the mutable {@link PreviewDiffRef}
 * it delivers previews through. The ref starts as a no-op; the StreamRenderer
 * arms it each turn on TTY surfaces.
 */
function registerEditPreviewHook(registry: HookRegistry): PreviewDiffRef {
  const addPreviewDiffRef: PreviewDiffRef = { current: () => {} };
  registry.register('PreToolUse', createEditPreviewHook({ addPreviewDiffRef }));
  return addPreviewDiffRef;
}

/**
 * Register path-approval and bash-restriction hooks when
 * `AFK_DISABLE_PATH_APPROVAL` is not set. Emits a once-per-process warning
 * when disabled. See the module-level comment block for the grant-manager and
 * nonInteractive semantics.
 *
 * Invariant: path-approval (typed file tools) is registered BEFORE
 * bash-restriction so the model gets the interactive prompt path first when
 * both could apply within a single turn.
 */
function registerPathApprovalAndBashHooks(
  registry: HookRegistry,
  surface: string | undefined,
  getCwd: (() => string | undefined) | undefined,
  agentOptions: AgentOptions | undefined,
): void {
  const disabled = env.AFK_DISABLE_PATH_APPROVAL === '1';
  if (disabled && !warnedPathApprovalDisabled) {
    warnedPathApprovalDisabled = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[path-approval] disabled via AFK_DISABLE_PATH_APPROVAL=1 — typed-file ' +
        'path-access prompts and bash restrictions are OFF for this process.',
    );
  }
  if (disabled) return;
  const pathApproval = createPathApprovalHook({
    // Prefer an explicit getCwd callback (REPL/Telegram bootstrap thread a
    // live `extras.cwd`); otherwise fall back to the static cwd carried in
    // main's `agentOptions` (scheduler/chat/threads callers).
    getCwd: getCwd ?? (() => agentOptions?.cwd),
    surface: mapSurface(surface),
  });
  registry.register(
    'PreToolUse',
    pathApproval.preToolUse,
    // Longrunning: awaits elicitationRouter.route() (no time-based deadline).
    { longRunning: true },
  );
  // PostToolUse revokes "Once" grants; SessionEnd is the safety-net for grants
  // whose PostToolUse never ran (e.g. signal aborted before revoke).
  registry.register('PostToolUse', pathApproval.postToolUse);
  registry.register('SessionEnd', pathApproval.sessionEnd);
  registry.register(
    'PreToolUse',
    createBashRestrictionHook({
      disableInterpreterGuard: env.AFK_DISABLE_BASH_INTERPRETER_GUARD === '1',
      forceInterpreterGuard: env.AFK_FORCE_BASH_INTERPRETER_GUARD === '1',
    }),
  );
}

/**
 * Register the external-effect ledger: write intent on PreToolUse before
 * dispatch, and settle the same record on PostToolUse / PostToolUseFailure.
 * Registered last among built-in tool hooks so it runs after all policy hooks
 * (path-approval once-grant revoke, etc.). PostToolUseFailure coverage ensures
 * thrown tool handlers (the most uncertain-outcome case) are settled too.
 */
function registerEffectLedgerHooks(registry: HookRegistry): void {
  const ledgerHooks = createEffectLedgerHooks();
  registry.register('PreToolUse', ledgerHooks.pre);
  registry.register('PostToolUse', ledgerHooks.post);
  registry.register('PostToolUseFailure', ledgerHooks.post);
}

/**
 * Register config-driven shell hooks after all built-ins so built-in handlers
 * always run first. Surfaces loader warnings (parse/schema errors, orphan
 * root-settings notice) that were computed but previously dropped on the
 * floor — deduped via {@link surfacedConfigWarnings}. No-op when
 * `hookConfig` is undefined (the common case).
 */
function registerConfigHooks(
  registry: HookRegistry,
  hookConfig: LoadedHooksConfig | undefined,
  agentOptions: AgentOptions | undefined,
): void {
  if (hookConfig === undefined) return;
  for (const warning of hookConfig.warnings) {
    if (surfacedConfigWarnings.has(warning)) continue;
    surfacedConfigWarnings.add(warning);
    // eslint-disable-next-line no-console
    console.warn(`[hooks] ${warning}`);
  }
  loadAndRegisterConfigHooks(registry, hookConfig, {
    cwd: agentOptions?.cwd, sessionId: agentOptions?.sessionId, getTranscriptPath: agentOptions?.getTranscriptPath,
  });
}

export function createDefaultHookRegistry(
  onSubagentComplete?: (info: SubagentCompleteInfo) => void,
  surface?: string,
  memoryStore?: MemoryStore,
  getPermissionMode?: () => PermissionMode,
  hookConfig?: LoadedHooksConfig,
  agentOptions?: AgentOptions,
  getCwd?: () => string | undefined,
): DefaultHookRegistryResult {
  const registry = createHookRegistry();
  // Invariant: see module-level comment — hooks run sequentially; order is
  // load-bearing. Do not reorder registrations below without updating that note.
  registerWhatifEpisodeGate(registry);
  registerShadowVerifyNudge(registry);
  // Two-layer placeholder defense (#2125) + unproven-diagnosis gate (#2987).
  registerPlaceholderAndDiagnosisHooks(registry);
  // Ask-question gate: blocks unanswerable questions on headless surfaces.
  registry.register('PreToolUse', createAskQuestionGate());
  registerChildMemoryGuard(registry);
  // Safe-destruct detector (two-tier, ALL surfaces). Pass the session cwd so
  // worktree-scoped BLOCK patterns (git-stash-mutating) fire only inside
  // .afk-worktrees/<slug>/ and leave root-session use unblocked.
  registry.register('PreToolUse', createSafeDestructDetect(agentOptions?.cwd));
  // Release-boundary detector (two-tier, ALL surfaces).
  registry.register('PreToolUse', createReleaseBoundaryDetect());
  // Shadow-git detector: log-only (approve) for --no-verify and identity
  // overrides (issue #3758). Never blocks — shadow window to calibrate FP rate.
  registry.register('PreToolUse', createShadowGitDetect());
  const store = memoryStore ?? new MemoryStore();
  if (getPermissionMode !== undefined) {
    registerPermissionModeGates(registry, getPermissionMode, agentOptions, getCwd);
  }
  const addPreviewDiffRef = registerEditPreviewHook(registry);
  registerPathApprovalAndBashHooks(registry, surface, getCwd, agentOptions);
  registry.register('SessionEnd', createMemorySessionEndHook(store, surface));
  registerSessionEndCleanupHooks(registry);
  // Run receipt: JSON+Markdown summary after trace seal. Best-effort, never
  // injects/blocks; honors AFK_RUN_RECEIPT_DISABLED.
  registry.register('SessionEnd', runReceiptSessionEndHook);
  registerFacetAndOutcomeHooks(registry, agentOptions?.cwd);
  registerSubagentCompleteHook(registry, onSubagentComplete);
  registerEffectLedgerHooks(registry);
  // Inline terminal image rendering (#2143): renders image_generate, image_edit,
  // and browser_screenshot results inline via Kitty / iTerm2 protocol when the
  // terminal supports it. Non-blocking display-only hook; skipped on subagents
  // and non-TTY surfaces. Registered after the ledger so it fires last and never
  // interferes with policy or accounting hooks.
  registry.register('PostToolUse', createInlineImageHook(agentOptions?.cwd));
  registerConfigHooks(registry, hookConfig, agentOptions);
  // Install process-scoped plugin declarations last; built-in and config
  // handlers retain their registration order above.
  installPluginHooks(registry);
  return { registry, memoryStore: store, addPreviewDiffRef };
}

/**
 * Map the loose surface label threaded through {@link createDefaultHookRegistry}
 * to the {@link PathApprovalSurface} discriminator stamped into persisted
 * grants. Unknown labels fall through to `'unknown'`.
 */
function mapSurface(surface: string | undefined): PathApprovalSurface {
  if (surface === 'telegram') return 'telegram';
  if (surface === 'cli' || surface === 'repl') return 'repl';
  if (surface === 'web') return 'web';
  return 'unknown';
}
