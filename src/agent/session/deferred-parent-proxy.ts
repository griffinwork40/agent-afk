/**
 * Builds a {@link SubagentExecutorContext.parentSession} proxy whose fields
 * resolve lazily from a session reference that is populated AFTER the proxy
 * is constructed.
 *
 * This pattern arises whenever executors (which need a `parentSession` at
 * construction time) must be wired BEFORE the `AgentSession` they will belong
 * to is created — the standard bootstrap order across the Telegram, web, CLI,
 * and daemon surfaces.
 *
 * Usage:
 * ```ts
 * const { proxy, bind } = makeDeferredParentProxy();
 * const executors = wireExecutors({ parentSession: proxy, … });
 * const session  = new AgentSession(config);
 * bind(session);   // proxy now resolves through `session`
 * ```
 *
 * Until `bind` is called every getter returns the same stub value it would
 * return for `undefined` — `sessionId` → `undefined`, `abortSignal` → a fresh
 * controller's signal, `hookRegistry` → `undefined`, `messageJournal` →
 * `undefined`, and `getInputStreamRef()` → a no-op push channel.
 */

import type { AgentSession } from './agent-session.js';
import type { SubagentExecutorContext } from '../tools/subagent-executor.js';

export interface DeferredParentProxy {
  /** The proxy object to pass as `parentSession` to `wireExecutors`. */
  proxy: SubagentExecutorContext['parentSession'];
  /**
   * Call once after `new AgentSession(config)` to resolve the proxy.
   * Subsequent reads of any getter return the live session's value.
   */
  bind: (session: AgentSession) => void;
}

/**
 * Create a deferred parent-session proxy.
 *
 * Both the proxy and the bind function close over the same `boundSession`
 * variable; calling `bind` is the only way to populate it.
 */
export function makeDeferredParentProxy(): DeferredParentProxy {
  let boundSession: AgentSession | undefined;

  const proxy: SubagentExecutorContext['parentSession'] = {
    get sessionId() { return boundSession?.sessionId; },
    getInputStreamRef() {
      return boundSession?.getInputStreamRef?.() ?? { pushUserMessage: () => {} };
    },
    get abortSignal() {
      return boundSession?.abortSignal ?? new AbortController().signal;
    },
    get hookRegistry() { return boundSession?.hookRegistry; },
    // Journal parent view: forks journal to `messageJournal.forSubagent(id)`,
    // never to the parent's own file (see fork-child-config.ts).
    get messageJournal() { return boundSession?.messageJournal; },
  };

  const bind = (session: AgentSession): void => {
    boundSession = session;
  };

  return { proxy, bind };
}
