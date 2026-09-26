/**
 * What-if episode gate — tree-wide PreToolUse hook for sandboxed episodes.
 *
 * When a process runs as a sandboxed what-if episode (`AFK_WHATIF_EPISODE=1`),
 * this gate intercepts every PreToolUse call and decides whether the tool
 * should execute or be RECORDED-but-not-executed:
 *
 *   - Verdict 'executed': read-only tools run normally (return `{}`).
 *   - Verdict 'recorded': the first side-effecting tool call is logged and
 *     blocked; all subsequent calls are also blocked (latch). The model is
 *     instructed to state what it was about to do and why, then end its turn.
 *
 * Applies tree-wide (no subagent exemption): episode isolation must hold
 * across every nested fork, not just the top-level session.
 *
 * Every PreToolUse call (regardless of verdict) is appended as a JSON line to
 * `AFK_WHATIF_TOOL_LOG` when that env var is set. Write errors are swallowed
 * so a full disk or unwritable path never disrupts tool execution.
 *
 * Modelling: the gate is a factory that returns a stable handler closure —
 * the same pattern as `createPlanModeGate` and `createAfkModeGate`. Module-
 * scope latch state is reset by `resetWhatifEpisodeGateForTests()` so Vitest
 * files never bleed state across tests.
 *
 * @module agent/whatif-episode-gate
 */

import { appendFileSync } from 'node:fs';
import { env } from '../config/env.js';
import type { HookContext, HookDecision } from './hooks.js';
import { categorizeTool } from './tool-category.js';
import { classifyBashCommand } from './tools/readonly-bash.js';

// ---------------------------------------------------------------------------
// Module-scope latch: once a 'recorded' verdict fires in this process, every
// subsequent call is also blocked (preventing a model from circumventing the
// sandbox by issuing a second side-effecting call).
// ---------------------------------------------------------------------------

let _latchedAfterFirstRecorded = false;

/**
 * Test-only: reset the per-process latch so Vitest files that exercise the
 * first-recorded latch path don't bleed state into each other.
 * Production never calls this.
 */
export function resetWhatifEpisodeGateForTests(): void {
  _latchedAfterFirstRecorded = false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true when this process is running as a sandboxed what-if episode.
 * Reads the env var at call time so toggle via env is reflected immediately
 * (useful in tests).
 */
export function isWhatifEpisode(): boolean {
  const v = env.AFK_WHATIF_EPISODE;
  return v === '1' || v === 'true';
}

/**
 * The reason message delivered when a tool is blocked by the episode gate.
 * Exported so tests can assert against the exact string without coupling
 * themselves to the implementation detail.
 */
export const EPISODE_BLOCK_REASON =
  'what-if sandbox: this action was recorded as your decision but NOT executed. ' +
  'Do not retry or work around it. In one or two sentences, state what you were ' +
  'about to do and why, then end your turn.';

// ---------------------------------------------------------------------------
// Allow-list logic
// ---------------------------------------------------------------------------

/**
 * Decide whether a tool call should be executed (allowed) in an episode.
 *
 * Read-only verdict: the call may proceed with no sandbox concern.
 * Write/mutating verdict: the call must be recorded-but-not-executed.
 */
function shouldExecute(toolName: string, input: unknown): boolean {
  // Read-category tools are always safe.
  if (categorizeTool(toolName) === 'read') return true;

  // Bash: allowed only when the classifier confirms it is non-mutating.
  if (toolName === 'bash') {
    const cmd =
      typeof input === 'object' && input !== null
        ? String((input as Record<string, unknown>)['command'] ?? '')
        : '';
    const verdict = classifyBashCommand(cmd);
    return !verdict.mutating;
  }

  // web_scrape is read-only by its own description (scrape/fetch, no mutation).
  if (toolName === 'web_scrape') return true;

  // web_request: allow only GET, HEAD, OPTIONS (or absent method, which defaults GET).
  if (toolName === 'web_request') {
    const method =
      typeof input === 'object' && input !== null
        ? String((input as Record<string, unknown>)['method'] ?? 'GET').toUpperCase()
        : 'GET';
    return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  }

  // get_runtime_state is purely in-memory, no side effects.
  if (toolName === 'get_runtime_state') return true;

  // Schedule read tools.
  if (toolName === 'list_schedules' || toolName === 'get_schedule_history') return true;

  // worktree 'list' is a dry-run sweep — no filesystem mutations.
  if (toolName === 'worktree') {
    const action =
      typeof input === 'object' && input !== null
        ? String((input as Record<string, unknown>)['action'] ?? '')
        : '';
    return action === 'list';
  }

  // test_run without coverage is read-only: spawns a runner, returns results,
  // no filesystem side-effects. With coverage=true it writes artifact files.
  if (toolName === 'test_run') {
    const hasCoverage =
      typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>)['coverage'] === true
        : false;
    return !hasCoverage;
  }

  // Everything else (writes, mutating delegation, messaging, MCP, browser,
  // unknown tools) is not safe to execute in the sandbox.
  return false;
}

// ---------------------------------------------------------------------------
// Log helper
// ---------------------------------------------------------------------------

type Verdict = 'executed' | 'recorded';

function appendToolLog(
  toolName: string,
  input: unknown,
  verdict: Verdict,
  isSubagent: boolean,
): void {
  const logPath = env.AFK_WHATIF_TOOL_LOG;
  if (!logPath) return;
  try {
    const line = JSON.stringify({
      ts: Date.now(),
      tool: toolName,
      input,
      verdict,
      subagent: isSubagent,
    });
    appendFileSync(logPath, line + '\n', 'utf-8');
  } catch {
    // Swallow: a full disk or unwritable log path must not disrupt tool execution.
  }
}

// ---------------------------------------------------------------------------
// Gate factory
// ---------------------------------------------------------------------------

/**
 * Create the what-if episode gate hook.
 *
 * The returned handler is a no-op unless `isWhatifEpisode()` is true at call
 * time, so it is safe to register unconditionally in `createDefaultHookRegistry`
 * (and the task spec requires it registered first).
 *
 * Tree-wide: unlike the plan-mode gate, this does NOT skip subagent contexts —
 * episode isolation must hold across every nested fork.
 */
export function createWhatifEpisodeGate(): (context: HookContext) => HookDecision {
  return function whatifEpisodeGate(context: HookContext): HookDecision {
    if (context.event !== 'PreToolUse') return {};
    if (!isWhatifEpisode()) return {};

    const { toolName, input } = context;
    const isSubagent = 'parentSessionId' in context && context.parentSessionId !== undefined;

    // If the latch fired in an earlier call this process, block everything.
    if (_latchedAfterFirstRecorded) {
      appendToolLog(toolName, input, 'recorded', isSubagent);
      return { decision: 'block', reason: EPISODE_BLOCK_REASON };
    }

    const exec = shouldExecute(toolName, input);

    if (exec) {
      appendToolLog(toolName, input, 'executed', isSubagent);
      return {};
    }

    // First recorded verdict — set the latch so all subsequent calls are blocked.
    _latchedAfterFirstRecorded = true;
    appendToolLog(toolName, input, 'recorded', isSubagent);
    return { decision: 'block', reason: EPISODE_BLOCK_REASON };
  };
}
