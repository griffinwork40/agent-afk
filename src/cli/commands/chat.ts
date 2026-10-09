import { Command } from 'commander';
import ora from 'ora';
import { handleCommandError } from '../errors/index.js';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import type { AgentSession } from '../../agent/session.js';
import { wireOneShotChatSession } from './chat.session-wiring.js';
import type { AgentModelInput } from '../../agent/types.js';
import { unconfiguredSlotError } from '../../agent/session/model-slots.js';
import { parseThinking, parseEffort, parseBudget, parseMaxOutputTokens, getApiKeyForModel, getModel, getThinking, getEffort, getMaxBudgetUsd, getTaskBudget, getMaxOutputTokens, getMaxToolUseIterations, resolveBaseSystemPrompt, explicitProviderHints, activateDumpPrompt } from '../shared-helpers.js';
import { loadConfig } from '../config.js';
import { applyTheme, resolveTheme, resolveThemeMode } from '../theme.js';
import { applySharedChatOptions } from './shared-command-options.js';
import { assembleSystemPrompt } from '../../agent/routing-directive.js';
import { setupWorktree } from './interactive/worktree.js';
import { resolveResumeTarget, resumeConfigFor } from '../resume-session.js';
import { saveSession, findSession } from '../session-store.js';
import { createSessionStats } from '../slash/session-stats.js';
import { runReviewPostPublish, parsePostTargets, type PostTarget } from '../slash/_lib/review-post.js';
import type { Writer } from '../slash/types.js';
import { createStderrWriter } from '../slash/writer.js';
import { runNonInteractiveReconcile } from '../../agent/manifest/startup-reconcile.js';
import { errorMessage, ensureError} from '../../utils/errors.js';
import { closeLazyBrowser } from './chat.browser-teardown.js';
import { createDefaultTraceWriter } from '../../agent/trace/factory.js';
import { receiptPathsFor } from '../../agent/trace/receipt.js';
import { buildChatSession } from './chat.session-setup.js';
import { readStdin, writeAndDrain } from './chat.stdin-stream.js';
import { connectMcpForChat } from './chat.mcp-setup.js';
import { runStreamJsonPath, renderTextResponse } from './chat.response-output.js';
import type { MemoryStore } from '../../agent/memory/index.js';
import type { StateStore } from '../../agent/state/state-store.js';
import type { WorkspaceStore } from '../../agent/workspace/workspace-store.js';
import type { SubagentManager } from '../../agent/subagent.js';
import type { ComposeExecutor } from '../../agent/tools/compose-executor.js';
import type { McpManager } from '../../agent/mcp/index.js';


