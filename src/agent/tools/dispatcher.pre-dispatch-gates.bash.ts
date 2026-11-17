/**
 * Bash-command gates (steps 2b and 2b-bis) of the pre-dispatch gate chain.
 *
 * Extracted from `dispatcher.pre-dispatch-gates.ts` to stay under the
 * 350-code-line ceiling. Contains:
 *   - {@link checkReadOnlyBash} — the read-only-skill bash gate (2b).
 *   - {@link checkDestructiveGitBash} — the child-session destructive-git
 *     gate (2b-bis).
 *   - {@link bashCommandDenialReason} — runs both, in that order, and is the
 *     only entry point `runPreDispatchGates` calls.
 *
 * Contract: these functions are pure classifiers. They return the denial
 * REASON (or `undefined` to allow) and never emit telemetry; the caller in
 * `dispatcher.pre-dispatch-gates.ts` emits the PreToolUse `hook_decision`
 * block and builds the `permission-denied` {@link ToolResult} from that same
 * reason string, so the model-visible text and the trace event cannot drift.
 *
 * @module agent/tools/dispatcher.pre-dispatch-gates.bash
 */

import { classifyBashCommand } from './readonly-bash.js';
import { isCodeSymbolsMutation } from '../tool-category.js';
import { classifyDestructiveGit } from './readonly-bash.tokenizer.js';
import { isBackgroundBashLaunch } from './bash-background-flag.js';
import { isReadOnlyGitToolEnabled, READONLY_BASH_DISABLED_REASON } from './readonly-git-surface.js';
import type { PreDispatchGateDeps } from './dispatcher.pre-dispatch-gates.js';
import type { ToolCall, ToolResult } from '../providers/anthropic-direct/types.js';

/** The two dispatcher flags the bash-command gates read. */
export type BashGateFlags = Pick<PreDispatchGateDeps, 'readOnlyBash' | 'blockDestructiveGit'>;

/**
 * Child-session destructive-git gate. Returns the denial reason for an isError
 * {@link ToolResult} when `blockDestructiveGit` is true AND `call` is a `bash`
 * invocation whose command contains a working-tree-destructive git subcommand;
 * otherwise returns `undefined` (allow).
 *
 * Runs AFTER `checkReadOnlyBash` so read-only children that already block all
 * mutating bash never reach this gate.
 */
export function checkDestructiveGitBash(call: ToolCall, flags: BashGateFlags): string | undefined {
  if (!flags.blockDestructiveGit || call.name !== 'bash') return undefined;
  const input = call.input;
  const command =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)['command']
      : undefined;
  if (typeof command !== 'string') return undefined;
  const verdict = classifyDestructiveGit(command);
  if (!verdict.destructive) return undefined;
  return (
    `Bash command blocked: child sessions may not run working-tree-destructive ` +
    `git commands (${verdict.reason ?? 'destructive git command detected'}). ` +
    `If this command is genuinely needed, report the requirement to your caller.`
  );
}

/**
 * Read-only-skill bash gate. Returns the denial reason for an isError
 * {@link ToolResult} when the dispatcher is in `readOnlyBash` mode AND `call`
 * is a `bash` invocation whose command classifies as MUTATING; otherwise
 * returns `undefined` (allow).
 *
 * Invariant: this runs AFTER the permission check at both call sites
 * (`execute()` single-path and `executeBatch()` phase-1), mirroring a
 * PreToolUse gate but living in the dispatcher because — unlike the hook
 * registry — it needs the raw `call.input.command` string. The input shape
 * is guarded: a non-object input or missing/non-string `command` is treated
 * as a no-op pass-through (the handler will surface its own validation
 * error), so we never throw here.
 */
export function checkReadOnlyBash(call: ToolCall, flags: BashGateFlags): string | undefined {
  if (flags.readOnlyBash && isCodeSymbolsMutation(call.name, call.input)) {
    return 'code_symbols mutation blocked: read-only agents may not apply refactors.';
  }
  if (!flags.readOnlyBash || call.name !== 'bash') return undefined;
  const input = call.input;
  const command =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)['command']
      : undefined;
  // #3754 backstop: with AFK_READONLY_GIT_TOOL on, read-only surfaces get no
  // shell at all (the allowlist swap normally hides it; this covers any path
  // that reached the dispatcher with bash still admitted).
  if (isReadOnlyGitToolEnabled()) return READONLY_BASH_DISABLED_REASON;
  if (typeof command !== 'string') return undefined;
  // A background launch outlives the call and is never read-only recon,
  // whatever the command text says.
  if (isBackgroundBashLaunch(call.name, input)) {
    return (
      'Bash command blocked: read-only agents may not start background processes ' +
      '(run_in_background). Run read-only commands in the foreground instead.'
    );
  }
  const verdict = classifyBashCommand(command);
  if (!verdict.mutating) return undefined;
  // Reason text is shared by the model-visible result and the trace event so
  // the two can never drift; the command string itself is deliberately NOT
  // recorded (ADR 0001 §G.4 keeps raw commands out of telemetry).
  return (
    `Bash command blocked: read-only skill may not run mutating commands ` +
    `(${verdict.reason ?? 'mutation detected'}). Allowed: read-only recon ` +
    `(git status/log/diff/show/ls-remote, ls, cat, find, grep, gh pr view/diff). ` +
    `For a remote ref you have not fetched, \`gh pr diff <n>\`, \`gh pr view <n>\` ` +
    `and \`git ls-remote\` need no local ref — \`git fetch\` is blocked. ` +
    `Do NOT retry variants of a blocked command: if the task genuinely requires a ` +
    `mutation, stop and report that requirement to your caller instead.`
  );
}

/**
 * Bash-command gates 2b then 2b-bis, in that order: the read-only-skill gate
 * first, and the destructive-git gate only when the read-only gate allowed the
 * call. Returns the first denial reason, or `undefined` to proceed.
 */
export function bashCommandDenialReason(call: ToolCall, flags: BashGateFlags): string | undefined {
  return checkReadOnlyBash(call, flags) ?? checkDestructiveGitBash(call, flags);
}
