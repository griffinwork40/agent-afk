import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { handleCommandError } from '../errors/index.js';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { AgentSession } from '../../agent/session.js';
import { createDefaultHookRegistry } from '../../agent/default-hook-registry.js';
import { loadHooksConfig } from '../../agent/hooks/config-loader.js';
import { MemoryStore, injectHotMemory } from '../../agent/memory/index.js';
import { injectCompanionPrimer } from '../../agent/companion/index.js';
import type { AgentModelInput, ThinkingConfig, EffortLevel } from '../../agent/types.js';
import { unconfiguredSlotError } from '../../agent/session/model-slots.js';
import { formatDuration, formatCost, formatTokens } from '../format-utils.js';
import { parseThinking, parseEffort, parseBudget, parseMaxOutputTokens, parseProvider, getApiKey, getApiKeyForModel, getModel, getThinking, getEffort, getMaxBudgetUsd, getTaskBudget, getMaxOutputTokens, getDefaultSubagentModel, resolveBaseSystemPrompt } from '../shared-helpers.js';
import { loadConfig } from '../config.js';
import { assembleSystemPrompt } from '../../agent/routing-directive.js';
import { renderMarkdownToTerminal } from '../formatter.js';
import { formatSubagentCompletion } from './interactive/progress-banner.js';
import { SubagentManager } from '../../agent/subagent.js';
import { SubagentExecutor } from '../../agent/tools/subagent-executor.js';
import { SkillExecutor } from '../../agent/tools/skill-executor.js';
import { ComposeExecutor } from '../../agent/tools/compose-executor.js';
import { createChildProviderFactory, createChildSkillExecutorFactory } from '../../agent/tools/nesting.js';
import { AnthropicDirectProvider } from '../../agent/providers/anthropic-direct/index.js';
import { BUILTIN_TOOL_NAMES } from '../../agent/tools/schemas.js';
import { MEMORY_TOOL_NAMES } from '../../agent/memory/index.js';
import { AWARENESS_TOOL_NAMES } from '../../agent/awareness/index.js';
import { createDefaultTraceWriter } from '../../agent/trace/factory.js';
import { receiptPathsFor } from '../../agent/trace/receipt.js';
import { setupWorktree } from './interactive/worktree.js';
import { resolveResumeTarget, resumeConfigFor } from '../resume-session.js';
import { saveSession, findSession } from '../session-store.js';
import { createSessionStats, recordTurn } from '../slash/session-stats.js';
import { runReviewPostPublish, parsePostTargets, type PostTarget } from '../slash/_lib/review-post.js';
import type { Writer } from '../slash/types.js';

/** Loose UUID format check: 8-4-4-4-12 hex groups separated by dashes. */
function isUuidShaped(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * Read all of stdin until EOF and return the result trimmed of trailing
 * newlines. Resolves immediately when `process.stdin` has already ended.
 */
const STDIN_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    // Invariant: if stdin already reached EOF before this call, `once('end')`
    // will never re-fire and `resume()` is a no-op. Resolve synchronously with
    // an empty payload rather than hanging the caller forever.
    if (process.stdin.readableEnded) {
      resolve('');
      return;
    }
    // Capture the handler so end/error paths can remove it. Without the
    // removeListener calls, repeated readStdin invocations leak listeners on
    // the shared process.stdin object and trigger MaxListenersExceededWarning.
    const onData = (chunk: Buffer): void => {
      totalBytes += chunk.length;
      if (totalBytes > STDIN_MAX_BYTES) {
        process.stdin.destroy(new Error(`stdin exceeds ${STDIN_MAX_BYTES}-byte limit`));
        return;
      }
      chunks.push(chunk);
    };
    process.stdin.on('data', onData);
    process.stdin.once('end', () => {
      process.stdin.removeListener('data', onData);
      resolve(Buffer.concat(chunks).toString('utf-8').replace(/\n+$/, ''));
    });
    process.stdin.once('error', (err) => {
      process.stdin.removeListener('data', onData);
      reject(err);
    });
    // Resume the stream in case it is paused (common in tests).
    process.stdin.resume();
  });
}

/** Writes `chunk` to `stream`, honouring backpressure: if `write()` returns
 *  false (buffer full) the returned Promise resolves only after the `drain`
 *  event fires, pausing the caller until the consumer catches up. */