/** Loose UUID format check: 8-4-4-4-12 hex groups separated by dashes. */
function isUuidShaped(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export function registerChatCommand(program: Command): void {
  // Build the command with shared options, then append chat-specific flags.
  // NOTE: --stream is currently inert — use --format stream-json for headless
  // streaming. Reserved for future token-by-token terminal rendering.
  applySharedChatOptions(
    program
      .command('chat')
      .description('Send a message to the agent')
      // Message is optional: omit when piping via stdin (or pass `-` explicitly).
      .argument('[message]', 'Message to send; use `-` or omit to read from stdin'),
    { maxTurnsDefault: '10' },
  )
    .option('-s, --stream', '[no-op] reserved; use --format stream-json for headless streaming', false)
    .option('-f, --format <format>', 'Output format (text|json|stream-json)', 'text')
    .option('--max-budget-usd <usd>', 'Hard session cost ceiling in USD. Env: AFK_MAX_BUDGET_USD')
    .option('--task-budget <tokens>', 'Soft per-task token budget. Env: AFK_TASK_BUDGET')
    .option('--session-id <uuid>', 'Assign a specific UUID to this session (creates new; errors if already exists)')
    .option('--post <targets>', 'Headless publish of the final assistant message: github, telegram, or github,telegram')
    .option('--post-pr <ref>', 'PR number, URL, or branch for --post github (defaults to the current-branch PR)')
    .action(async (rawMessage: string | undefined, options: {
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
      dangerouslySkipPermissions?: boolean;
    }) => {
      // -----------------------------------------------------------------------
      // Mutual-exclusion checks for session flags (before spinner so errors
      // are clean and not nested under a spinner fail line).
      // -----------------------------------------------------------------------
      if (options.resume && options.continue) {
        process.stderr.write('Error: --resume and --continue are mutually exclusive\n');
        process.exitCode = 1;
        return;
      }
      if (options.sessionId !== undefined && (options.resume || options.continue)) {
        process.stderr.write('Error: --session-id is mutually exclusive with --resume and --continue\n');
        process.exitCode = 1;
        return;
      }
      if (options.sessionId !== undefined && !isUuidShaped(options.sessionId)) {
        process.stderr.write(`Error: --session-id must be a UUID (got: ${options.sessionId})\n`);
        process.exitCode = 1;
        return;
      }
      if (options.sessionId !== undefined) {
        const existing = findSession(options.sessionId);
        if (existing !== undefined) {
          process.stderr.write(`Error: session already exists: ${options.sessionId} — use --resume to continue it\n`);
          process.exitCode = 1;
          return;
        }
      }

      // Parse --post targets up front so an unknown target warns before any
      // agent/network work.
      const postTargets: PostTarget[] = [];
      if (options.post !== undefined) {
        const parsedPost = parsePostTargets(options.post);
        postTargets.push(...parsedPost.targets);
        for (const unknownTarget of parsedPost.unknown) {
          process.stderr.write(
            `Warning: unknown --post target ignored: ${unknownTarget} (expected github or telegram)\n`,
          );
        }
      }

      // Resolve message: positional arg, `-` (stdin), or piped stdin.
      let message: string;
      const stdinIsPipe = !process.stdin.isTTY;
      if (rawMessage === '-') {
        if (!stdinIsPipe) {
          process.stderr.write('Error: no stdin available — pass a message or pipe one in\n');
          process.exitCode = 1;
          return;
        }
        message = await readStdin();
      } else if (rawMessage === undefined && stdinIsPipe) {
        message = await readStdin();
      } else if (rawMessage !== undefined) {
        message = rawMessage;
      } else {
        process.stderr.write('Error: missing message — pass a message argument or pipe via stdin\n');
        process.exitCode = 1;
        return;
      }

      if (message.trim() === '') {
        process.stderr.write('Error: message is empty — stdin contained only whitespace\n');
        process.exitCode = 1;
        return;
      }

      const spinner = ora('Initializing agent...').start();

      let session: AgentSession | null = null;
      let worktreeHandle: Awaited<ReturnType<typeof setupWorktree>> | undefined;
      let worktreeCwd: string | undefined;
      let shouldPersist = false;
      let persistId: string | undefined;
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
        // Optional worktree isolation.
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

        let thinking;
        let effort;
        let maxBudgetUsd: number | undefined;
        let taskBudget: number | undefined;
        let maxOutputTokens: number | undefined;
        let maxToolUseIterations: number | undefined;
        try {
          thinking = parseThinking(options.thinking) ?? getThinking();
          effort = parseEffort(options.effort) ?? getEffort();
          maxBudgetUsd = parseBudget(options.maxBudgetUsd) ?? getMaxBudgetUsd();
          taskBudget = parseBudget(options.taskBudget) ?? getTaskBudget();
          maxOutputTokens = parseMaxOutputTokens(options.maxOutputTokens) ?? getMaxOutputTokens();
          maxToolUseIterations = getMaxToolUseIterations();
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
        const autoRouting = cliConfig.autoRouting?.chat ?? false;
        const systemPrompt = assembleSystemPrompt(basePrompt, autoRouting, 'one-shot');

        // Resume / session-id resolution.
        let resumeConfig: ReturnType<typeof resumeConfigFor> = {};
        const resumeTarget = resolveResumeTarget({
          resume: options.resume,
          continue: options.continue,
        });

        if (options.resume && resumeTarget && !resumeTarget.stored) {
          spinner.fail('Session not found');
          process.stderr.write(
            `Error: session not found: ${JSON.stringify(options.resume)}\n` +
              `Run \`afk i\` then \`/resume\` to list saved sessions.\n`,
          );
          process.exitCode = 1;
          return;
        }

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

        const sessionModel = resumeTarget?.stored?.model ?? options.model;
        const unconfiguredModel = unconfiguredSlotError(sessionModel);
        if (unconfiguredModel) throw new Error(unconfiguredModel);

        stats.model = sessionModel;
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

        // Witness layer: open the trace BEFORE executors so SkillExecutor
        // and grandchild sessions inherit it.
        const trace = createDefaultTraceWriter();
        receiptTracePath = trace?.tracePath;
        const receiptSessionLabel = trace?.sessionLabel;

        mcpManagerRef = await connectMcpForChat({
          worktreeCwd,
          mcpConfigOverride: options.mcpConfig,
          traceWriter: trace?.writer,
        });

        const built = await buildChatSession({
          model: options.model,
          sessionModel,
          apiKey,
          systemPrompt,
          systemPromptSource,
          basePrompt, operatorOverlay,
          providerHints,
          providerRaw: options.provider,
          thinking,
          effort,
          maxBudgetUsd,
          taskBudget,
          maxOutputTokens,
          maxToolUseIterations,
          worktreeCwd,
          traceWriter: trace?.writer,
          mcpManager: mcpManagerRef,
          resumeConfig,
          permissionMode: cliConfig.permissionMode,
          dangerouslySkipPermissions: options.dangerouslySkipPermissions,
          maxTurns: parseInt(options.maxTurns, 10),
          temperature: cliConfig.temperature,
          baseUrl: cliConfig.baseUrl,
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

        runNonInteractiveReconcile(session.sessionId ?? '');
        wireOneShotChatSession(session, [rootManagerRef, composeExecutorRef]);

        spinner.text = 'Sending message...';

        const maybePublish = async (reviewText: string, errored: boolean): Promise<void> => {
          if (postTargets.length === 0 || errored) return;
          const out: Writer = createStderrWriter();
          try {
            await runReviewPostPublish(out, {
              targets: postTargets,
              reviewText,
              prRefFromArgs: options.postPr ?? null,
            });
          } catch (err) {
            process.stderr.write(`[--post] publish failed: ${errorMessage(err)}\n`);
          }
        };

        if (options.format === 'stream-json') {
          spinner.stop();
          await runStreamJsonPath({ session, message, stats, maybePublish });
          return;
        }

        // text / json paths
        await renderTextResponse({
          session,
          message,
          stats,
          sessionModel,
          format: options.format,
          streamFlag: options.stream,
          receiptSessionLabel,
          receiptTracePath,
          maybePublish,
          spinner,
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
          } catch { /* best-effort — stdout may already be broken */ }
          process.exitCode = 1;
        }
        spinner.fail('Failed to send message');
        handleCommandError(error);
      } finally {
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
              if (existsSync(mdPath)) {
                process.stderr.write(`Receipt: ${mdPath}\n`);
              }
            } catch { /* best-effort — never mask the run's real outcome */ }
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
    });
}
