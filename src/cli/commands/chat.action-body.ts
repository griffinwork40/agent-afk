/**
 * Action-body implementation for `afk chat`.
 *
 * Extracted from chat.ts to bring `registerChatCommand` under the 200-line
 * function ceiling (#1865).  Exports:
 *   - `ChatActionOptions`   Commander options bag type
 *   - `runChatAction`       Commander .action() handler
 *
 * Named helpers with explicit parameters keep each phase under the 200-line
 * function ceiling while remaining testable in isolation.
 */

import * as path from 'node:path';
import { existsSync } from 'node:fs';
import ora from 'ora';
import { handleCommandError } from '../errors/index.js';
import type { AgentSession } from '../../agent/session.js';
import type { AgentModelInput } from '../../agent/types.js';
import type { PermissionMode } from '../../agent/types/sdk-types.js';
import { wireOneShotChatSession } from './chat.session-wiring.js';
import { unconfiguredSlotError } from '../../agent/session/model-slots.js';
import {
  parseThinking, parseEffort, parseBudget, parseMaxOutputTokens,
  getApiKeyForModel, getModel, getThinking, getEffort, getMaxBudgetUsd,
  getTaskBudget, getMaxOutputTokens, getMaxToolUseIterations,
  resolveBaseSystemPrompt, explicitProviderHints, activateDumpPrompt,
} from '../shared-helpers.js';
import { loadConfig } from '../config.js';
import { applyTheme, resolveTheme, resolveThemeMode } from '../theme.js';
import { assembleSystemPrompt } from '../../agent/routing-directive.js';
import { setupWorktree } from './interactive/worktree.js';
import { resolveResumeTarget, resumeConfigFor } from '../resume-session.js';
import { saveSession } from '../session-store.js';
import { createSessionStats } from '../slash/session-stats.js';
import { runReviewPostPublish, parsePostTargets, type PostTarget } from '../slash/_lib/review-post.js';
import type { Writer } from '../slash/types.js';
import { createStderrWriter } from '../slash/writer.js';
import { runNonInteractiveReconcile } from '../../agent/manifest/startup-reconcile.js';
import { errorMessage, ensureError } from '../../utils/errors.js';
import { closeLazyBrowser } from './chat.browser-teardown.js';
import { createDefaultTraceWriter } from '../../agent/trace/factory.js';
import { receiptPathsFor } from '../../agent/trace/receipt.js';
import { buildChatSession } from './chat.session-setup.js';
import { writeAndDrain } from './chat.stdin-stream.js';
import { connectMcpForChat } from './chat.mcp-setup.js';
import { runStreamJsonPath, renderTextResponse } from './chat.response-output.js';
import type { MemoryStore } from '../../agent/memory/index.js';
import type { StateStore } from '../../agent/state/state-store.js';
import type { WorkspaceStore } from '../../agent/workspace/workspace-store.js';
import type { SubagentManager } from '../../agent/subagent.js';
import type { ComposeExecutor } from '../../agent/tools/compose-executor.js';
import type { McpManager } from '../../agent/mcp/index.js';
import { validateSessionFlags, resolveMessage } from './chat.session-flags.js';

/** Options bag produced by Commander for the `chat` command. */
export interface ChatActionOptions {
  model: AgentModelInput;
  stream: boolean;
  format: string;
  maxTurns: string;
  thinking?: string;
  effort?: string;
  theme?: 'dark' | 'light' | 'umber' | 'auto';
  maxBudgetUsd?: string;
  taskBudget?: string;
  maxOutputTokens?: string;
  provider?: string;
  dumpPrompt?: string | boolean;
  worktree?: string | true;
  worktreeBase?: string;
  mcpConfig?: string;
  resume?: string;
  continue?: boolean;
  sessionId?: string;
  post?: string;
  postPr?: string;
  permissionMode?: PermissionMode;
  dangerouslySkipPermissions?: boolean;
}

// ---------------------------------------------------------------------------
// Phase helpers (explicit parameters — not closures over action-body locals)
// ---------------------------------------------------------------------------

