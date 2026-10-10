/**
 * SDK opt-in executor bundle (#3442).
 *
 * A {@link SessionExecutors} value carries the three tool executors that make
 * the `agent`, `skill`, and `compose` tools available to a session, plus the
 * two lifecycle seams the owning `AgentSession` drives: `bind` (exactly once,
 * from the constructor) and `drain` (from session shutdown).
 *
 * Contract: this module is type-only at its edges (every import is
 * `import type`) so it can be referenced from `config-types.ts`, the provider
 * router, and the session without introducing a runtime import cycle.
 *
 * @module agent/session/session-executors
 */

import type { SubagentExecutor } from '../tools/subagent-executor.js';
import type { SkillExecutor } from '../tools/skill-executor.js';
import type { ComposeExecutor } from '../tools/compose-executor.js';
import type { HookRegistry } from '../hooks.js';
import type { MessageJournal } from '../journal/index.js';
import type { InputStreamRef } from '../types/permission-types.js';

/**
 * The minimal session view an executor bundle needs to fork children from
 * its owning session. Structurally satisfied by `AgentSession`.
 *
 * Invariant: `bind` runs inside the `AgentSession` constructor BEFORE the
 * provider lifecycle exists, so implementations must store the target and
 * read its members lazily (at execute time), never during `bind` itself:
 * `sessionId` is not readable until the provider lifecycle is built.
 */
export interface SessionExecutorsBindTarget {
  readonly sessionId: string | undefined;
  readonly abortSignal: AbortSignal;
  readonly hookRegistry: HookRegistry | undefined;
  readonly messageJournal: MessageJournal | undefined;
  getInputStreamRef(): Pick<InputStreamRef, 'pushUserMessage' | 'queueFrameworkContext'>;
  recordSubagentCompletion(
    usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number },
    costUsd?: number,
  ): void;
}

/**
 * Executor bundle a caller opts into via `AgentConfig.executors`.
 *
 * Each defined executor is spread into every provider the session builds
 * (including providers rebuilt by a cross-family model swap), which is what
 * exposes the `agent` / `skill` / `compose` tool schemas to the model.
 */
export interface SessionExecutors {
  readonly subagentExecutor?: SubagentExecutor;
  readonly skillExecutor?: SkillExecutor;
  readonly composeExecutor?: ComposeExecutor;
  /** Called exactly once by the AgentSession constructor; a second call MUST throw. */
  bind(session: SessionExecutorsBindTarget): void;
  /**
   * Abort + drain all children; idempotent. Receives the session lifecycle
   * reason (`'close'`, `'reset'`, ...). On `'reset'` (`/clear`) the session
   * keeps living, so implementations should re-arm rather than latch closed.
   */
  drain(reason: string): Promise<unknown>;
}

/** The provider-constructor slice of a {@link SessionExecutors} bundle. */
export type ProviderExecutorOpts = Pick<SessionExecutors, 'subagentExecutor' | 'skillExecutor' | 'composeExecutor'>;

/**
 * Project the defined executors of a bundle into a provider-options bag.
 * Undefined members are omitted (never spread as `undefined`) so provider
 * schema gates (`if (opts.subagentExecutor)`) stay exact.
 */
export function providerExecutorOpts(executors: ProviderExecutorOpts | undefined): ProviderExecutorOpts {
  if (executors === undefined) return {};
  return {
    ...(executors.subagentExecutor !== undefined ? { subagentExecutor: executors.subagentExecutor } : {}),
    ...(executors.skillExecutor !== undefined ? { skillExecutor: executors.skillExecutor } : {}),
    ...(executors.composeExecutor !== undefined ? { composeExecutor: executors.composeExecutor } : {}),
  };
}

/**
 * Build-once slot for implementers of {@link SessionExecutors.bind}. `bind`
 * stores the target; a second `bind` throws, enforcing one bundle per session.
 */
export function createSessionBindSlot(): {
  bind(session: SessionExecutorsBindTarget): void;
  get(): SessionExecutorsBindTarget | undefined;
} {
  let bound: SessionExecutorsBindTarget | undefined;
  return {
    bind(session) {
      if (bound !== undefined) {
        throw new Error(
          'SessionExecutors.bind: this executor bundle is already bound to a session; ' +
            'build a fresh bundle (createWiredExecutors) per AgentSession.',
        );
      }
      bound = session;
    },
    get: () => bound,
  };
}
