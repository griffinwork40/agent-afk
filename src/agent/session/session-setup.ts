/**
 * Constructor helpers for AgentSession.
 * @module agent/session/session-setup
 */

import type {
  AgentConfig,
  SessionIdentity,
  SessionMetadata,
} from '../types.js';

/**
 * Wire an optional external abort signal to an internal AbortController.
 * Forwards abort events (preserving reason) and attaches onAbort.
 */
export function wireAbortSignal(
  external: AbortSignal | undefined,
  internal: AbortController,
  onAbort: () => void,
): void {
  if (external) {
    if (external.aborted) {
      internal.abort(external.reason);
    } else {
      external.addEventListener(
        'abort',
        () => {
          if (!internal.signal.aborted) internal.abort(external.reason);
        },
        { once: true },
      );
    }
  }
  internal.signal.addEventListener('abort', onAbort, { once: true });
}

/**
 * Build initial session identity and metadata from config.
 * Metadata model is supplied separately (resolved by buildQueryOptions).
 */
export function buildInitialState(
  config: AgentConfig,
  resolvedModel: string,
): {
  sessionIdentity: SessionIdentity;
  metadata: SessionMetadata;
} {
  const permissionMode = config.permissionMode ?? 'default';
  const persistSession = config.persistSession ?? true;

  const sessionIdentity: SessionIdentity = {
    sessionId: config.sessionId,
    configuredSessionId: config.sessionId,
    resume: config.resume,
    resumeSessionAt: config.resumeSessionAt,
    continue: config.continue,
    forkSession: config.forkSession,
    persistSession,
  };

  const metadata: SessionMetadata = {
    sessionId: config.sessionId,
    model: resolvedModel,
    permissionMode,
  };

  return { sessionIdentity, metadata };
}