/** Parse --post targets; warn on unknowns. Returns the valid PostTarget list. */
export function resolvePostTargets(post: string | undefined): PostTarget[] {
  if (post === undefined) return [];
  const parsed = parsePostTargets(post);
  for (const unknown of parsed.unknown) {
    process.stderr.write(
      `Warning: unknown --post target ignored: ${unknown} (expected github or telegram)\n`,
    );
  }
  return parsed.targets;
}

/** Parse model-knob options (thinking, effort, budgets, tokens). */
export function resolveModelOptions(options: Pick<ChatActionOptions, 'thinking' | 'effort' | 'maxBudgetUsd' | 'taskBudget' | 'maxOutputTokens'>): {
  thinking: ReturnType<typeof parseThinking>;
  effort: ReturnType<typeof parseEffort>;
  maxBudgetUsd: number | undefined;
  taskBudget: number | undefined;
  maxOutputTokens: number | undefined;
  maxToolUseIterations: number | undefined;
} {
  return {
    thinking: parseThinking(options.thinking) ?? getThinking(),
    effort: parseEffort(options.effort) ?? getEffort(),
    maxBudgetUsd: parseBudget(options.maxBudgetUsd) ?? getMaxBudgetUsd(),
    taskBudget: parseBudget(options.taskBudget) ?? getTaskBudget(),
    maxOutputTokens: parseMaxOutputTokens(options.maxOutputTokens) ?? getMaxOutputTokens(),
    maxToolUseIterations: getMaxToolUseIterations(),
  };
}

/**
 * Resolve resume/session-id config and seed cumulative stats from a stored
 * session.  Returns the resolved resumeConfig and updated stats.
 */
export function resolveResumeConfig(
  options: Pick<ChatActionOptions, 'resume' | 'continue' | 'sessionId' | 'model'>,
  resumeTarget: ReturnType<typeof resolveResumeTarget>,
  stats: ReturnType<typeof createSessionStats>,
): {
  resumeConfig: ReturnType<typeof resumeConfigFor>;
  shouldPersist: boolean;
  persistId: string | undefined;
} {
  let resumeConfig: ReturnType<typeof resumeConfigFor> = {};
  let shouldPersist = false;
  let persistId: string | undefined;

  if (resumeTarget) {
    resumeConfig = resumeConfigFor(resumeTarget);
    shouldPersist = true;
    persistId = resumeTarget.id;
  }

  if (options.sessionId !== undefined) {
    resumeConfig = { sessionId: options.sessionId };
    shouldPersist = true;
    persistId = options.sessionId;
  }

  if (resumeTarget?.stored) {
    stats.totalTurns = resumeTarget.stored.totalTurns;
    stats.totalCostUsd = resumeTarget.stored.totalCostUsd;
    stats.totalTokens = resumeTarget.stored.totalTokens;
    stats.totalDurationMs = resumeTarget.stored.totalDurationMs;
    stats.turns = [...resumeTarget.stored.turns];
    stats.sessionId = resumeTarget.stored.sessionId ?? resumeTarget.resumeId;
    stats.sessionStartTime = resumeTarget.stored.startedAt ?? Date.now();
  }
  if (options.sessionId !== undefined) {
    stats.sessionId = options.sessionId;
  }

  return { resumeConfig, shouldPersist, persistId };
}

/** Build the maybePublish callback used by stream-json and text/json paths. */
export function buildMaybePublish(
  postTargets: PostTarget[],
  postPr: string | undefined,
): (reviewText: string, errored: boolean) => Promise<void> {
  return async (reviewText: string, errored: boolean): Promise<void> => {
    if (postTargets.length === 0 || errored) return;
    const out: Writer = createStderrWriter();
    try {
      await runReviewPostPublish(out, {
        targets: postTargets,
        reviewText,
        prRefFromArgs: postPr ?? null,
      });
    } catch (err) {
      process.stderr.write(`[--post] publish failed: ${errorMessage(err)}\n`);
    }
  };
}

