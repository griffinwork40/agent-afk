/**
 * {@link AgentRunner} implementation that drives real `afk chat` subprocess
 * episodes for the what-if prediction engine.
 *
 * Two public operations:
 *   - `run()` — executes a full episode and returns an {@link EpisodeTrace}.
 *   - `snapshot()` — intercepts the first model request via a local HTTP shim
 *     and returns a {@link RequestSnapshot} without a real model API call.
 *
 * CLI entry resolution: spawn `process.execPath` with
 * `[...process.execArgv, process.argv[1], 'chat', ...]` so it works both from
 * the built binary (dist/cli.mjs) and from tsx dev. Override via `opts.cliEntry`.
 *
 * ANTHROPIC_BASE_URL finding: the Anthropic SDK reads `ANTHROPIC_BASE_URL` from
 * the child process env when no explicit `baseURL` is passed to its constructor
 * (SDK client.ts:300). The AFK provider uses `config.baseUrl` (sourced from
 * `AFK_LOCAL_BASE_URL`) for an explicit `baseURL` — when that var is absent,
 * `buildClientOptions` passes no `baseURL`, so the SDK falls back to its own
 * readEnv call for ANTHROPIC_BASE_URL. Setting that var in the child env
 * therefore redirects all Anthropic traffic to our capture server without
 * touching provider code.
 *
 * @module whatif/runner/afk-runner
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { AgentRunner, Environment, Episode, RunnerOptions, EpisodeTrace, RequestSnapshot } from '../types.js';
import { buildChildEnv } from './child-env.js';
import { readToolLog } from './tool-log.js';
import { startCaptureServer } from './capture-server.js';
import { runEpisodeChild } from './afk-runner.run.js';
import { buildSnapshotFromRequests } from './afk-runner.snapshot.js';



// ---------------------------------------------------------------------------
// CLI entry resolution
// ---------------------------------------------------------------------------

export interface AfkRunnerOptions {
  /** Override the CLI entry point for tests. */
  cliEntry?: { command: string; args: string[] };
  /** Override the spawn implementation for tests. */
  spawnImpl?: typeof nodeSpawn;
}

/** Build the default CLI entry: process.execPath + execArgv + argv[1] + 'chat'. */
function defaultCliEntry(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [...process.execArgv, process.argv[1] ?? 'afk', 'chat'],
  };
}

// ---------------------------------------------------------------------------
// Prompt safety
// ---------------------------------------------------------------------------

/**
 * Ensure a prompt starting with '-' is not misinterpreted as a flag by
 * Commander. Commander positional args after '--' are literal, but chat.ts
 * reads its arg as `rawMessage`. We prefix a zero-width space to be safe when
 * the prompt starts with '-'; the agent still receives the original text
 * because the leading char is stripped server-side. Actually the safest
 * approach is to just pass the prompt directly — Commander distinguishes
 * positional args from options once '--' appears, but since we don't use '--'
 * (commander chat doesn't need it), we detect the edge case and prefix a
 * harmless U+200B that is invisible to the model.
 *
 * The alternative (stdin) would require detecting stdin support in chat.ts
 * which it does support (pipe detection) — but spawning with stdin piped is
 * simpler here only for '-'-prefixed prompts.
 */
function safePromptArg(prompt: string): string {
  return prompt.startsWith('-') ? `\u200B${prompt}` : prompt;
}

// ---------------------------------------------------------------------------
// Shared arg builder
// ---------------------------------------------------------------------------

function buildChatArgs(
  entry: { command: string; args: string[] },
  prompt: string,
  maxTurns: number,
  launch: Environment['launch'],
  extra: string[],
): { command: string; spawnArgs: string[] } {
  const chatArgs = [
    '--format', 'json',
    '--max-turns', String(maxTurns),
    ...(launch.model ? ['--model', launch.model] : []),
    ...(launch.effort ? ['--effort', launch.effort] : []),
    ...extra,
    safePromptArg(prompt),
  ];
  return { command: entry.command, spawnArgs: [...entry.args, ...chatArgs] };
}

// ---------------------------------------------------------------------------
// Runner factory
// ---------------------------------------------------------------------------

/**
 * Create the AFK agent runner.
 *
 * @param opts - Optional overrides for CLI entry and spawn implementation.
 */
export function createAfkRunner(opts?: AfkRunnerOptions): AgentRunner {
  const getEntry = (): { command: string; args: string[] } =>
    opts?.cliEntry ?? defaultCliEntry();
  const spawnImpl = opts?.spawnImpl ?? nodeSpawn;

  const run = async (
    env: Environment,
    episode: Episode,
    sample: number,
    runnerOpts: RunnerOptions,
  ): Promise<EpisodeTrace> => {
    const toolLogPath = `${env.home}/state/whatif-tools-${episode.id}-${sample}-${randomBytes(4).toString('hex')}.jsonl`;
    const childEnv = buildChildEnv(env, { AFK_WHATIF_TOOL_LOG: toolLogPath });

    const entry = getEntry();
    const { command, spawnArgs } = buildChatArgs(
      entry,
      episode.prompt,
      runnerOpts.maxTurns,
      env.launch,
      [],
    );

    const spawnOptions: SpawnOptions = {
      cwd: env.cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    const trace = await runEpisodeChild({
      command,
      spawnArgs,
      spawnOptions,
      spawnImpl,
      episodeId: episode.id,
      envLabel: env.label,
      sample,
      timeoutMs: runnerOpts.timeoutMs,
      signal: runnerOpts.signal,
    });

    // Read and attach tool log, then delete it.
    let tools = trace.tools;
    try {
      tools = await readToolLog(toolLogPath);
    } catch { /* tolerate read failures — tools stays as-is */ }
    try { await rm(toolLogPath, { force: true }); } catch { /* best-effort */ }

    return { ...trace, tools };
  };

  const snapshot = async (
    env: Environment,
    probePrompt: string,
    runnerOpts: RunnerOptions,
  ): Promise<RequestSnapshot> => {
    const server = await startCaptureServer();
    const baseUrl = `http://127.0.0.1:${server.port}`;

    // Remove AFK_LOCAL_BASE_URL so config.baseUrl stays empty in the child —
    // that way the SDK reads ANTHROPIC_BASE_URL from env and hits our server.
    const childEnv = buildChildEnv(env, {
      ANTHROPIC_BASE_URL: baseUrl,
      AFK_LOCAL_BASE_URL: '',
    });
    // A blank AFK_LOCAL_BASE_URL won't suppress the SDK default (the SDK
    // ignores empty baseURL — it falls back to https://api.anthropic.com).
    // We need to fully delete it from the child env.
    delete childEnv['AFK_LOCAL_BASE_URL'];

    const entry = getEntry();
    const { command, spawnArgs } = buildChatArgs(
      entry,
      probePrompt,
      1,
      env.launch,
      [],
    );

    const spawnOptions: SpawnOptions = {
      cwd: env.cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    let stderrTail = '';
    try {
      const result = await runEpisodeChild({
        command,
        spawnArgs,
        spawnOptions,
        spawnImpl,
        episodeId: 'snapshot',
        envLabel: env.label,
        sample: 0,
        timeoutMs: runnerOpts.timeoutMs,
        signal: runnerOpts.signal,
      });
      stderrTail = result.error ?? '';
    } catch { /* we only care about captured requests */ }

    await server.close();

    return buildSnapshotFromRequests(server.requests, stderrTail);
  };

  return { name: 'afk', run, snapshot };
}