function writeAndDrain(stream: NodeJS.WritableStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Invariant: settle exclusively via the write callback when `ok === true`.
    // Resolving synchronously after stream.write() races the callback — when
    // an EPIPE/stream-destroyed error fires on the callback, the Promise is
    // already settled and `reject(err)` becomes a silent no-op, masking
    // truncated NDJSON output with exit code 0.
    const ok = stream.write(chunk, (err) => {
      if (err) reject(err);
      else if (ok) resolve();
    });
    if (!ok) {
      // Backpressure path: pair drain + error listeners so a stream error
      // before drain doesn't orphan the drain listener on process.stdout —
      // orphans accumulate, eventually triggering MaxListenersExceededWarning
      // and a process crash when an unhandled `error` event fires.
      const onDrain = (): void => {
        stream.removeListener('error', onError);
        resolve();
      };
      const onError = (err: Error): void => {
        stream.removeListener('drain', onDrain);
        reject(err);
      };
      stream.once('drain', onDrain);
      stream.once('error', onError);
    }
  });
}

export function registerChatCommand(program: Command): void {
  program
    .command('chat')
    .description('Send a message to the agent')
    // Message is optional: omit when piping via stdin (or pass `-` explicitly).
    .argument('[message]', 'Message to send; use `-` or omit to read from stdin')
    .option(
      '-m, --model <model>',
      'Model to use. Short aliases: opus|opus_1m|sonnet|sonnet_1m|haiku. ' +
        'Any other value (e.g. `auto` for cursor-api-proxy, or a full `claude-*` ID) passes through to the SDK/proxy untouched.',
      getModel(),
    )
    // NOTE: this flag is currently inert — use `--format stream-json` for a
    // streaming output path. `--stream` is reserved for future token-by-token
    // terminal rendering; do not rely on it for structured output.
    .option('-s, --stream', '[no-op] reserved; use --format stream-json for headless streaming', false)
    .option('-f, --format <format>', 'Output format (text|json|stream-json)', 'text')
    .option('--max-turns <number>', 'Maximum conversation turns', '10')
    .option('--thinking <mode>', "Thinking mode: 'adaptive' | 'disabled' | 'enabled:<N>'", 'enabled:max')
    .option('--effort <level>', "Effort level: low|medium|high|xhigh|max")
    .option('--max-budget-usd <usd>', 'Hard session cost ceiling in USD. Env: AFK_MAX_BUDGET_USD')
    .option('--task-budget <tokens>', 'Soft per-task token budget. Env: AFK_TASK_BUDGET')
    .option('--max-output-tokens <n|max>', "Per-response output cap ('max' = model ceiling). Env: AFK_MAX_OUTPUT_TOKENS")
    .option('--provider <name>', "Provider to use: anthropic|anthropic-direct|openai|openai-compatible. Default: auto-selected by model")
    .option('--dump-prompt [path]', 'Dump resolved SDK prompt+options+provenance to file (default: ~/.afk/logs/prompt-dump-<ISO>.json) or "stderr"')
    .option(
      '-w, --worktree [branch]',
      'Create a git worktree for an isolated one-shot. Optional value sets the branch name; otherwise auto-named. On clean exit (no uncommitted changes) the worktree and branch are auto-removed; on dirty exit the worktree is preserved. Mirrors `afk interactive -w`.',
    )
    .option(
      '--worktree-base <ref>',
      'Base git ref for the worktree created by --worktree. Default: the remote\'s default branch (origin/main), fetched fresh. Pass HEAD to base on your local checkout instead. Also: AFK_WORKTREE_BASE.',
    )
    .option('--resume <id>', 'Resume a persisted session by id')
    .option('--continue', 'Continue the most recent persisted session in cwd')
    .option('--session-id <uuid>', 'Assign a specific UUID to this session (creates new; errors if already exists)')
    .option('--post <targets>', 'Headless publish of the final assistant message: github, telegram, or github,telegram')
    .option('--post-pr <ref>', 'PR number, URL, or branch for --post github (defaults to the current-branch PR)')
    .option('--dangerously-skip-permissions', 'Force bypass mode (already the default for new installs): skip path-approval prompts; read/write ANY path with no confirmation (permissionMode=bypassPermissions). Disable persistently with `afk config set permissionMode default`. Does not affect ask_question.')
    .action(async (rawMessage: string | undefined, options: {
      model: AgentModelInput;
      stream: boolean;
      format: string;
      maxTurns: string;
      thinking?: string;
      effort?: string;
      maxBudgetUsd?: string;
      taskBudget?: string;
      maxOutputTokens?: string;
      provider?: string;
      dumpPrompt?: string | boolean;
      worktree?: string | true;
      worktreeBase?: string;
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

      // -----------------------------------------------------------------------
      // Parse --post targets up front so an unknown target warns before any
      // agent/network work. parsePostTargets classifies the bare Commander value
      // directly — no synthetic "--post …" flag string to reconstruct and re-parse;
      // the actual publish runs after the turn completes (see maybePublish below). An
      // all-unknown value yields zero targets → a no-op, not a hard error.
      // -----------------------------------------------------------------------
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

      // -----------------------------------------------------------------------
      // Resolve message: positional arg, `-` (stdin), or piped stdin.
      // -----------------------------------------------------------------------
      let message: string;
      const stdinIsPipe = !process.stdin.isTTY;
      if (rawMessage === '-') {
        // Explicit stdin sentinel.
        if (!stdinIsPipe) {
          process.stderr.write('Error: no stdin available — pass a message or pipe one in\n');
          process.exitCode = 1;
          return;
        }
        message = await readStdin();
      } else if (rawMessage === undefined && stdinIsPipe) {
        // Omitted arg + piped stdin → read from pipe.
        message = await readStdin();
      } else if (rawMessage !== undefined) {
        message = rawMessage;
      } else {
        // No arg, no pipe — show usage hint.
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
      let sharedMemoryStore: MemoryStore | undefined;
      let worktreeHandle: Awaited<ReturnType<typeof setupWorktree>> | undefined;
      let worktreeCwd: string | undefined;
      // Whether this run should persist a session sidecar on exit.
      // True only when a session flag (--resume / --continue / --session-id) is set.
      let shouldPersist = false;
      // The file-system id used as the sidecar filename (basename without .json).
      let persistId: string | undefined;
      // Declared here (outside try) so catch/finally can access it for persistence.
      let stats = createSessionStats(options.model);
      // Set true on any error path. Guards the finally-block saveSession call
      // so a failed turn on a resumed session does not overwrite the sidecar
      // with a misleading resume hint (stats.totalTurns is pre-seeded from the
      // prior session and would otherwise trip the > 0 persistence check).
      let encounteredError = false;
      // Hoisted out of the try so the finally block can surface the run-receipt
      // path after session.close() (the trace const is block-scoped to try).
      let receiptTracePath: string | undefined;

      try {
        // Optional worktree isolation. Mirrors `afk interactive -w`: the
        // path becomes the session's `config.cwd`, so bash/grep tool calls
        // and forked subagents all operate in the isolated working tree
        // rather than the Node host's process.cwd(). Without this, two
        // concurrent `afk chat -w` invocations would share a single git
        // working tree and stash/checkout each other's state.
        if (options.worktree !== undefined) {
          try {
            // `--worktree-base` (or AFK_WORKTREE_BASE, resolved downstream)
            // bases the worktree on a ref like origin/main instead of HEAD.
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
        // Parse thinking, effort, budget — shared-helpers.parseBudget throws
        // on malformed input so the user sees a friendly error instead of a
        // silent no-op.
        let thinking: ThinkingConfig | undefined;
        let effort: EffortLevel | undefined;
        let maxBudgetUsd: number | undefined;
        let taskBudget: number | undefined;
        let maxOutputTokens: number | undefined;
        let provider;
        try {
          thinking = parseThinking(options.thinking) ?? getThinking();
          effort = parseEffort(options.effort) ?? getEffort();
          maxBudgetUsd = parseBudget(options.maxBudgetUsd) ?? getMaxBudgetUsd();
          taskBudget = parseBudget(options.taskBudget) ?? getTaskBudget();
          maxOutputTokens = parseMaxOutputTokens(options.maxOutputTokens) ?? getMaxOutputTokens();
          // Will be wired with subagentExecutor below if anthropic-direct
          provider = undefined;
        } catch (err) {
          spinner.fail('Invalid options');
          handleCommandError(err);
        }

        // --- prompt-dump activation ---
        if (options.dumpPrompt !== undefined) {
          const val: string = options.dumpPrompt === true
            ? path.join(os.homedir(), '.afk', 'logs', `prompt-dump-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
            : String(options.dumpPrompt);
          process.env['AFK_DUMP_PROMPT'] = val;
          // Provider coverage warning: dumpIfEnabled is only wired into AnthropicDirectProvider.
          // openai-compatible and other non-Anthropic providers will not produce a dump file.
          if (options.provider !== undefined && options.provider !== 'anthropic' && options.provider !== 'anthropic-direct') {
            console.error(`[--dump-prompt] WARNING: active provider (${options.provider}) does not support prompt dumping. No file will be written.`);
          }
        }

        const apiKey = getApiKey();
        // System-prompt layering: the framework base (`prompts/system-prompt.md`)
        // is unconditional; the operator overlay (env → afk.config.json → AFK.md)
        // is appended on top via resolveBaseSystemPrompt(), never substituted for
        // the base. `source` is the layered provenance string surfaced by
        // --dump-prompt (`framework`, `framework+afk-md:/path`, …).
        const { prompt: basePrompt, source: systemPromptSource } = resolveBaseSystemPrompt();
        const cliConfig = loadConfig();
        const autoRouting = cliConfig.autoRouting?.chat ?? false;
        const systemPrompt = assembleSystemPrompt(basePrompt, autoRouting, 'one-shot');

        // -----------------------------------------------------------------------
        // Resume / session-id resolution.
        // resolveResumeTarget handles --resume + --continue logic; it throws on
        // not-found when --resume is used and the id doesn't resolve.
        // -----------------------------------------------------------------------
        let resumeConfig: ReturnType<typeof resumeConfigFor> = {};
        const resumeTarget = resolveResumeTarget({
          resume: options.resume,
          continue: options.continue,
        });

        // Validate --resume not-found. resolveResumeTarget returns a shell
        // { id, resumeId } without `stored` when the id wasn't found on disk.
        // The bad id is run through JSON.stringify so control bytes in the
        // user-supplied value surface as visible `\u001b` escapes rather
        // than replaying live into the terminal. Hint points at the
        // interactive surface where `/resume` lists saved sessions —
        // there is no top-level `afk sessions` command.
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

        // --session-id: create a new session with the user-supplied UUID.
        if (options.sessionId !== undefined) {
          resumeConfig = { sessionId: options.sessionId };
          shouldPersist = true;
          persistId = options.sessionId;
        }

        // Resolve effective model (resume may carry a different model).
        const sessionModel = resumeTarget?.stored?.model ?? options.model;
        // Fail fast on an unconfigured capability tier (e.g. `afk -m local` with
        // no AFK_MODEL_LOCAL) before constructing the session — an empty id would
        // otherwise reach the provider as an opaque error or a silent cloud call.
        const unconfiguredModel = unconfiguredSlotError(sessionModel);
        if (unconfiguredModel) {
          throw new Error(unconfiguredModel);
        }
        // Re-seed stats with the correct model and any stored history.
        // `stats` was pre-declared outside the try block to be accessible in
        // catch/finally; update it in place rather than re-assigning.
        stats.model = sessionModel;
        if (resumeTarget?.stored) {
          // Hydrate prior totals so the persisted sidecar carries cumulative
          // stats, not just the new turn.
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

        let boundSession: AgentSession | undefined;

        // Witness layer: open the trace BEFORE executors are constructed so
        // SkillExecutor (and grandchild skill executors via the factory) can
        // be wired with traceWriter. Without this, skill-forked subagents
        // emit zero trace events and become undebuggable from disk. The
        // factory returns null under AFK_TRACE_DISABLED=1.
        //
        // The trace path is intentionally not logged for the one-shot path
        // to keep stdout clean for piping; operators inspect the file under
        // ~/.afk/state/witness/ after the run.
        const trace = createDefaultTraceWriter();
        receiptTracePath = trace?.tracePath;

        const rootManager = new SubagentManager({
          apiKey,
          ...(cliConfig.baseUrl !== undefined ? { baseUrl: cliConfig.baseUrl } : {}),
          // Propagate the worktree cwd into every forked subagent so their
          // bash/grep run in the isolated tree, not the Node host's
          // process.cwd().
          ...(worktreeCwd !== undefined ? { cwd: worktreeCwd } : {}),
        });

        // Pass openaiBaseUrl so OpenAI-routed children point at the
        // configured local shim (mlx_lm.server, Ollama, vLLM, llama.cpp,
        // LM Studio) instead of the default api.openai.com. The factory
        // routes per-call between AnthropicDirect / OpenAICompatible by
        // `providerForModel(model)`.
        const childProviderFactory = createChildProviderFactory(
          cliConfig.openaiBaseUrl !== undefined
            ? { openaiBaseUrl: cliConfig.openaiBaseUrl }
            : {},
        );

        const deferredParent = {
          get sessionId() { return boundSession?.sessionId; },
          getInputStreamRef() { return boundSession?.getInputStreamRef?.() ?? { pushUserMessage: () => {} }; },
          get abortSignal() {
            return boundSession?.abortSignal ?? new AbortController().signal;
          },
          // Live registry so forked subagents resolve it via forkSubagent's
          // parent fallback (SubagentStart/Stop + shadow-verify nudge).
          get hookRegistry() { return boundSession?.hookRegistry; },
        };

        // Share a single childSkillExecutorFactory between SubagentExecutor
        // and SkillExecutor so both code paths use the same depth-aware
        // nesting wiring. Wiring SkillExecutor with these factories is
        // load-bearing: without them, plugin skill children fork with the
        // bare AnthropicDirectProvider singleton (which omits the `agent`
        // and `skill` tools, see anthropic-direct/index.ts:108–110) and
        // any SKILL.md instruction to "dispatch sub-agents via the Agent
        // tool" becomes unimplementable.
        const childSkillExecutorFactory = createChildSkillExecutorFactory(
          options.model,
          apiKey,
          childProviderFactory,
          cliConfig.baseUrl,
          trace?.writer,
          // No backgroundRegistry on the one-shot chat path — background
          // dispatch is interactive-only by contract.
          undefined,
          // Worktree cwd propagates into every depth of the skill-executor
          // chain. See bootstrap.ts for the same wiring.
          worktreeCwd,
          // Per-model credential resolver — see bootstrap.ts for rationale.
          getApiKeyForModel,
        );

        // Pass `options.model` so `getDefaultSubagentModel` can fall back
        // to the parent model when AFK_DEFAULT_SUBAGENT_MODEL is unset
        // AND the parent routes to openai-compatible — preventing the
        // legacy `'sonnet'` literal from silently dispatching OpenAI-parent
        // subagents to api.anthropic.com. Claude parents still default to
        // 'sonnet' (preserves the historical cost-management intent).
        const subagentExecutor = new SubagentExecutor({
          subagentManager: rootManager,
          parentSession: deferredParent,
          // Session origin for routing-decision telemetry (afk chat → cli).
          surface: 'cli',
          defaultConfig: {
            apiKey,
            systemPrompt: basePrompt,
            ...(cliConfig.baseUrl !== undefined ? { baseUrl: cliConfig.baseUrl } : {}),
          },
          defaultSubagentModel: getDefaultSubagentModel(options.model),
          childProviderFactory,
          childSkillExecutorFactory,
          // Per-model credential resolver — see bootstrap.ts for rationale.
          resolveApiKeyForModel: getApiKeyForModel,
          // Top-level CLI wiring → explicit depth 0. See SubagentExecutorContext.depth
          // jsdoc for why this is required rather than defaulted.
          depth: 0,
          // Worktree isolation for depth ≥ 2 `agent` dispatch. See
          // bootstrap.ts for the same wiring.
          ...(worktreeCwd !== undefined ? { cwd: worktreeCwd } : {}),
        });

        const skillExecutor = new SkillExecutor({
          parentSession: deferredParent,
          // Session origin for skill-invocation + routing telemetry (afk chat → cli).
          surface: 'cli',
          defaultModel: options.model,
          defaultSubagentModel: getDefaultSubagentModel(options.model),
          apiKey,
          childProviderFactory,
          childSkillExecutorFactory,
          ...(cliConfig.baseUrl !== undefined ? { baseUrl: cliConfig.baseUrl } : {}),
          // Per-model credential resolver — mirrors bootstrap.ts wiring.
          resolveApiKeyForModel: getApiKeyForModel,
          // See bootstrap.ts SkillExecutor wiring for rationale: without
          // this, every skill-forked subagent is invisible in the witness
          // trace.
          ...(trace?.writer !== undefined ? { traceWriter: trace.writer } : {}),
          // Worktree isolation for skill-dispatched subagents. See
          // bootstrap.ts for the same wiring.
          ...(worktreeCwd !== undefined ? { cwd: worktreeCwd } : {}),
        });

        // Pass the raw base prompt (pre-assembly) so compose subagents do not
        // inherit ROUTING_DIRECTIVE or TOOL_SYSTEM_PROMPT — keeping them as
        // task workers that cannot spawn nested DAGs or recurse into skills.
        // Mirrors the SubagentExecutor defaultConfig.systemPrompt convention.
        const composeExecutor = new ComposeExecutor({
          parentSession: deferredParent,
          defaultModel: options.model,
          defaultSubagentModel: getDefaultSubagentModel(options.model),
          apiKey,
          // Per-model credential resolver — mirrors #640 for the compose fork-path.
          resolveApiKeyForModel: getApiKeyForModel,
          ...(cliConfig.baseUrl !== undefined ? { baseUrl: cliConfig.baseUrl } : {}),
          // Anchor DAG nodes to the worktree (re-anchored via composeExecutor.setCwd).
          ...(worktreeCwd !== undefined ? { cwd: worktreeCwd } : {}),
          systemPrompt: basePrompt ?? '',
        });

        sharedMemoryStore = new MemoryStore();

        // Pass sharedMemoryStore into parseProvider so that when --provider
        // anthropic-direct is explicit, both paths share the same SQLite DB
        // (C7 fix: avoid dual MemoryStore instances on the same file).
        provider = parseProvider(options.provider, { subagentExecutor, skillExecutor, composeExecutor, memoryStore: sharedMemoryStore, model: String(options.model), ...(cliConfig.openaiBaseUrl !== undefined ? { openaiBaseUrl: cliConfig.openaiBaseUrl } : {}) })
          ?? new AnthropicDirectProvider({
            permissions: { allowedTools: [...BUILTIN_TOOL_NAMES, ...MEMORY_TOOL_NAMES, ...AWARENESS_TOOL_NAMES, 'agent', 'skill', 'compose'] },
            subagentExecutor,
            skillExecutor,
            composeExecutor,
            memoryStore: sharedMemoryStore,
            surface: 'cli',
          });


        // Witness layer: `trace` was opened above (before executors) so
        // SkillExecutor could be wired with traceWriter; reuse it here for
        // the AgentSession.
        session = new AgentSession(injectCompanionPrimer(injectHotMemory({
          model: sessionModel,
          // User-facing surface for trace `origin` attribution. One-shot
          // `afk chat` is a CLI entrypoint → 'cli'.
          surface: 'cli',
          // Resolve the credential for the ACTUAL session model, not the
          // env-derived default (`getApiKey()` keys off AFK_MODEL/CLAUDE_MODEL).
          // Without this, `--model gpt-5.5` while CLAUDE_MODEL is a Claude id
          // injects the Anthropic OAuth token into the OpenAI provider, which
          // (a) leaks sk-ant-… to api.openai.com and (b) shadows Codex ChatGPT
          // OAuth (resolveOpenAIAuth treats a non-empty config key as Tier 1).
          // getApiKeyForModel routes via providerForModel → correct family
          // (anti-leak invariant, credential-resolver.ts).
          apiKey: getApiKeyForModel(sessionModel),
          maxTurns: parseInt(options.maxTurns, 10),
          // One-shot `afk chat` is headless: no REPL/Telegram elicitation
          // handler is installed, so ask_question can only auto-decline. Strip
          // it so the model proceeds on an assumption instead of wasting a turn.
          isNonInteractive: true,
          // Permission mode: --dangerously-skip-permissions forces bypass; else
          // the resolved afk.config.json `permissionMode` (loadConfig now always
          // returns one — DEFAULT_CLI_PERMISSION_MODE = bypass for new installs,
          // overridable by the config key). Always defined, so chat never falls
          // through to the session-layer 'default'.
          ...(options.dangerouslySkipPermissions
            ? { permissionMode: 'bypassPermissions' as const }
            : cliConfig.permissionMode !== undefined
              ? { permissionMode: cliConfig.permissionMode }
              : {}),
          hookRegistry: createDefaultHookRegistry((info) => {
            console.log(formatSubagentCompletion(info));
          }, 'cli', sharedMemoryStore, undefined, loadHooksConfig({ cwd: worktreeCwd }), { cwd: worktreeCwd }).registry,
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
          ...(systemPromptSource !== undefined ? { systemPromptSource } : {}),
          ...(thinking !== undefined ? { thinking } : {}),
          ...(effort !== undefined ? { effort } : {}),
          ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
          ...(taskBudget !== undefined ? { taskBudget } : {}),
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          ...(cliConfig.baseUrl !== undefined ? { baseUrl: cliConfig.baseUrl } : {}),
          ...(trace ? { traceWriter: trace.writer } : {}),
          ...(cliConfig.autoResumeOnUsageLimit !== undefined
            ? { autoResumeOnUsageLimit: cliConfig.autoResumeOnUsageLimit }
            : {}),
          // Pipes worktree cwd to tool handlers (bash, glob, grep) so the
          // shell commands the model spawns honor the isolated worktree.
          ...(worktreeCwd !== undefined ? { cwd: worktreeCwd } : {}),
          // Wire resume/session-id config when a session flag is set.
          ...resumeConfig,
          provider,
        })));

        boundSession = session;

        spinner.text = 'Sending message...';

        // ---------------------------------------------------------------------------
        // Optional --post publish. Reuses the REPL's runReviewPostPublish so the
        // GitHub/Telegram posting logic (markers, chunking, gh/Telegram auth) is
        // never duplicated. Fail-soft by contract AND by an extra inner try/catch:
        // a publish failure writes to stderr and is swallowed so it can never flip
        // the command's exit code or corrupt stdout (NDJSON stays clean — the
        // Writer is stderr-backed). No-op when no targets were requested.
        // ---------------------------------------------------------------------------
        const maybePublish = async (reviewText: string, errored: boolean): Promise<void> => {
          if (postTargets.length === 0 || errored) return;
          const out: Writer = {
            line: (t?: string) => { process.stderr.write(`${t ?? ''}\n`); },
            raw: (t: string) => { process.stderr.write(t); },
            success: (t: string) => { process.stderr.write(`✔ ${t}\n`); },
            info: (t: string) => { process.stderr.write(`ℹ ${t}\n`); },
            warn: (t: string) => { process.stderr.write(`⚠ ${t}\n`); },
            error: (t: string) => { process.stderr.write(`✖ ${t}\n`); },
          };
          try {
            await runReviewPostPublish(out, {
              targets: postTargets,
              reviewText,
              prRefFromArgs: options.postPr ?? null,
            });
          } catch (err) {
            process.stderr.write(
              `[--post] publish failed: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        };

        // ---------------------------------------------------------------------------
        // stream-json path — emits raw OutputEvent NDJSON on stdout for headless
        // consumers. The spinner is stopped before entering the loop so its escape
        // sequences do not corrupt the NDJSON stream on stdout.
        // ---------------------------------------------------------------------------
        if (options.format === 'stream-json') {
          // Replacer: Date instances (e.g. paused.resetsAt) would serialize as {}
          // without this; convert them to ISO-8601 strings instead.
          const dateReplacer = (_k: string, v: unknown): unknown => {
            if (v instanceof Date) return v.toISOString();
            // Drop stack — V8 stack traces embed absolute filesystem paths and would
            // leak host-machine layout to headless NDJSON consumers.
            if (v instanceof Error) return { message: v.message, name: v.name };
            return v;
          };

          spinner.stop();

          let streamAssistantText = '';
          let streamErrored = false;
          const stream = session.sendMessageStream(message);
          for await (const event of stream) {
            await writeAndDrain(process.stdout, JSON.stringify(event, dateReplacer) + '\n');
            if (event.type === 'chunk' && event.chunk.type === 'content') {
              streamAssistantText += (event.chunk as { type: 'content'; content: string }).content;
            }
            if (event.type === 'done') {
              // Fold the turn into stats before persistence.
              recordTurn(stats, message, streamAssistantText, event.metadata);
              // Capture SDK session id from done metadata when available.
              if (event.metadata?.sessionId && !stats.sessionId) {
                stats.sessionId = String(event.metadata.sessionId);
              }
            }
            if (event.type === 'error') {
              process.exitCode = 1;
              streamErrored = true;
              break;
            }
          }

          await maybePublish(streamAssistantText, streamErrored);
          return;
        }

        // Send message
        const response = await session.sendMessage(message, {
          stream: options.stream,
        });

        spinner.succeed('Response received');

        // Fold the turn into stats (needed for persistence).
        const responseMeta = session.getLastResponseMetadata();
        recordTurn(stats, message, response.content, responseMeta ?? undefined);
        if (responseMeta?.sessionId && !stats.sessionId) {
          stats.sessionId = String(responseMeta.sessionId);
        }

        if (options.format === 'json') {
          // Surface per-turn cost/duration/token metadata in JSON output so
          // headless runners can do budget bookkeeping without parsing
          // human-readable lines or telemetry side-channels. Additive —
          // existing JSON consumers still see `success`/`model`/`message`/`timestamp`.
          // The metadata fields appear only when the provider populates them:
          // the bundled `anthropic-direct` provider surfaces tokens but not
          // cost/duration today, so consumers should treat all four new
          // fields as best-effort.
          const jsonInputTokens = responseMeta ? Number(responseMeta.usage?.['input_tokens'] ?? 0) : 0;
          const jsonOutputTokens = responseMeta ? Number(responseMeta.usage?.['output_tokens'] ?? 0) : 0;
          console.log(JSON.stringify({
            success: true,
            model: sessionModel,
            message: response.content,
            timestamp: response.timestamp,
            ...(responseMeta?.totalCostUsd !== undefined ? { costUsd: responseMeta.totalCostUsd } : {}),
            ...(responseMeta?.durationMs !== undefined ? { durationMs: responseMeta.durationMs } : {}),
            ...(jsonInputTokens > 0 ? { inputTokens: jsonInputTokens } : {}),
            ...(jsonOutputTokens > 0 ? { outputTokens: jsonOutputTokens } : {}),
          }, null, 2));
        } else {
          console.log(chalk.cyan('\n🤖 Claude:'));
          console.log(renderMarkdownToTerminal(response.content));
          // Turn summary
          if (responseMeta) {
            const chatParts: string[] = [];
            if (responseMeta.durationMs) chatParts.push(formatDuration(responseMeta.durationMs));
            if (responseMeta.totalCostUsd !== undefined) chatParts.push(formatCost(responseMeta.totalCostUsd));
            const chatInputTokens = Number(responseMeta.usage?.['input_tokens'] ?? 0);
            const chatOutputTokens = Number(responseMeta.usage?.['output_tokens'] ?? 0);
            if (chatInputTokens + chatOutputTokens > 0) chatParts.push(formatTokens(chatInputTokens + chatOutputTokens) + ' tokens');
            if (chatParts.length > 0) {
              console.log(chalk.dim('  · ' + chatParts.join(' · ')));
            }
          }
          console.log('');
        }

        await maybePublish(response.content, false);

      } catch (error) {
        encounteredError = true;
        // Headless NDJSON consumers see EOF without an error signal otherwise —
        // handleCommandError writes to stderr and process.exit()s synchronously,
        // so emit the typed error line on stdout BEFORE delegating.
        if (options.format === 'stream-json') {
          const e = error instanceof Error ? error : new Error(String(error));
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
        // Persist the session sidecar on graceful exit when a session flag was set.
        // Suppress on error — see encounteredError declaration above.
        if (shouldPersist && stats.totalTurns > 0 && !encounteredError) {
          try {
            const savedPath = saveSession(stats, persistId);
            // Derive the resume id from the saved path's basename.
            const savedId = savedPath.replace(/\.json$/, '').split('/').pop() ?? persistId ?? stats.sessionId ?? 'unknown';
            process.stderr.write(`Continue with: afk chat <msg> --resume ${savedId}\n`);
          } catch { /* best-effort — don't mask the main error */ }
        }
        if (session) {
          await session.close();
          // Best-effort run-receipt pointer on stderr (stdout stays pipe-clean
          // for piping/JSON consumers). The SessionEnd hook wrote the receipt
          // during close(); surface its path if the file is present.
          if (receiptTracePath !== undefined) {
            try {
              const { mdPath } = receiptPathsFor(receiptTracePath);
              if (existsSync(mdPath)) {
                process.stderr.write(`Receipt: ${mdPath}\n`);
              }
            } catch {
              /* best-effort — never mask the run's real outcome */
            }
          }
        }
        sharedMemoryStore?.close();
        // Worktree cleanup: session close must finish before
        // `git worktree remove --force` so any active SQLite WAL / trace
        // writer file handles on the worktree are flushed first.
        // `cleanup()` is best-effort and never throws.
        if (worktreeHandle !== undefined) {
          await worktreeHandle.cleanup();
        }
      }
    });
}