/** Teardown: persist session, close trace, disconnect MCP, close stores/worktree. */
export async function runSessionTeardown(params: {
  shouldPersist: boolean;
  stats: ReturnType<typeof createSessionStats>;
  persistId: string | undefined;
  encounteredError: boolean;
  session: AgentSession | null;
  receiptTracePath: string | undefined;
  mcpManagerRef: McpManager | undefined;
  teardownStores: {
    sharedMemoryStore: MemoryStore;
    sharedStateStore: StateStore;
    workspaceStore: WorkspaceStore | undefined;
  } | undefined;
  worktreeHandle: Awaited<ReturnType<typeof setupWorktree>> | undefined;
}): Promise<void> {
  const { shouldPersist, stats, persistId, encounteredError, session,
          receiptTracePath, mcpManagerRef, teardownStores, worktreeHandle } = params;

  if (shouldPersist && stats.totalTurns > 0 && !encounteredError) {
    try {
      const savedPath = saveSession(stats, persistId, { closeTime: true });
      const savedId = path.basename(savedPath, '.json') || persistId || stats.sessionId || 'unknown';
      process.stderr.write(`Continue with: afk chat <msg> --resume ${savedId}\n`);
    } catch { /* best-effort — don't mask the main error */ }
  }
  if (session) {
    await session.close();
    if (receiptTracePath !== undefined) {
      try {
        const { mdPath } = receiptPathsFor(receiptTracePath);
        if (existsSync(mdPath)) process.stderr.write(`Receipt: ${mdPath}\n`);
      } catch { /* best-effort */ }
    }
  }
  if (mcpManagerRef) await mcpManagerRef.disconnectAll();
  await closeLazyBrowser();
  if (teardownStores) {
    try { teardownStores.sharedMemoryStore?.close(); } catch {}
    try { teardownStores.sharedStateStore?.close(); } catch {}
    try { teardownStores.workspaceStore?.close(); } catch {}
  }
  if (worktreeHandle !== undefined) await worktreeHandle.cleanup();
}

// ---------------------------------------------------------------------------
// Main action handler
// ---------------------------------------------------------------------------

/**
 * Commander `.action()` handler for `afk chat`.
 *
 * Wires the phase helpers above into a single orchestrated flow.  Accepts
 * explicit parameters (no closure over enclosing locals) per repo convention.
 */
