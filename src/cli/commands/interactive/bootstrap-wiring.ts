import * as readline from 'node:readline';
import { elicitationRouter } from '../../../agent/elicitation-router.js';
import { makeReplElicitationHandler } from '../../elicitation-repl.js';
import type { ModelProvider } from '../../../agent/provider.js';
import { setAllowDirDispatcher } from '../../slash/commands/allow-dir.js';
import { seedPersistedGrants } from '../../../agent/permissions-store.js';
import { isGrantManager } from '../../shared-helpers.js';
import { env } from '../../../config/env.js';
import type { CompletionWriter } from './shared.js';
import { TrustedSkillLedger } from '../../trusted-skill-ledger.js';
import {
  onTrustedSkillComplete, offTrustedSkillComplete,
  onTrustedSkillStart, offTrustedSkillStart,
} from '../../../agent/_lib/trusted-skill-events.js';
import { formatTrustedSkillCompletion, formatTrustedSkillInFlight } from '../../trusted-skill-badge.js';
import type { TrustedSkillResult } from '../../../agent/trusted-skill-result.js';
import type { InputSurface } from '../../input/input-surface.js';
import { getTerminalWidth } from '../../terminal-size.js';

/**
 * Subscribe to trusted-skill start/completion events, emitting in-flight +
 * completion badges inline at the invocation point via `completionWriter`
 * (routed to `compositor.commitAbove` during a live turn; falls back to
 * `console.log` outside a turn). Completions are recorded in `ledger`. Each
 * event is its own scrollback line, so overlapping skills no longer need
 * Set-based tracking the way the status-line approach did.
 *
 * @returns a teardown function — assign it to `ctx.teardownTrustedSkillEvents`.
 */
export function wireTrustedSkillEvents(
  completionWriter: CompletionWriter,
  ledger: TrustedSkillLedger,
): () => void {
  const onStart = (skillName: string) => {
    completionWriter.fn(
      formatTrustedSkillInFlight(skillName, {
        isTTY: process.stdout.isTTY,
        columns: getTerminalWidth(),
      }),
    );
  };

  const onComplete = (result: TrustedSkillResult) => {
    completionWriter.fn(
      formatTrustedSkillCompletion(result, {
        isTTY: process.stdout.isTTY,
        columns: getTerminalWidth(),
      }),
    );
    ledger.record(result);
  };

  onTrustedSkillStart(onStart);
  onTrustedSkillComplete(onComplete);

  return () => {
    offTrustedSkillStart(onStart);
    offTrustedSkillComplete(onComplete);
  };
}

/**
 * Wire `/allow-dir` to the startup provider's grant API so the slash command
 * can mutate read/write roots across turns.
 *
 * Invariant: `startupProvider` MUST be the same instance the ProviderRouter
 * uses to run queries, or grants land on a dead instance and are silently
 * dropped. The per-family memoization in `bootstrap-providers.ts`'s
 * `providerFactory` guarantees this — the router's `buildInner` calls the
 * same factory with a same-family model and gets the cached instance back.
 * Do not remove that cache without rewiring this dispatcher to the router's
 * active inner.
 *
 * We wire once here and do not rewire on `/model` swaps: directory grants
 * are a session-level concept (not per-model), and a Claude→GPT→Claude swap
 * reuses the cached instance with its grants intact. The duck-type guard
 * (`isGrantManager`) covers both AnthropicDirectProvider and
 * OpenAICompatibleProvider — and any future provider that exposes the
 * GrantManager surface — without naming each.
 *
 * Call AFTER `registerAll()` (ordering hazard #12).
 *
 * The former `pathApprovalGrantRef` parameter has been retired (#528): the
 * path-approval and bash-restriction hooks now read the grant manager
 * exclusively from `context.grantManager` (injected per-session by the
 * dispatcher since #527), so there is no process-global ref to populate.
 */
export function wireProviderGrants(
  startupProvider: ModelProvider,
): void {
  if (isGrantManager(startupProvider)) {
    setAllowDirDispatcher(startupProvider);
    // Seed read/write roots from persisted `persist` grants so the prompt's
    // "future sessions inherit it" promise actually holds. No-op when none.
    seedPersistedGrants(startupProvider);
  } else if (env.AFK_DISABLE_PATH_APPROVAL !== '1') {
    // Emit a one-time advisory when path-approval is enabled but the active
    // provider does not expose the GrantManager API. This makes fail-open
    // explicit rather than silent — the bash interpreter denylist still fires,
    // but the elicitation prompt and bash restricted-path check will not.
    // eslint-disable-next-line no-console
    console.warn(
      '[path-approval] active provider does not implement GrantManager — ' +
        'path-approval elicitation and bash restricted-path checks will not fire.',
    );
  }
}

/**
 * Create the REPL's non-terminal readline interface and install the REPL
 * elicitation handler so `ask_question` calls from the agent are routed to
 * the interactive readline surface.
 *
 * Returns the late-bound `inputSurfaceRef` too — populated by `runReplLoop`
 * after `armCompositor`. The elicitation handler closes over this ref so
 * suspend/resume works at invocation time even though the surface isn't
 * armed yet at install time.
 */
export function createReplInput(): {
  rl: readline.Interface;
  inputSurfaceRef: { current: InputSurface | null };
} {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  // Late-bound InputSurface ref — populated by runReplLoop after armCompositor.
  // The elicitation handler closes over this so suspend/resume works at
  // invocation time even though the surface isn't armed yet at install time.
  const inputSurfaceRef: { current: InputSurface | null } = { current: null };

  // Install the REPL elicitation handler so ask_question calls from the
  // agent are routed to the interactive readline surface.
  elicitationRouter.install(makeReplElicitationHandler({
    readLine: (prompt) => new Promise((resolve, reject) => {
      rl.question(prompt, resolve);
      rl.once('close', () => reject(new Error('readline closed')));
    }),
    writer: { line: (text = '') => process.stdout.write(text + '\n') },
    pendingCount: () => elicitationRouter.pendingCount(),
    suspendInput: () => inputSurfaceRef.current?.suspendForElicitation(),
    resumeInput: () => inputSurfaceRef.current?.resumeAfterElicitation(),
  }));

  return { rl, inputSurfaceRef };
}