export async function runChatAction(
  rawMessage: string | undefined,
  options: ChatActionOptions,
): Promise<void> {
  if (!validateSessionFlags(options)) return;

  const postTargets = resolvePostTargets(options.post);
  const message = await resolveMessage(rawMessage);
  if (message === null) return;

  const spinner = ora('Initializing agent...').start();

  let session: AgentSession | null = null;
  let worktreeHandle: Awaited<ReturnType<typeof setupWorktree>> | undefined;
  let worktreeCwd: string | undefined;
  let shouldPersist = false;
  let persistId: string | undefined;
  let resumeConfig: ReturnType<typeof resumeConfigFor> = {};
  let stats = createSessionStats(options.model);
  let encounteredError = false;
  let receiptTracePath: string | undefined;
  let teardownStores: {
    sharedMemoryStore: MemoryStore;
    sharedStateStore: StateStore;
    workspaceStore: WorkspaceStore | undefined;
  } | undefined;
  let rootManagerRef: SubagentManager | undefined;
  let composeExecutorRef: ComposeExecutor | undefined;
  let mcpManagerRef: McpManager | undefined;

  try {
    if (options.worktree !== undefined) {
      try {
        worktreeHandle = await setupWorktree(
          options.worktree,
          options.worktreeBase !== undefined ? { baseRef: options.worktreeBase } : undefined,
        );
        worktreeCwd = worktreeHandle.path;
        spinner.text = `Worktree ready at ${worktreeHandle.path} (branch: ${worktreeHandle.branch})`;
      } catch (err) {
        spinner.fail('Failed to create worktree');
        handleCommandError(err);
      }
    }

    let modelOpts: ReturnType<typeof resolveModelOptions>;
    try {
      modelOpts = resolveModelOptions(options);
    } catch (err) {
      spinner.fail('Invalid options');
      handleCommandError(err);
    }

    activateDumpPrompt(options.dumpPrompt, options.provider);

    const providerHints = explicitProviderHints(options.provider);
    const apiKey = getApiKeyForModel(getModel(), providerHints);
    const { prompt: basePrompt, source: systemPromptSource, overlay: operatorOverlay } = resolveBaseSystemPrompt();
    const cliConfig = loadConfig();
    applyTheme(resolveTheme(resolveThemeMode(options.theme, cliConfig.theme)));
    const systemPrompt = assembleSystemPrompt(basePrompt, cliConfig.autoRouting?.chat ?? false, 'one-shot');

    const resumeTarget = resolveResumeTarget({ resume: options.resume, continue: options.continue });
    if (options.resume && resumeTarget && !resumeTarget.stored) {
      spinner.fail('Session not found');
      process.stderr.write(
        `Error: session not found: ${JSON.stringify(options.resume)}\n` +
          `Run \`afk i\` then \`/resume\` to list saved sessions.\n`,
      );
      process.exitCode = 1;
      return;
    }

    ({ resumeConfig, shouldPersist, persistId } = resolveResumeConfig(options, resumeTarget, stats));

    const sessionModel = resumeTarget?.stored?.model ?? options.model;
    const unconfiguredModel = unconfiguredSlotError(sessionModel);
    if (unconfiguredModel) throw new Error(unconfiguredModel);
    stats.model = sessionModel;

    const trace = createDefaultTraceWriter();
    receiptTracePath = trace?.tracePath;
    const receiptSessionLabel = trace?.sessionLabel;

    mcpManagerRef = await connectMcpForChat({
      worktreeCwd, mcpConfigOverride: options.mcpConfig, traceWriter: trace?.writer,
    });

    const built = await buildChatSession({
      model: options.model, sessionModel, apiKey, systemPrompt, systemPromptSource,
      basePrompt, operatorOverlay, providerHints, providerRaw: options.provider,
      ...modelOpts!,
      worktreeCwd, traceWriter: trace?.writer, mcpManager: mcpManagerRef, resumeConfig,
      permissionMode: options.permissionMode ?? cliConfig.permissionMode,
      dangerouslySkipPermissions: options.dangerouslySkipPermissions,
      maxTurns: parseInt(options.maxTurns, 10),
      temperature: cliConfig.temperature, baseUrl: cliConfig.baseUrl,
      openaiBaseUrl: cliConfig.openaiBaseUrl,
      autoResumeOnUsageLimit: cliConfig.autoResumeOnUsageLimit,
    });

    session = built.session;
    rootManagerRef = built.rootManager;
    composeExecutorRef = built.composeExecutor;
    teardownStores = {
      sharedMemoryStore: built.sharedMemoryStore,
      sharedStateStore: built.sharedStateStore,
      workspaceStore: built.workspaceStore,
    };

    void runNonInteractiveReconcile(session.sessionId ?? '');
    wireOneShotChatSession(session, [rootManagerRef, composeExecutorRef]);
    spinner.text = 'Sending message...';

    const maybePublish = buildMaybePublish(postTargets, options.postPr);

    if (options.format === 'stream-json') {
      spinner.stop();
      await runStreamJsonPath({ session, message, stats, maybePublish });
      return;
    }

    await renderTextResponse({
      session, message, stats, sessionModel, format: options.format,
      streamFlag: options.stream, receiptSessionLabel, receiptTracePath,
      maybePublish, spinner,
    });

  } catch (error) {
    encounteredError = true;
    if (options.format === 'stream-json') {
      const e = ensureError(error);
      try {
        await writeAndDrain(
          process.stdout,
          JSON.stringify({ type: 'error', error: { message: e.message, name: e.name } }) + '\n',
        );
      } catch { /* best-effort */ }
      process.exitCode = 1;
    }
    spinner.fail('Failed to send message');
    handleCommandError(error);
  } finally {
    await runSessionTeardown({
      shouldPersist, stats, persistId, encounteredError, session,
      receiptTracePath, mcpManagerRef, teardownStores, worktreeHandle,
    });
  }
}
